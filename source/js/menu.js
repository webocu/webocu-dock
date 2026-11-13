/* =========================================================================
   The Settings window: rendering, focus and remote navigation.
   Layout: an icon rail (the sections) plus a list of rows, in a window in the
   middle of the screen. It is opened from the button at the foot of the dock
   and hands the screen back to the dock when it closes.

   Back walks one level up:  option list → submenu (as many as are open, one per
   press) → rows → rail → back to the dock. The menu key leaves the app.
   A slider is picked up with OK before the arrows reach into it: it then takes
   ◀ ▶ for its value. OK or Back puts the row down again.
   The list scrolls with the focus, with a wheel, and with ▲ ▼ on the levels that
   have nothing to focus (About).
   ========================================================================= */
window.Menu = (function () {
  var elMenu = document.getElementById('menu');
  var elRail = document.getElementById('rail');
  var elRailHead = document.getElementById('railHead');
  var elRailItems = document.getElementById('railItems');
  var elRows = document.getElementById('rows');
  var elTitle = document.getElementById('paneTitle');
  var elSub = document.getElementById('paneSub');
  var elHint = document.getElementById('paneHint');
  var elToast = document.getElementById('toast');

  var S = window.Settings;
  var t = window.I18N.t;

  var isOpen = false;
  var sectionIndex = 0;
  var column = 'rail';         // 'rail' | 'rows'
  var navIndex = 0;
  var editing = false;         // slider edit mode
  var expandedId = null;       // id of the expanded select
  /* The submenus that are open, outermost first: each entry is the level itself
     and the id of the row that opened it, which is what ◀ and Back walk back
     down. A stack and not a single slot because a level can be opened from a
     level (Tweaks -> Switch app ID, Tweaks -> Keep Alive), and nothing stops a
     submenu from having submenus of its own. */
  var subStack = [];

  var scrollEl = null;
  var barEl = null;
  var scrollY = 0;
  var nav = [];                // focusable entries of the current section
  var idleTimer = null;
  var toastTimer = null;
  var barTimer = null;

  var IDLE_MS = 0;             // 0 disables auto hide; the window stays open
  /* How long the scrollbar stays up after the list stopped moving. Long enough
     to be looked at once the thumb has settled, short enough that a level nobody
     is scrolling any more is a clean list again. */
  var BAR_MS = 3000;

  /* --------------------------------------------------------------- rail --- */
  /* Class of every rail item without the focus state, kept because paintRail()
     rewrites className: a pinned section would lose its modifier otherwise. */
  var railBase = [];
  /* Which section each icon stands for: a section marked `hidden` is not drawn,
     so the nth icon is not necessarily the nth section. Everything that walks the
     rail walks this list; `sectionIndex` stays a place in Settings.sections. */
  var railIndex = [];

  function buildRail() {
    var html = '';
    railBase = [];
    railIndex = [];
    /* The open section cannot be one the rail does not carry: it would leave the
       icons with nothing highlighted. */
    if (S.sections[sectionIndex] && S.sections[sectionIndex].hidden) {
      sectionIndex = firstVisible();
    }
    for (var i = 0; i < S.sections.length; i++) {
      var section = S.sections[i];
      if (section.hidden) continue;
      /* A pinned section sits at the foot of the rail, apart from the rest. */
      var base = 'rail__item' + (section.pinBottom ? ' rail__item--bottom' : '');
      railBase.push(base);
      railIndex.push(i);
      html += '<div class="' + base + '" role="tab" data-section="' + i + '">' +
                '<span class="rail__icon">' + section.icon + '</span>' +
                '<span class="rail__label">' + t(section.shortKey) + '</span>' +
              '</div>';
    }
    elRailItems.innerHTML = html;
    /* The band above the icons carries the same sliders the dock's button does:
       the window says what it is without a word that would need translating
       into 104px. */
    if (elRailHead) elRailHead.innerHTML = S.icon('app');
  }

  /* There is always one: the pinned section is never hidden. */
  function firstVisible() {
    for (var i = 0; i < S.sections.length; i++) {
      if (!S.sections[i].hidden) return i;
    }
    return 0;
  }

  function paintRail() {
    var items = elRailItems.children;
    for (var i = 0; i < items.length; i++) {
      var active = (railIndex[i] === sectionIndex);
      items[i].className = railBase[i] +
        (active ? ' is-active' : '') +
        (active && column === 'rail' ? ' is-focused' : '');
    }
  }

  /* --------------------------------------------------------------- rows --- */
  /* The innermost open submenu, or null when the rows are a section's own. */
  function subTop() {
    return subStack.length ? subStack[subStack.length - 1] : null;
  }

  /* Which level the rows show: the deepest open submenu, or the section from
     the rail. */
  function level() {
    var top = subTop();
    return top ? top.level : S.sections[sectionIndex];
  }

  /* Right-hand text of an action or submenu row (device state, for example). */
  function statusSpan(item) {
    var text = typeof item.status === 'function' ? item.status() : (item.status || '');
    if (!text) return '';
    return '<span class="row__value' + (item.statusOn ? ' row__value--on' : '') + '">' + text + '</span>';
  }

  /* A colour option carries its own colour (Settings.ACCENTS -> swatch), so the
     row and the list show the dot next to the name: "Orchid" on its own says
     nothing across the room. The colours come from our own table, never from
     the TV, so they go into the style attribute as they are. */
  function swatch(color) {
    return color ? '<span class="swatch" style="background:' + color + '"></span>' : '';
  }

  function valueSwatch(item) {
    if (!item.options) return '';
    for (var i = 0; i < item.options.length; i++) {
      if (item.options[i].value === S.value(item.id)) return swatch(item.options[i].swatch);
    }
    return '';
  }

  /* Class of a row without its focus state, kept for the same reason railBase is:
     paintFocus() rewrites className, so a modifier only render() knew about would
     be gone at the first repaint. */
  function rowClass(item) {
    var name = 'row row--' + item.type;
    /* A reorder row whose switch is off is dimmed: it is still in the list, to be
       moved and switched back on, but plainly the odd one out. */
    if (item.type === 'reorder' && item.on && !item.on()) name += ' row--off';
    return name;
  }

  function rowInner(item) {
    var label = '<span class="row__label">' + S.label(item) + '</span>';
    switch (item.type) {
      case 'toggle':
        return label + '<span class="toggle' + (S.value(item.id) ? ' is-on' : '') + '"></span>';
      /* No number next to the label: the filled part of the track is the whole
         readout. A percentage told nobody anything the picture behind the panel
         does not show better, and it was the only thing on screen that had to be
         repainted on every step of the knob. */
      case 'slider':
        return '<span class="row__top">' + label + '</span>' +
               '<span class="slider"><span class="slider__fill"></span><span class="slider__knob"></span></span>';
      /* The chevron means one thing only: this row leads to another level. A
         select opens its options in place and an action runs where it stands,
         so neither of them carries one — the current value is the affordance. */
      case 'select':
        return label + '<span class="row__value">' + valueSwatch(item) + S.formatValue(item) + '</span>';
      case 'action':
        return label + statusSpan(item);
      case 'submenu':
        return label + statusSpan(item) + '<span class="row__chev">›</span>';
      /* Two answers about one app: whether the dock shows it (the switch), and
         where it sits (the row's own place). The arrows say the row itself moves;
         the accent ring of the editing state says it is moving now. */
      case 'reorder':
        return label +
               '<span class="toggle' + (item.on && item.on() ? ' is-on' : '') + '"></span>' +
               '<span class="row__grab">↕</span>';
      default:
        return label;
    }
  }

  function render() {
    var section = level();
    elTitle.textContent = t(section.titleKey);
    elSub.textContent = t(section.subKey);

    var html = '<div class="rows__scroll">';
    for (var i = 0; i < section.items.length; i++) {
      var item = section.items[i];

      if (item.type === 'group') {
        html += '<div class="group">' + S.label(item) + '</div>';
        continue;
      }
      if (item.type === 'info') {
        html += '<div class="info" data-id="' + item.id + '">' + item.render() + '</div>';
        continue;
      }

      html += '<div class="' + rowClass(item) + '" data-id="' + item.id + '">' + rowInner(item) + '</div>';

      if (item.type === 'select' && expandedId === item.id) html += optionsHtml(item);
    }
    /* The bar is part of the same write: .rows is emptied on every render, and a
       node appended to it once would go with the rows it was meant to measure. */
    html += '</div><div class="rows__bar"><span class="rows__thumb"></span></div>';
    elRows.innerHTML = html;

    scrollEl = elRows.firstChild;
    barEl = elRows.lastChild;
    resetScroll();

    buildNav();
    paintSliders();
    paintFocus();
  }

  /* The list under an expanded select, written the same way for render() and for
     setOptions(). */
  function optionsHtml(item) {
    var html = '<div class="options" data-for="' + item.id + '">';
    for (var j = 0; j < item.options.length; j++) {
      var option = item.options[j];
      var selected = (option.value === S.value(item.id));
      html += '<div class="option' + (selected ? ' is-selected' : '') + '" ' +
                   'data-id="' + item.id + '" data-value="' + option.value + '">' +
                '<span>' + swatch(option.swatch) + S.optionLabel(option) + '</span>' +
                '<span class="option__check">✓</span>' +
              '</div>';
    }
    return html + '</div>';
  }

  function rowNode(id) {
    var rows = scrollEl.querySelectorAll('.row');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-id') === id) return rows[i];
    }
    return null;
  }

  /* Opens the list of select `id` under its row, or closes the open one (null),
     in place. A full render() is the wrong tool for this: it writes the whole
     level again and puts the scroll back to the top (a fresh level is not a
     scroll), and the focus then brings only the ROW into view, so the options
     that were just added stand below the edge until ▼ is pressed. Here the rest
     of the level stays where it is, and the caller shows the list with
     revealOptions(). The row of the select that was open is written again as
     well: closing by picking an option has changed the value it shows. */
  function setOptions(id) {
    var old = scrollEl.querySelector('.options');
    var was = old ? old.getAttribute('data-for') : null;
    if (old) old.parentNode.removeChild(old);
    expandedId = id;
    if (was) {
      var wasRow = rowNode(was);
      if (wasRow) wasRow.innerHTML = rowInner(S.item(was));
    }
    if (id) {
      var row = rowNode(id);
      if (row) {
        var holder = document.createElement('div');
        holder.innerHTML = optionsHtml(S.item(id));
        row.parentNode.insertBefore(holder.firstChild, row.nextSibling);
      }
    }
    buildNav();
    /* The level got shorter or longer: the offset may be past the new end. */
    setScroll(scrollY);
  }

  /* Brings a row and the list under it into view. A list that fits the window
     comes in whole, moved as little as it takes; one that does not (twelve
     languages) puts its row at the top, so the first options are on screen under
     it. Measured, not "scroll down by a position or two": the number of options
     differs from select to select, and so does the room above and below. */
  function revealOptions(id) {
    var row = rowNode(id);
    var box = scrollEl.querySelector('.options[data-for="' + id + '"]');
    if (!row || !box) return;
    var view = elRows.clientHeight;
    var top = row.offsetTop;
    var bottom = box.offsetTop + box.offsetHeight;
    var y = scrollY;
    if (bottom - top + 24 <= view) {
      if (top < y) y = top - 12;
      else if (bottom > y + view) y = bottom - view + 12;
    } else {
      y = top - 12;
    }
    setScroll(y);
  }

  /* Flat list of everything focusable: rows plus expanded options. */
  function buildNav() {
    nav = [];
    var nodes = scrollEl.querySelectorAll('.row, .option');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var item = S.item(node.getAttribute('data-id'));
      if (node.className.indexOf('option') === 0) {
        nav.push({ kind: 'option', el: node, item: item, value: node.getAttribute('data-value'), base: 'option' });
      } else {
        nav.push({ kind: 'row', el: node, item: item, base: rowClass(item) });
      }
    }
    if (navIndex >= nav.length) navIndex = Math.max(0, nav.length - 1);
  }

  /* One press of ◀ ▶: the value plus or minus one step, inside the range. */
  function sliderNext(item, current, direction) {
    return Math.max(item.min, Math.min(item.max, current + direction * item.step));
  }

  /* Where a click on the track lands: the nearest stop of the item. The stops
     are counted from its minimum, the way ◀ ▶ walk them — for the panel width
     20% + 7.5% is a stop while a plain multiple of 7.5 (22.5%) is not. */
  function sliderAt(item, ratio) {
    var raw = item.min + ratio * (item.max - item.min);
    var stop = item.min + Math.round((raw - item.min) / item.step) * item.step;
    return Math.max(item.min, Math.min(item.max, stop));
  }

  function paintSliders() {
    var rows = scrollEl.querySelectorAll('.row--slider');
    for (var i = 0; i < rows.length; i++) {
      var item = S.item(rows[i].getAttribute('data-id'));
      var ratio = (S.value(item.id) - item.min) / (item.max - item.min);
      ratio = Math.max(0, Math.min(1, ratio));
      rows[i].querySelector('.slider__fill').style.width = (ratio * 100).toFixed(2) + '%';
      rows[i].querySelector('.slider__knob').style.left = (ratio * 100).toFixed(2) + '%';
    }
  }

  function paintFocus() {
    for (var i = 0; i < nav.length; i++) {
      var entry = nav[i];
      var base = entry.base +
        (entry.kind === 'option' && entry.value === S.value(entry.item.id) ? ' is-selected' : '');
      var focused = (column === 'rows' && i === navIndex);
      entry.el.className = base +
        (focused ? ' is-focused' : '') +
        (focused && editing ? ' is-editing' : '');
    }
    if (column === 'rows' && nav[navIndex]) ensureVisible(nav[navIndex].el);
    paintHint();
    paintRail();
  }

  /* Footer shows the focused item's own hint, otherwise navigation help.
     One line only: the item hint replaces the help instead of joining it. */
  function paintHint() {
    var parts = [];
    var entry = nav[navIndex];
    var itemHint = (column === 'rows' && entry) ? S.hint(entry.item) : '';
    /* Picked up, the row's own hint is out of date: it describes what the setting
       is or how to take the row, and the question now is what the arrows do while
       it is held. */
    if (editing && column === 'rows' && entry) {
      if (entry.item.type === 'slider') itemHint = t('hint.editValue');
      if (entry.item.type === 'reorder') itemHint = t('hint.moveApp');
    }

    if (itemHint) {
      elHint.textContent = itemHint;
      return;
    }

    if (column === 'rail') {
      parts.push(t('hint.openSection'));
    } else if (!nav.length) {
      parts.push(t('hint.scroll'));
    } else if (editing) {
      parts.push(t('hint.editValue'));
    } else if (expandedId) {
      parts.push(t('hint.pickOption'));
    } else {
      parts.push(t('hint.changeValue'));
    }
    parts.push(t('hint.back'));
    elHint.textContent = parts.join('   ·   ');
  }

  /* --------------------------------------------------------- scrolling ---- */
  /* Every scroll goes through here: one place clamps the offset, moves the rows
     and lets the bar follow. The bar is shown by the movement and not by the
     level being long: a list standing still says nothing worth a stripe of the
     pane, and the same offset asked for twice is not a scroll. */
  function setScroll(y) {
    var max = scrollMax();
    var next = Math.max(0, Math.min(max, y));
    var moved = next !== scrollY;
    scrollY = next;
    if (scrollEl) scrollEl.style.transform = 'translateY(' + (-scrollY) + 'px)';
    paintScrollBar();
    if (moved) showScrollBar();
  }

  /* A fresh level is not a scroll: the offset goes back to the top and the bar
     stays down, however far the level before it had been scrolled. */
  function resetScroll() {
    scrollY = 0;
    if (scrollEl) scrollEl.style.transform = 'translateY(0px)';
    hideScrollBar();
    paintScrollBar();
  }

  function scrollMax() {
    if (!scrollEl) return 0;
    return Math.max(0, scrollEl.offsetHeight - elRows.clientHeight);
  }

  /* Up while the list is moving, down three seconds after it stopped. Every
     movement puts the timer back, so a walk down a long level keeps one bar up
     instead of blinking it once per row. */
  function showScrollBar() {
    if (!barEl) return;
    barEl.className = 'rows__bar is-on';
    if (barTimer) clearTimeout(barTimer);
    barTimer = setTimeout(hideScrollBar, BAR_MS);
  }

  function hideScrollBar() {
    if (barTimer) { clearTimeout(barTimer); barTimer = null; }
    if (barEl) barEl.className = 'rows__bar';
  }

  /* Where the thumb is and how tall it is — the readout itself, which is painted
     whether or not the bar is up: the movement that shows it has already
     happened by the time the fade starts. A level that fits has nothing to
     report, so the bar goes down and stays down. */
  function paintScrollBar() {
    if (!barEl) return;
    var max = scrollMax();
    if (!max) { hideScrollBar(); return; }
    /* A floor under the thumb: a very long level (the About text) would draw it
       as a couple of pixels nobody can see from across the room. */
    var share = Math.max(0.1, elRows.clientHeight / scrollEl.offsetHeight);
    var thumb = barEl.firstChild;
    thumb.style.height = (share * 100).toFixed(2) + '%';
    thumb.style.top = ((scrollY / max) * (1 - share) * 100).toFixed(2) + '%';
  }

  function ensureVisible(el) {
    var viewHeight = elRows.clientHeight;
    var top = el.offsetTop;
    var height = el.offsetHeight;
    var y = scrollY;
    if (top < y) y = top - 12;
    else if (top + height > y + viewHeight) y = top + height - viewHeight + 12;
    setScroll(y);
  }

  /* ------------------------------------------------------------ actions --- */
  var api = {
    t: t,
    toast: toast,
    /* Feedback for a call that is still running; any later toast clears it. */
    busy: busy,
    /* Uniform feedback for luna calls. */
    report: function (ok, info) {
      if (ok) { toast(t('toast.applied')); return; }
      if (info && info.mocked) { toast(t('toast.mock')); return; }
      toast(t('toast.failed'));
    },
    rerender: function () { expandedId = null; render(); }
  };

  function runAction(item) {
    if (item.confirmKey) {
      Dialog.show(t(item.confirmKey), function () { item.run(api); }, function () { paintFocus(); });
      return;
    }
    item.run(api);
  }

  function activate() {
    var entry = nav[navIndex];
    if (!entry) return;
    var item = entry.item;

    if (entry.kind === 'option') {
      applyValue(item, entry.value);
      setOptions(null);
      focusRow(item.id);
      return;
    }

    switch (item.type) {
      case 'toggle':
        applyValue(item, !S.value(item.id));
        render();
        focusRow(item.id);
        break;
      /* Picked up and put down with the same key: while a slider is held ◀ ▶
         change its value, while a reorder row is held ▲ ▼ move it and ◀ ▶ flip
         its switch, instead of leaving the level (see nudge / moveRow). */
      case 'slider':
      case 'reorder':
        editing = !editing;
        paintFocus();
        break;
      case 'select':
        setOptions(expandedId === item.id ? null : item.id);
        focusRow(item.id);
        if (expandedId) revealOptions(item.id);
        break;
      case 'action':
        runAction(item);
        break;
      case 'submenu':
        openSub(item);
        break;
    }
  }

  /* ---------------------------------------------------------- submenus ---- */
  function openSub(item) {
    var sub = S.subsection(item.sub);
    if (!sub) return;
    subStack.push({ level: sub, from: item.id });
    expandedId = null;
    editing = false;
    navIndex = 0;
    column = 'rows';
    render();
    if (sub.load) sub.load(api, false);
  }

  /* One level back, not all the way out: the row that opened the level being left
     is the one to stand on, and it may itself be a row of another submenu. */
  function leaveSub() {
    var gone = subStack.pop();
    expandedId = null;
    editing = false;
    navIndex = 0;
    render();
    if (gone && gone.from) focusRow(gone.from);
  }

  /* Writes the value and reports the result of the luna call. */
  function applyValue(item, value) {
    S.commit(item.id, value, function (ok, info) {
      if (ok && info && info.local) return;    // local-only stub: stay quiet
      api.report(ok, info);
      if (!ok) render();                       // roll the UI back to the stored value
    });
  }

  function focusRow(id) {
    for (var i = 0; i < nav.length; i++) {
      if (nav[i].kind === 'row' && nav[i].item.id === id) { navIndex = i; break; }
    }
    paintFocus();
  }

  /* Returns true when the focused row is a slider being edited, and so consumed
     the key. Merely standing on the row is not enough: OK enters it first (see
     activate), because ◀ is also the way out of a level and out of the rows, and
     a slider that answered ◀ on plain focus took that way out away from every row
     below it — the value moved when the user only meant to step back. */
  function nudge(direction) {
    var entry = nav[navIndex];
    if (!editing) return false;
    if (!entry || entry.kind !== 'row' || entry.item.type !== 'slider') return false;
    var item = entry.item;
    var next = sliderNext(item, S.value(item.id), direction);
    if (next !== S.value(item.id)) {
      applyValue(item, next);
      paintSliders();
      paintFocus();
    }
    return true;
  }

  /* While a reorder row is held, ◀ ▶ flip its switch instead of leaving the
     level. Returns true when the key was the row's. */
  function toggleReorder(direction) {
    var entry = nav[navIndex];
    if (!editing) return false;
    if (!entry || entry.kind !== 'row' || entry.item.type !== 'reorder') return false;
    var item = entry.item;
    if (!item.setOn) return true;
    var want = direction > 0;
    if ((item.on && item.on()) === want) return true;    // already there
    item.setOn(want);
    /* Only this row changes — its switch and its dimming — so only it is repainted: a
       render() would write the whole list again and put the scroll back to the top for
       one switch. Editing stays on: the row is still held. */
    var sw = entry.el.querySelector('.toggle');
    if (sw) sw.className = 'toggle' + (item.on && item.on() ? ' is-on' : '');
    entry.base = rowClass(item);
    paintFocus();
    return true;
  }

  function moveRow(delta) {
    // A level of plain text (About) has nothing to focus, so ▲ ▼ scroll it.
    if (!nav.length) { scrollPage(delta); return; }
    var held = nav[navIndex];
    /* A reorder row picked up travels with ▲ ▼ instead of the focus, and stays
       held at either end of the list. */
    if (editing && held && held.kind === 'row' && held.item.type === 'reorder' && held.item.move) {
      if (held.item.move(delta)) moveHeldRowInPlace(held, delta);
      return;
    }
    editing = false;

    var newIndex = navIndex + delta;
    /* If trying to move beyond nav bounds, scroll the content instead.
       This allows scrolling info blocks when navigation has few items. */
    if (newIndex < 0 || newIndex >= nav.length) {
      scrollPage(delta);
      return;
    }

    navIndex = newIndex;
    paintFocus();
  }

  /* How long the two rows that swap places take to slide into them (ms); 0 is no slide. */
  var ROW_SLIDE_MS = 120;

  /* A held row one place up or down, after its item has moved (the order is stored and
     the items are new objects): the row swaps places with its neighbour in the DOM and
     nothing else is touched. The list used to be written again from scratch with every
     step — render() puts the scroll back to the top before the focus brings it back —
     which made the whole list flash and jump while one row moved. Now the row stays the
     same node, still held and focused, the view follows it (paintFocus -> ensureVisible)
     and the two rows that changed places slide into them. */
  function moveHeldRowInPlace(held, delta) {
    var el = held.el;
    var other = delta < 0 ? el.previousElementSibling : el.nextElementSibling;
    var id = held.item.id;
    if (!other || other.className.indexOf('row--reorder') < 0) {
      /* Nothing of its own kind to swap with: write the list as it is now. */
      render();
      focusRow(id);
      return;
    }
    var elTop = el.offsetTop;
    var otherTop = other.offsetTop;
    if (delta < 0) scrollEl.insertBefore(el, other); else scrollEl.insertBefore(other, el);
    buildNav();                    // the nav follows the DOM, matched to the new items by id
    focusRow(id);
    slideRow(el, elTop - el.offsetTop);
    slideRow(other, otherTop - other.offsetTop);
  }

  /* A row that has just changed places starts where it was and slides to where it is. */
  function slideRow(el, from) {
    if (!ROW_SLIDE_MS || !from) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.style.transition = 'none';
    el.style.transform = 'translateY(' + from + 'px)';
    void el.offsetHeight;
    el.style.transition = 'transform ' + ROW_SLIDE_MS + 'ms ease-out';
    el.style.transform = '';
    setTimeout(function () { el.style.transition = ''; }, ROW_SLIDE_MS + 40);
  }

  /* ▲ ▼ on a level with nothing to focus (About): three fifths of the
     view at a time, so the line the eye stopped on is still on screen. */
  function scrollPage(delta) {
    setScroll(scrollY + delta * Math.round(elRows.clientHeight * 0.6));
  }

  /* ▲ ▼ walk the rail, not the array behind it: a hidden section is not on the
     way from one icon to the next, and the walk wraps round the icons that are
     actually there. */
  function stepSection(delta) {
    var at = railIndex.indexOf(sectionIndex);
    if (at < 0) at = 0;
    goSection(railIndex[(at + delta + railIndex.length) % railIndex.length]);
  }

  /* Opens a section by its place in Settings.sections. */
  function goSection(index) {
    sectionIndex = index;
    subStack = [];
    expandedId = null;
    editing = false;
    navIndex = 0;
    render();
    refreshCurrentSection();
  }

  /* Pull live values from the TV, then repaint if anything differed. */
  function refreshCurrentSection() {
    var top = subTop();
    if (top) {
      if (top.level.load) top.level.load(api, false);
      return;
    }
    var id = S.sections[sectionIndex].id;
    S.refresh(id, function (changed) {
      if (changed && isOpen && !subStack.length && S.sections[sectionIndex].id === id) {
        var keepIndex = navIndex;
        render();
        navIndex = Math.min(keepIndex, Math.max(0, nav.length - 1));
        paintFocus();
      }
    });
  }

  /* --------------------------------------------------------- open / close - */
  function open() {
    if (isOpen) return;
    isOpen = true;
    column = 'rail';
    editing = false;
    expandedId = null;
    subStack = [];
    navIndex = 0;
    elMenu.classList.add('is-open');
    elMenu.setAttribute('aria-hidden', 'false');
    render();
    refreshCurrentSection();
    resetIdle();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    editing = false;
    expandedId = null;
    subStack = [];
    elMenu.classList.remove('is-open');
    elMenu.setAttribute('aria-hidden', 'true');
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    /* The bar goes with the panel rather than fading three seconds into a closed
       one, the same way the balloon does. */
    hideScrollBar();
  }

  /* Back on the top level hands the screen back to the dock (app.js listens);
     the menu key leaves the app altogether, from any level, the way it does in
     the dock: hiding the window alone would keep the overlay focused and
     swallow the remote. */
  function dismiss() {
    close();
    document.dispatchEvent(new CustomEvent('settings:close'));
  }

  function leaveApp() {
    close();
    document.dispatchEvent(new CustomEvent('app:exit'));
  }

  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    if (!isOpen || !IDLE_MS) return;
    idleTimer = setTimeout(close, IDLE_MS);
  }

  /* `pending` keeps the balloon up, with a spinner, until the result replaces
     it: elevation and a launch take seconds, and a balloon that fades after two
     of them leaves the app looking frozen. The dock reports through the same
     balloon (Menu.toast): there is one #toast, and this module owns it. */
  function toast(text, pending) {
    elToast.textContent = text;
    elToast.classList.toggle('toast--busy', !!pending);
    elToast.classList.add('is-open');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    if (pending) return;
    toastTimer = setTimeout(function () { elToast.classList.remove('is-open'); }, 2000);
  }

  function busy(text) { toast(text, true); }

  /* Used when the app hides: a balloon left on screen would outlive it. */
  function hideToast() {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    elToast.classList.remove('is-open', 'toast--busy');
  }

  /* --------------------------------------------------------- key handling - */
  /* Returns true when the panel consumed the key. */
  function handleKey(action) {
    if (!isOpen) return false;
    resetIdle();

    if (column === 'rail') {
      switch (action) {
        case 'up': stepSection(-1); return true;
        case 'down': stepSection(1); return true;
        case 'right':
        case 'enter':
          /* Entered even when the section is read-only (About): there may be
             nothing to focus there, but ▲ ▼ still have to scroll it. */
          column = 'rows';
          navIndex = 0;
          paintFocus();
          return true;
        case 'left': return true;              // swallow: nothing to the left
        case 'back': dismiss(); return true;
        case 'menu': leaveApp(); return true;
        default: return false;
      }
    }

    switch (action) {
      case 'up': moveRow(-1); return true;
      case 'down': moveRow(1); return true;
      case 'left':
        /* On a row that has been picked up ◀ belongs to the row: a slider's
           value, a reorder's switch. Anywhere else it steps one level up. */
        if (nudge(-1)) return true;
        if (toggleReorder(-1)) return true;
        if (subStack.length) { leaveSub(); return true; }
        column = 'rail';
        editing = false;
        paintFocus();
        return true;
      case 'right':
        if (nudge(1)) return true;
        toggleReorder(1);
        return true;
      case 'enter': activate(); return true;
      case 'back':
        if (editing) { editing = false; paintFocus(); return true; }
        if (expandedId) {
          var id = expandedId;
          setOptions(null);
          focusRow(id);
          return true;
        }
        if (subStack.length) { leaveSub(); return true; }
        column = 'rail';
        paintFocus();
        return true;
      case 'menu': leaveApp(); return true;
      default: return false;
    }
  }

  /* --------------------------------------------------- pointer (Magic RC) - */
  elRail.addEventListener('mouseover', function (ev) {
    var node = ev.target.closest ? ev.target.closest('.rail__item') : null;
    if (!node) return;
    var index = Number(node.getAttribute('data-section'));
    column = 'rail';
    if (index !== sectionIndex) goSection(index); else paintRail();
    resetIdle();
  }, false);

  elRail.addEventListener('click', function (ev) {
    var node = ev.target.closest ? ev.target.closest('.rail__item') : null;
    if (!node) return;
    column = 'rows';
    goSection(Number(node.getAttribute('data-section')));
    resetIdle();
  }, false);

  elRows.addEventListener('mouseover', function (ev) {
    var node = ev.target.closest ? ev.target.closest('.row, .option') : null;
    if (!node) return;
    for (var i = 0; i < nav.length; i++) {
      if (nav[i].el === node) {
        column = 'rows';
        editing = false;
        navIndex = i;
        paintFocus();
        break;
      }
    }
    resetIdle();
  }, false);

  elRows.addEventListener('click', function (ev) {
    /* The links in About are captions with a dead href: a click on one must not
       take the window anywhere. */
    if (ev.target.closest && ev.target.closest('.about a')) { ev.preventDefault(); resetIdle(); return; }
    var node = ev.target.closest ? ev.target.closest('.row, .option') : null;
    if (!node) return;
    for (var i = 0; i < nav.length; i++) {
      if (nav[i].el === node) { navIndex = i; column = 'rows'; break; }
    }

    // Clicking the slider track jumps straight to that value.
    var track = ev.target.closest ? ev.target.closest('.slider') : null;
    var entry = nav[navIndex];
    if (track && entry && entry.item.type === 'slider') {
      var rect = track.getBoundingClientRect();
      var ratio = (ev.clientX - rect.left) / rect.width;
      var item = entry.item;
      applyValue(item, sliderAt(item, ratio));
      paintSliders();
      paintFocus();
    } else {
      activate();
    }
    resetIdle();
  }, false);

  /* A wheel scrolls the list without moving the focus: the rows it passes are not
     chosen, which is the difference between a wheel and ▲ ▼. A quarter of the view
     per notch, and the page keeps the key while there is anywhere to scroll to —
     the app is an overlay, so a wheel event left to the browser scrolls the
     document behind it instead. */
  elRows.addEventListener('wheel', function (ev) {
    if (!scrollMax()) return;
    ev.preventDefault();
    setScroll(scrollY + (ev.deltaY > 0 ? 1 : -1) * Math.round(elRows.clientHeight * 0.25));
    resetIdle();
  }, { passive: false });

  /* ------------------------------------------------------------- helpers -- */
  /* Jump to a section by id; a submenu id opens its parent first, so Back
     still leads back into the section (used by URL debug params). */
  function showSection(id) {
    for (var i = 0; i < S.sections.length; i++) {
      if (S.sections[i].id === id) {
        /* Not on the rail, so there is no way to it and nothing to show. */
        if (S.sections[i].hidden) return false;
        sectionIndex = i;
        subStack = [];
        expandedId = null;
        navIndex = 0;
        column = 'rows';
        if (!isOpen) open(); else { render(); refreshCurrentSection(); }
        column = 'rows';
        paintFocus();
        return true;
      }
    }

    var sub = S.subsection(id);
    if (!sub) return false;
    if (!showSection(sub.parentId)) return false;
    var entry = S.item(sub.entryId);
    if (!entry) return false;
    openSub(entry);
    return true;
  }

  /* Expand the option list of a select item, switching level if needed. The item
     may live one level down, so the level is opened through showSection(),
     which takes a submenu id as well as a section one. */
  function expand(id) {
    var item = S.item(id);
    if (!item || item.type !== 'select') return false;
    if (!showSection(S.sectionOf(id))) return false;
    column = 'rows';
    setOptions(id);
    focusRow(id);
    revealOptions(id);
    return true;
  }

  /* Open the confirmation of an action without pressing OK (URL debug param).
     Limited to items that ask for confirmation, so no request is ever sent. */
  function confirmAction(id) {
    var item = S.item(id);
    if (!item || item.type !== 'action' || !item.confirmKey) return false;
    if (!showSection(S.sectionOf(id))) return false;
    focusRow(id);
    runAction(item);
    return true;
  }

  /* Called after the UI language changes. */
  function relabel() {
    buildRail();
    if (isOpen) render();
    Dialog.repaint();
  }

  buildRail();

  return {
    open: open,
    close: close,
    toggle: function () { if (isOpen) dismiss(); else open(); },
    isOpen: function () { return isOpen; },
    handleKey: handleKey,
    showSection: showSection,
    expand: expand,
    confirmAction: confirmAction,
    relabel: relabel,
    refresh: refreshCurrentSection,
    toast: toast,
    busy: busy,
    hideToast: hideToast,
    /* The action API methods the model may reach outside runAction. */
    rerender: api.rerender,
    report: api.report
  };
})();
