/* =========================================================================
   Settings model: the sections of the Settings window and their items.
   The window is opened from the button at the foot of the dock and holds the
   app's own properties only — the dock itself (js/dock.js) changes nothing on
   the TV. This is the only file to edit when adding options — menu.js and the
   CSS stay untouched.

   Item types:
     group   — subheading, not focusable
     toggle  — boolean, OK flips it
     slider  — number, OK enters edit mode, ◀ ▶ change the value (min/max/step)
     select  — list of options, OK expands it
     action  — button, OK runs it (add confirmKey for destructive ones)
     submenu — OK opens a nested level out of `subsections`
     info    — read-only text block

   Optional per item:
     read(cb)        — pull the current value from the TV, cb(value)
     write(v, cb)    — push a new value, cb(ok, info)
     confirmKey      — i18n key of the confirmation question (actions only)
     status          — text (or a function) shown on the right of an
                       action/submenu row; statusOn accents it
   ========================================================================= */
window.Settings = (function () {
  var t = window.I18N.t;
  var Luna = window.Luna;

  /* Universal fallback icon shown when SVG files fail to load. Using help/question
     mark provides clear visual feedback without listing every icon inline. Saves
     ~1.5KB compared to full inline SVG fallbacks. TV fonts may lack emoji glyphs,
     so SVG is used for all icons. */
  var ICON_FALLBACK = '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"></path></svg>';

  /* One icon per section of the window, plus the buttons of the dock's foot:
     `app` (the sliders of Settings) and the icons of the quick commands (`home`,
     `power`, `restart`, `screenoff`, `store`, `browser`, `media`, `homehub`,
     `syssettings`, `eco`, `timer`, `submenu`), Settings.icon(name). */
  var ICON_NAMES = ['common', 'look', 'apps', 'tweaks', 'about', 'app', 'home', 'power', 'restart',
                    'store', 'browser', 'media', 'homehub', 'submenu', 'screenoff', 'syssettings',
                    'eco', 'timer'];
  var ICON = {};
  ICON_NAMES.forEach(function (name) { ICON[name] = ICON_FALLBACK; });

  /* Icon loading state: icons are read from external SVG files at startup
     to keep them editable without touching JS. The ICON object above holds
     inline fallbacks until the files load. */
  var iconsLoaded = false;
  var iconsLoading = false;

  /* Each section.icon was initialized with ICON_FALLBACK at definition time.
     Once the ICON object is updated, the new values are copied back to the
     section objects so Menu.relabel() sees them. */
  function syncSectionIcons() {
    for (var i = 0; i < sections.length; i++) {
      var sec = sections[i];
      if (sec.id && ICON[sec.id]) sec.icon = ICON[sec.id];
    }
  }

  /* Load icon SVG files from img/ directory. Each icon replaces its inline
     fallback in the ICON object. Callback receives true if all loaded, false
     if any failed. Icons that fail to load keep their inline fallback. */
  function loadIcons(callback) {
    if (iconsLoaded) {
      if (callback) callback(true);
      return;
    }
    if (iconsLoading) {
      /* Already loading, wait with polling. */
      var checkInterval = setInterval(function() {
        if (iconsLoaded || !iconsLoading) {
          clearInterval(checkInterval);
          if (callback) callback(iconsLoaded);
        }
      }, 50);
      return;
    }

    iconsLoading = true;
    var startTime = Date.now();
    var pending = ICON_NAMES.length;
    var failed = 0;

    function checkDone() {
      pending--;
      if (pending === 0) {
        iconsLoading = false;
        iconsLoaded = (failed === 0);
        console.log('[webocu-dock] Icons loaded asynchronously in ' + (Date.now() - startTime) + 'ms, ' + failed + ' failed');
        syncSectionIcons();
        if (callback) callback(iconsLoaded);
      }
    }

    /* Load all icons in parallel, same pattern as about.html loading. */
    for (var i = 0; i < ICON_NAMES.length; i++) {
      (function(name) {
        window.Platform.loadText('img/icon-' + name + '.svg', function(svg) {
          if (svg) {
            ICON[name] = svg;
          } else {
            console.warn('[webocu-dock] Failed to load icon-' + name + '.svg');
            failed++;
          }
          checkDone();
        });
      })(ICON_NAMES[i]);
    }
  }

  /* Synchronous icon loading for headless Chrome tests. Blocks the thread but
     ensures icons are ready before the DOM snapshot. Do NOT use in production.
     Only called when navigator.userAgent contains 'HeadlessChrome'. */
  function loadIconsSync() {
    if (iconsLoaded) return;

    var startTime = Date.now();
    var failed = 0;

    for (var i = 0; i < ICON_NAMES.length; i++) {
      var name = ICON_NAMES[i];
      var request;
      try { request = new XMLHttpRequest(); } catch (e) { failed++; continue; }

      try {
        request.open('GET', 'img/icon-' + name + '.svg', false); // false = synchronous
        request.send(null);
        var ok = request.status === 0 || (request.status >= 200 && request.status < 300);
        if (ok && request.responseText) {
          ICON[name] = request.responseText;
        } else {
          console.warn('[webocu-dock] Failed to load icon-' + name + '.svg (sync)');
          failed++;
        }
      } catch (e) {
        console.warn('[webocu-dock] Error loading icon-' + name + '.svg: ' + e);
        failed++;
      }
    }

    iconsLoaded = (failed === 0);
    console.log('[webocu-dock] Icons loaded synchronously in ' + (Date.now() - startTime) + 'ms, ' + failed + ' failed');
    syncSectionIcons();
  }

  /* The one colour the panel highlights with (--accent in the CSS): the active
     section, a switch that is on, a slider fill, a link. Twenty-eight hues in total:
     sixteen bright colours, five neutrals (gray, silver, slate, white, black), and
     seven additional shades. The names stay tellable apart and the colour stays
     visible on the dark, the light and the contrast palette.
     `swatch` is what menu.js paints next to the name — a colour name alone
     tells nobody what "Orchid" looks like. */
  var ACCENTS = [
    { value: 'red',     labelKey: 'accent.red',     swatch: '#ff3b30' },
    { value: 'orange',  labelKey: 'accent.orange',  swatch: '#ff7a1a' },
    { value: 'amber',   labelKey: 'accent.amber',   swatch: '#ffab00' },
    { value: 'yellow',  labelKey: 'accent.yellow',  swatch: '#ffd400' },
    { value: 'lime',    labelKey: 'accent.lime',    swatch: '#c6e300' },
    { value: 'green',   labelKey: 'accent.green',   swatch: '#3ddc57' },
    { value: 'emerald', labelKey: 'accent.emerald', swatch: '#00c88a' },
    { value: 'teal',    labelKey: 'accent.teal',    swatch: '#00bfae' },
    { value: 'cyan',    labelKey: 'accent.cyan',    swatch: '#00d5ff' },
    { value: 'azure',   labelKey: 'accent.azure',   swatch: '#1f8dff' },
    { value: 'blue',    labelKey: 'accent.blue',    swatch: '#4560ff' },
    { value: 'violet',  labelKey: 'accent.violet',  swatch: '#7a5cff' },
    { value: 'purple',  labelKey: 'accent.purple',  swatch: '#a855f7' },
    { value: 'orchid',  labelKey: 'accent.orchid',  swatch: '#d946ef' },
    { value: 'magenta', labelKey: 'accent.magenta', swatch: '#f21b9c' },
    { value: 'pink',    labelKey: 'accent.pink',    swatch: '#ff5c8a' },
    /* Neutral colours: gray tones, white and black. Not pure #000000 or #ffffff
       to stay visible on both dark and light backgrounds. */
    { value: 'gray',    labelKey: 'accent.gray',    swatch: '#9ca3af' },
    { value: 'silver',  labelKey: 'accent.silver',  swatch: '#d1d5db' },
    { value: 'slate',   labelKey: 'accent.slate',   swatch: '#64748b' },
    { value: 'white',   labelKey: 'accent.white',   swatch: '#f5f5f5' },
    { value: 'black',   labelKey: 'accent.black',   swatch: '#1f1f1f' },
    /* Additional shades to fill out the palette. */
    { value: 'crimson', labelKey: 'accent.crimson', swatch: '#dc2626' },
    { value: 'gold',    labelKey: 'accent.gold',    swatch: '#f59e0b' },
    { value: 'mint',    labelKey: 'accent.mint',    swatch: '#10b981' },
    { value: 'sky',     labelKey: 'accent.sky',     swatch: '#0ea5e9' },
    { value: 'indigo',  labelKey: 'accent.indigo',  swatch: '#6366f1' },
    { value: 'rose',    labelKey: 'accent.rose',    swatch: '#f43f5e' },
    { value: 'coral',   labelKey: 'accent.coral',   swatch: '#fb7185' }
  ];

  /* Magenta is the colour the stylesheet ships with, so it is the default here
     as well: a fresh install looks exactly as it did before. */
  var DEF_ACCENT = 'magenta';

  /* How much of the picture shows through the whole overlay: 0 to 70 per cent in
     steps of five, nothing at the left end of the slider and in a fresh install.
     Seventy is the ceiling on purpose — any more and there is too little of the
     panel left on screen to aim the remote at (it used to be the floor of an
     opacity from 30 to 100). The row shows no number: the fill of the track is the
     readout, and per cent of transparency means nothing to the eye anyway. */
  var MIN_TRANSPARENCY = 0;
  var MAX_TRANSPARENCY = 70;
  var TRANSPARENCY_STEP = 5;
  var DEF_TRANSPARENCY = 0;

  /* How solid the pictures behind the two columns are: nothing at all in a fresh
     install, up to a hundred per cent in steps of ten. Zero is the off state of
     the setting and not a floor — "no picture" is the bottom of the same
     question, so one row answers it instead of a switch and a slider answering
     it twice. Ten steps and not twenty: the difference a single step makes has to
     be visible on a TV across the room. */
  var MIN_BG = 0;
  var MAX_BG = 100;
  var BG_STEP = 10;
  var DEF_BG = 10;

  /* How many columns of icons the dock has: one by default, seven at most (the
     widths are in app.css, the walk across them in dock.js). Stored as a string
     because the values of a select are compared as the attribute text the
     option row carries. */
  var COLUMNS = ['1', '2', '3', '4', '5', '6', '7'];
  var DEF_COLUMNS = '1';

  /* Which edge of the screen the dock stands at. The distance from it
     (dockOffsetX) is measured from that edge; everything else is the CSS's
     business (data-side on <html>). */
  var SIDES = ['left', 'right'];
  var DEF_SIDE = 'left';

  /* How many rows of icons are on screen before the list scrolls. Seven is the
     ceiling because it is the most that fits 1080 together with the foot and
     the padding of the panel (7 x 112 + 6 x 12 + the foot of 112 + 24 + 32);
     three is the floor because a dock of fewer rows is mostly scrolling. */
  var MIN_ROWS = 3;
  var MAX_ROWS = 7;
  var DEF_ROWS = 6;

  /* Where the dock stands, in pixels of the 1920x1080 layout and in steps of
     ten: how far off its edge (left or right, see SIDES; up to the middle of the screen), and how
     far above (minus) or below (plus) the centre of the height (up to half the
     screen either way). Ten pixels: the slider crosses half a screen in a
     hundred steps or so, and a TV's overscan is cleared in a few of them; dock.js keeps a tall panel on screen whatever the
     vertical value asks for. */
  var MIN_OFFSET_X = 0;
  var MAX_OFFSET_X = 960;
  var DEF_OFFSET_X = 0;
  var MIN_OFFSET_Y = -540;
  var MAX_OFFSET_Y = 540;
  var DEF_OFFSET_Y = 0;
  var OFFSET_STEP = 10;

  /* For how many seconds the name of the focused tile stays up after an arrow or
     the pointer moved the focus onto it: a short list, one stop for each way of
     using it. Half a second is the default: a flash, as the name only gets in the
     way of the picture; 1 is a little longer, 3 and 5 are long enough to read. No
     0 in the list: switching the names off is the switch of the Hints level. A value
     stored under an earlier list moves to the nearest stop (nearestOf); a stored 0,
     which used to mean "never", becomes that switch (applyLabels). */
  var LABEL_SEC = [0.5, 1, 3, 5];
  var DEF_LABEL_SEC = 0.5;

  /* Where the focus of the dock stands each time the dock is shown (General -> Focus
     on open): on what it was left on, as it always was while the app stays in
     memory; on the first app of the list; or on the last one. */
  var OPEN_FOCUS = ['last', 'first', 'end'];
  var DEF_OPEN_FOCUS = 'last';

  /* Where that name stands: against the icon (under it, over it when the screen
     ends below), or beside the panel of the dock, on the side of the picture and
     level with the icon — the other side of the panel when there is no room on that
     one (dock.js paintLabel). */
  var LABEL_PLACES = ['tile', 'dock'];
  var DEF_LABEL_PLACE = 'dock';

  /* How the name looks (Appearance -> Hints -> Style), each a way of being less or
     more there: the capsule the name always was, the same without the frame on a
     see-through ground, a fill in the accent colour, bare letters with a shadow,
     and a small capsule. The names of the keys are spelled out, not built from the
     value: the i18n check looks for whole keys. */
  var HINT_STYLES = [
    { value: 'pill', labelKey: 'hints.style.pill' },
    { value: 'soft', labelKey: 'hints.style.soft' },
    { value: 'solid', labelKey: 'hints.style.solid' },
    { value: 'text', labelKey: 'hints.style.text' },
    { value: 'compact', labelKey: 'hints.style.compact' }
  ];
  var DEF_HINT_STYLE = 'pill';

  /* How the name comes up: slides in as it fades (what it always did), fades only,
     grows a little as it fades, or is just there. It follows the focus the same way
     whichever is chosen. */
  var HINT_EFFECTS = [
    { value: 'slide', labelKey: 'hints.effect.slide' },
    { value: 'fade', labelKey: 'hints.effect.fade' },
    { value: 'pop', labelKey: 'hints.effect.pop' },
    { value: 'none', labelKey: 'hints.effect.none' }
  ];
  var DEF_HINT_EFFECT = 'slide';

  /* How the dock itself comes onto the screen (Appearance -> Dock -> Entrance effect): out
     from behind the edge it stands at, as it always did, or from behind the opposite edge
     of the screen, or from the top or the bottom, or faded in, or grown a little, or just
     there. (There used to be a left and a right: they are the dock's own side and the
     opposite one, whichever is which, and migrate() turns a stored one into the right
     of the two.) The CSS reads it from <html> (data-dock-effect); the key names are
     spelled out, not built from the value: the i18n check looks for whole keys. */
  var DOCK_EFFECTS = [
    { value: 'edge', labelKey: 'dock.effect.edge' },
    { value: 'opposite', labelKey: 'dock.effect.opposite' },
    { value: 'top', labelKey: 'dock.effect.top' },
    { value: 'bottom', labelKey: 'dock.effect.bottom' },
    { value: 'fade', labelKey: 'dock.effect.fade' },
    { value: 'pop', labelKey: 'dock.effect.pop' },
    { value: 'none', labelKey: 'dock.effect.none' }
  ];
  var DEF_DOCK_EFFECT = 'edge';

  /* Which tiles name themselves in a fresh install: the items of the submenu only. The
     icons of the apps and of the quick buttons are mostly enough by themselves and a name
     that comes up on every step is a thing to switch on, not off; the submenu has no
     other way to say what an item does. */
  var DEF_HINTS_APPS = false;
  var DEF_HINTS_QUICK = false;
  var DEF_HINTS_SUB = true;

  /* After how many idle seconds (no key, no pointer movement) the app hides
     itself so the picture underneath gets the remote back. A short fixed list
     and no "never": the overlay must not be able to sit on the screen for good.
     The Settings window is exempt (app.js), it is being worked in. */
  var AUTOHIDE_SEC = [5, 10, 20, 30, 60];
  var DEF_AUTOHIDE_SEC = 30;

  /* One option of a list of seconds. The value stays the bare number (a select
     compares it as text, and the store holds it), only the shown text carries
     the unit. A function, so a change of language rebuilds it on relabel. */
  function secOption(n) {
    return { value: String(n), label: function () { return t('value.sec', { n: n }); } };
  }

  /* What the dock reads back (rows(), offsetY(), labelSeconds()): the stored
     value, or a URL preview of it. Kept here and not on <html> because nothing
     in the CSS needs them — dock.js lays the rows and the shift out itself and
     runs the timer of the name. */
  var dockNow = { rows: DEF_ROWS, offsetY: DEF_OFFSET_Y, labelSec: DEF_LABEL_SEC, labelPlace: DEF_LABEL_PLACE,
                  openFocus: DEF_OPEN_FOCUS, hintApps: DEF_HINTS_APPS, hintQuick: DEF_HINTS_QUICK, hintSub: DEF_HINTS_SUB,
                  labelStyle: DEF_HINT_STYLE, labelEffect: DEF_HINT_EFFECT,
                  labelText: false, labelBorder: false,
                  idleSec: DEF_AUTOHIDE_SEC, openAtStart: null, quick: ['off', 'off', 'home'],
                  quick4: 'settings',
                  sub: ['settings', 'syssettings', 'screenoff', 'off', 'off', 'off', 'off', 'off'] };

  /* The TV's own launcher: what a quick button can start, and what the row
     Applications -> Open webOS Home starts (dock.js reads it from here). */
  var HOME_APP = 'com.webos.app.home';
  /* The stock Settings of the TV. The id is the one the stock launcher itself
     starts for its own Settings entries (com.webos.app.home, AppInterfaces.qml:
     launchApp("com.palm.app.settings", ...)). One constant, so a firmware that
     names it otherwise is a one-line fix. */
  var SYSTEM_SETTINGS_APP = 'com.palm.app.settings';

  /* The quick buttons of the dock's foot (Appearance -> Quick launch): three
     the user sets, left to right, and Settings after them, which is fixed. What
     each can do, in the order of the list: an app to start (`app`), a power
     action behind a countdown (`power`, dock.js), the screen switched off at once
     (`screen`: one key of the remote undoes it, so it asks no question) or the
     submenu below (`submenu`). 'off' leaves the place empty,
     and an empty button takes no room. The ids are the LG system apps' as the
     firmware names them; one table, so a firmware that calls one differently is
     a one-line fix. `params` is what the app is started with: the hotkey screens of
     the TV (Eco mode, Sleep timer) are one app, com.webos.app.tvhotkey, told which
     of them to show by activateType. They take the remote for themselves, so the
     dock goes away after them like after any other launch. */
  var QUICK = [
    { value: 'off', nameKey: 'dock.quick.empty' },
    { value: 'home', icon: 'home', nameKey: 'dock.home', app: HOME_APP },
    /* Third on purpose: the lists of the quick buttons and of the submenu places are
       built from this table, so it stands right after the empty choice and webOS
       Home in all of them. Not `settings`: that is the dock's own window. Its
       icon is the four-tile grid: the rays of the first one read as brightness. */
    { value: 'syssettings', icon: 'syssettings', nameKey: 'dock.sysSettings', app: SYSTEM_SETTINGS_APP },
    { value: 'store', icon: 'store', nameKey: 'dock.store', app: 'com.webos.app.discovery' },
    { value: 'browser', icon: 'browser', nameKey: 'dock.browser', app: 'com.webos.app.browser' },
    { value: 'media', icon: 'media', nameKey: 'dock.media', app: 'com.webos.app.mediadiscovery' },
    { value: 'homehub', icon: 'homehub', nameKey: 'dock.homeHub', app: 'com.webos.app.homeconnect' },
    { value: 'poweroff', icon: 'power', nameKey: 'dock.powerOff', power: 'poweroff' },
    { value: 'restart', icon: 'restart', nameKey: 'dock.restart', power: 'restart' },
    { value: 'screenoff', icon: 'screenoff', nameKey: 'dock.screenOff', screen: 'off' },
    { value: 'eco', icon: 'eco', nameKey: 'dock.eco', app: 'com.webos.app.tvhotkey',
      params: { activateType: 'energy-saving-mode' } },
    { value: 'sleep', icon: 'timer', nameKey: 'dock.sleep', app: 'com.webos.app.tvhotkey',
      params: { activateType: 'sleep' } },
    { value: 'submenu', icon: 'submenu', nameKey: 'dock.submenu', submenu: true }
  ];

  /* What the Submenu quick button opens (dock.js): one column of icons the size of
     the foot's, up to eight of them, each a place the user sets (Appearance ->
     Quick launch -> Submenu: Item 1..8, from the top). What a place can hold is
     every command of QUICK but the empty one and the submenu itself (a new command
     lands here with no other change), and the dock's own Settings, which is no
     command of QUICK because the foot has its fixed button for it; the empty
     choice goes first, in every place, so each icon can be switched off. Settings
     cannot be switched off for good: with all eight empty the column holds that one
     item (submenuItems), because the Submenu on the fourth button leaves it no
     other way in. */
  var SUB_OFF = QUICK[0];
  var SUB_COMMANDS = [SUB_OFF].concat(QUICK.filter(function (c) {
    return c.value !== 'off' && !c.submenu;
  }), [{ value: 'settings', icon: 'app', nameKey: 'dock.settings', settings: true }]);
  var SUB_MAX = 8;
  /* The dock's own Settings first, so the focus (it starts on the top item) lands
     on the way into the window, then the TV's Settings and the screen switch. Power
     Off and Restart are still on every list: they are a choice, no longer a default.
     Only a place nobody has set yet reads these; stored values stay as they are. */
  var DEF_SUB = ['settings', 'syssettings', 'screenoff', 'off', 'off', 'off', 'off', 'off'];
  /* Spelled out, not built from the slot: the i18n check looks for whole keys. */
  var SUB_LABEL = ['dock.sub.i1', 'dock.sub.i2', 'dock.sub.i3', 'dock.sub.i4', 'dock.sub.i5', 'dock.sub.i6',
                   'dock.sub.i7', 'dock.sub.i8'];

  var DEF_QUICK = ['off', 'off', 'home'];
  /* The fourth button is no place of QUICK: it is the dock's own Settings button,
     which can also be the Submenu button. Those are its two choices; Settings
     stays the default, so a dock that never saw the row looks as before. */
  var DEF_QUICK4 = 'settings';
  var QUICK4 = ['settings', 'submenu'];
  /* Spelled out, not built from the slot: the i18n check looks for whole keys. */
  var QUICK_LABEL = ['dock.quick.b1', 'dock.quick.b2', 'dock.quick.b3'];

  /* Apps switched off in Settings -> Applications, by a URL preview (?hide=);
     null when the store decides. */
  var hiddenPreview = null;

  /* Service state reported by the helper (Tweaks shows it). */
  var device = { service: null };

  /* Whether the HOME button opens the dock, by each method; filled from the
     service when Tweaks is entered (loadHome), read by the two toggles. */
  var homeState = { hook: false, setting: false };

  var DASH = '—';

  function or(text) { return text || DASH; }

  /* The clock of the dock: the time above the icons and the date under the
     buttons of the foot. Ported from webocu-settings, where it sat in the rail
     of the panel. The option lists show the current moment in each format
     instead of describing it, so "Time format — 14:05" is the setting and its
     own preview at once. */
  var TIME_FORMATS = ['24h', '24hn', '12h'];
  var DATE_FORMATS = ['wday', 'dmy', 'mdy', 'ymd', 'dmon', 'dmonwd', 'dm', 'wdaydm', 'wdaynum', 'dlong'];
  /* "9 Nov, Mon": the day, the month and the weekday, still one line in a dock
     one tile (112px) wide. */
  var DEF_DATE_FORMAT = 'dmonwd';

  /* How large each band is drawn (the CSS scales its type by these): five steps,
     the middle one the size the dock always had. */
  var CLOCK_SIZES = ['xs', 's', 'm', 'l', 'xl'];
  var DEF_CLOCK_SIZE = 'm';

  /* Both lists start with the option that shows nothing: the way to take the time
     or the date off the dock is to pick a format that is no format, and it is
     worded Empty, like the empty choice of the quick buttons, since the other
     options are samples of themselves and it has none. A label function, so the
     word follows the language. */
  var CLOCK_OFF = 'off';

  function offOption() {
    return { value: CLOCK_OFF, label: function () { return t('dock.quick.empty'); } };
  }

  function clockChoices(formats) {
    return [CLOCK_OFF].concat(formats);
  }

  function two(n) { return (n < 10 ? '0' : '') + n; }

  function formatTime(date, format) {
    var hours = date.getHours();
    var text = two(date.getMinutes());
    /* 24hn: the 24-hour clock with no zero before a single digit, "9:05". */
    if (format === '24hn') return hours + ':' + text;
    if (format !== '12h') return two(hours) + ':' + text;
    /* AM/PM stays Latin: no dictionary here has a word for it that declines. */
    return ((hours % 12) || 12) + ':' + text + (hours < 12 ? ' AM' : ' PM');
  }

  function formatDate(date, format) {
    var day = date.getDate();
    var month = date.getMonth();
    var year = date.getFullYear();
    switch (format) {
      case 'mdy': return two(month + 1) + '/' + two(day) + '/' + year;
      case 'ymd': return year + '-' + two(month + 1) + '-' + two(day);
      /* One key holds all twelve names: a dozen keys apiece would be a dozen
         chances for the dictionaries to drift apart. */
      case 'dmon': return day + ' ' + t('months.short').split(',')[month];
      /* The two with a weekday in them drop the year: the dock has one line for
         the date, and nobody reads the year off a clock. */
      case 'dmonwd': return day + ' ' + t('months.short').split(',')[month] +
                            ', ' + t('days.short').split(',')[date.getDay()];
      case 'wday': return t('days.long').split(',')[date.getDay()];
      case 'dm': return two(day) + '.' + two(month + 1);
      case 'wdaydm': return t('days.short').split(',')[date.getDay()] + ', ' + day + ' ' +
                            t('months.short').split(',')[month];
      case 'wdaynum': return t('days.short').split(',')[date.getDay()] + ' ' + two(day) + '.' + two(month + 1);
      /* The full name of the month, in the case a date asks for ("13 ноября"). */
      case 'dlong': return day + ' ' + t('months.long').split(',')[month];
      default: return two(day) + '.' + two(month + 1) + '.' + year;
    }
  }

  /* The label is a function, not a key: the sample has to follow the clock. */
  function formatOptions(formats, render) {
    var out = [];
    for (var i = 0; i < formats.length; i++) {
      out.push({ value: formats[i], label: sampleFn(formats[i], render) });
    }
    return out;
  }

  function sampleFn(format, render) {
    return function () { return render(new Date(), format); };
  }

  /* Formats forced by the URL debug params (?time=, ?date=), so a screenshot or
     the smoke test can see the 12-hour clock without storing anything. */
  var clockPreview = { time: null, date: null };

  function previewClock(time, date) {
    var changed = false;
    if (clockChoices(TIME_FORMATS).indexOf(time) >= 0) { clockPreview.time = time; changed = true; }
    if (clockChoices(DATE_FORMATS).indexOf(date) >= 0) { clockPreview.date = date; changed = true; }
    /* ?time=off is a band that is not there rather than a band with nothing in
       it, and it is the CSS that takes it away: re-read the attributes. */
    applyClockLook();
    return changed;
  }

  /* Stored choice, or the default when it is something else. */
  function pick(formats, key, def) {
    var stored = window.Store.get(key, def);
    return formats.indexOf(stored) < 0 ? def : stored;
  }

  function timeFormat() {
    return clockPreview.time || pick(clockChoices(TIME_FORMATS), 'appTimeFormat', '24h');
  }

  function dateFormat() {
    return clockPreview.date || pick(clockChoices(DATE_FORMATS), 'appDateFormat', DEF_DATE_FORMAT);
  }

  /* Empty when the format is the off end of the list: dock.js writes whatever
     comes back into the band, and the CSS takes the switched-off band away. */
  function timeText() {
    var format = timeFormat();
    return format === CLOCK_OFF ? '' : formatTime(new Date(), format);
  }

  function dateText() {
    var format = dateFormat();
    return format === CLOCK_OFF ? '' : formatDate(new Date(), format);
  }

  /* The size of one band of the clock: XS S M L XL, the same letters in every
     language. */
  function sizeItem(id, labelKey) {
    return {
      id: id,
      type: 'select',
      labelKey: labelKey,
      def: DEF_CLOCK_SIZE,
      options: CLOCK_SIZES.map(function (size) { return { value: size, label: size.toUpperCase() }; }),
      write: clockWrite
    };
  }

  /* One place of the foot: a list of the commands, the empty one first. */
  function quickItem(slot, hintKey) {
    return {
      id: 'dockQuick' + slot,
      type: 'select',
      labelKey: QUICK_LABEL[slot - 1],
      hintKey: hintKey,
      def: DEF_QUICK[slot - 1],
      options: QUICK.map(function (c) { return { value: c.value, labelKey: c.nameKey }; }),
      write: function (value, cb) {
        applyQuick();
        cb(true, { local: true });
      }
    };
  }

  /* One place of the submenu: a list of the commands, the empty choice first. A
     place may stay empty: the submenu still keeps the dock's Settings
     (submenuItems), so nothing needs to be said when the last icon goes. */
  function subItem(slot) {
    return {
      id: 'dockSub' + slot,
      type: 'select',
      labelKey: SUB_LABEL[slot - 1],
      hintKey: 'dock.sub.hint.may',
      def: DEF_SUB[slot - 1],
      options: SUB_COMMANDS.map(function (c) { return { value: c.value, labelKey: c.nameKey }; }),
      write: function (value, cb) {
        applySub();
        cb(true, { local: true });
      }
    };
  }

  /* What the row leading into the quick level previews: the names of the places
     that are set, left to right. */
  function quickSummary() {
    var names = [];
    for (var i = 1; i <= 3; i++) {
      var cmd = quickAt(i);
      if (cmd) names.push(t(cmd.nameKey));
    }
    return names.join(' · ');
  }

  /* What the row leading into the clock submenu previews: only the parts that
     are still on, so the separator does not show up on its own. */
  function clockSummary() {
    return [timeText(), dateText()].filter(function (part) { return !!part; }).join(' · ');
  }

  /* One attribute per question — is each band there, is it in the accent, how
     heavy are both — so the CSS can answer them separately. Both colours are on
     in a fresh install: the clock is the one thing on the dock that is not a
     button, and the accent tells it apart from them. */
  function applyClockLook() {
    var root = document.documentElement;
    root.setAttribute('data-clock', timeFormat() === CLOCK_OFF ? 'off' : 'on');
    root.setAttribute('data-date', dateFormat() === CLOCK_OFF ? 'off' : 'on');
    root.setAttribute('data-clock-accent', window.Store.get('appClockColour', true) ? 'on' : 'off');
    root.setAttribute('data-date-accent', window.Store.get('appDateColour', true) ? 'on' : 'off');
    root.setAttribute('data-clock-bold', window.Store.get('appClockBold', true) ? 'on' : 'off');
    root.setAttribute('data-clock-size', clockSize('appClockSize'));
    root.setAttribute('data-date-size', clockSize('appDateSize'));
  }

  /* The size of a band: the URL preview when there is one, else the stored
     choice, else the middle step. */
  var sizePreview = { appClockSize: null, appDateSize: null };

  function clockSize(key) {
    var size = sizePreview[key] || window.Store.get(key, DEF_CLOCK_SIZE);
    return CLOCK_SIZES.indexOf(size) < 0 ? DEF_CLOCK_SIZE : size;
  }

  /* ?clockSize=xl and ?dateSize=xs, nothing stored. */
  function previewClockSize(key, value) {
    if (CLOCK_SIZES.indexOf(String(value)) < 0) return false;
    sizePreview[key] = String(value);
    applyClockLook();
    return true;
  }

  function clockWrite(value, cb) {
    applyClockLook();
    window.Dock.relabel();
    cb(true, { local: true });
  }

  var sections = [
    /* First, because it is the point of the app: which of the installed apps the
       dock shows, in what order, and the TV's inputs. The rows come from the same
       read the dock makes (Dock.load), so the two never disagree; opening the
       tab takes the cached list, and the first row reads it again from the TV,
       for an app installed since. */
    {
      id: 'apps',
      icon: ICON.apps,
      titleKey: 'section.apps',
      shortKey: 'section.apps.short',
      subKey: 'section.apps.sub',
      items: [],
      load: function (done) { loadApps(done); }
    },

    /* What is not about how anything looks: the language of the app and the
       way back to a fresh install. */
    {
      id: 'common',
      icon: ICON.common,
      titleKey: 'section.common',
      shortKey: 'section.common.short',
      subKey: 'section.common.sub',
      items: [
        {
          id: 'appLanguage',
          type: 'select',
          labelKey: 'app.language',
          hintKey: 'app.language.hint',
          def: 'en',
          /* Language options are determined dynamically from loaded locale files.
             Enable/disable languages by commenting out <script> tags in index.html.
             Each option is labelled in its own language (lang.* keys), so the list
             can be read by someone who cannot yet read the panel. */
          options: (function () {
            var available = window.I18N.getAvailableLanguages();
            return available.map(function (lang) {
              return { value: lang, labelKey: 'lang.' + lang };
            });
          })(),
          write: function (value, cb) {
            if (applyLanguage()) window.Menu.relabel();
            cb(true, { local: true });
          }
        },
        /* The time above the dock's icons and the date under its buttons. The row
           previews what the clock reads right now. */
        {
          id: 'appClock',
          type: 'submenu',
          labelKey: 'app.clock',
          hintKey: 'app.clock.hint',
          sub: 'clock',
          status: function () { return clockSummary(); }
        },
        /* Autostart: only the start the TV makes by itself (the keepalive init
           script launches the app at boot, see keepalive_daemon.sh). On, the
           dock opens then. Off, the app quits at once, so nothing stays in
           memory and the next launch (HOME, the launcher) is a cold one. A
           start the user makes is never affected. */
        {
          id: 'appOpenAtStart',
          type: 'toggle',
          labelKey: 'app.openAtStart',
          hintKey: 'app.openAtStart.hint',
          def: true,
          write: function (value, cb) { cb(true, { local: true }); }
        },
        /* Seconds without a key or pointer movement before the app hides. */
        {
          id: 'appAutoHide',
          type: 'select',
          labelKey: 'app.autoHide',
          hintKey: 'app.autoHide.hint',
          def: String(DEF_AUTOHIDE_SEC),
          options: AUTOHIDE_SEC.map(secOption),
          write: function (value, cb) {
            applyAutoHide();
            cb(true, { local: true });
          }
        },
        /* Where the focus goes whenever the dock is shown. The one remembered is
           the one the app holds in memory: a cold start has none, and starts on
           the first app. */
        {
          id: 'appOpenFocus',
          type: 'select',
          labelKey: 'app.openFocus',
          hintKey: 'app.openFocus.hint',
          def: DEF_OPEN_FOCUS,
          options: [
            { value: 'last', labelKey: 'app.openFocus.last' },
            { value: 'first', labelKey: 'app.openFocus.first' },
            { value: 'end', labelKey: 'app.openFocus.end' }
          ],
          write: function (value, cb) {
            applyOpenFocus();
            cb(true, { local: true });
          }
        },
        /* Everything the app remembers at once, so it ends the list. */
        {
          id: 'appReset',
          type: 'action',
          labelKey: 'app.reset',
          hintKey: 'app.reset.hint',
          confirmKey: 'app.confirmReset',
          run: function (api) { resetPrefs(api); }
        }
      ]
    },

    /* Everything about how the dock and this window look, as six levels of their own:
       the theme, the background, the dock itself, the names of its tiles (Hints), its
       quick buttons, and the balloon the app reports with, which goes last. Everything
       here lives in localStorage and is applied by applyAppPrefs() at startup. */
    {
      id: 'look',
      icon: ICON.look,
      titleKey: 'section.look',
      shortKey: 'section.look.short',
      subKey: 'section.look.sub',
      items: [
        {
          id: 'lookTheme',
          type: 'submenu',
          labelKey: 'look.theme',
          sub: 'theme',
          status: function () { return themeSummary(); }
        },
        { id: 'lookBg', type: 'submenu', labelKey: 'look.bg', sub: 'bg' },
        {
          id: 'dockLayout',
          type: 'submenu',
          labelKey: 'section.dock',
          sub: 'dock',
          status: function () { return dockSummary(); }
        },
        /* The names of the tiles (when, where, how) have a level of their own. */
        {
          id: 'dockHints',
          type: 'submenu',
          labelKey: 'hints.title',
          hintKey: 'hints.hint',
          sub: 'hints',
          status: function () { return hintsSummary(); }
        },
        /* The buttons of the foot, after the hints:
           the row leads into a level of its own. By default the TV's own launcher
           stands next to Settings, one press away: the dock replaces the walk to
           the Home key for everything else, so it should not make Home itself
           harder to reach. The row opens the level with the three places. */
        {
          id: 'dockQuick',
          type: 'submenu',
          labelKey: 'dock.quick',
          hintKey: 'dock.quick.hint',
          sub: 'quick',
          status: function () { return quickSummary(); }
        },
        { id: 'lookToast', type: 'submenu', labelKey: 'toasts.title', sub: 'toasts' }
      ]
    },

    /* Nothing here is a preference and nothing here is undone by a switch back:
       asking for root restarts the helper service as a privileged process,
       switching the app ID installs a second package. */
    {
      id: 'tweaks',
      icon: ICON.tweaks,
      titleKey: 'section.tweaks',
      shortKey: 'section.tweaks.short',
      subKey: 'section.tweaks.sub',
      load: function (done) { loadHome(done); },
      items: [
        { id: 'privGroup', type: 'group', labelKey: 'app.privileges' },
        {
          id: 'requestPriv',
          type: 'action',
          labelKey: 'app.requestPriv',
          hintKey: 'app.requestPriv.hint',
          run: function (api) {
            /* Elevation runs a script on the TV and restarts the service, which
               takes several seconds: the balloon stays until the answer. */
            api.busy(t('toast.privWait'));
            Luna.elevate(function (root, status) {
              if (status) device.service = status;
              /* Rebuild switch app ID items based on new root status. */
              buildSwitchAppIdItems();
              api.rerender();
              if (root) { api.toast(t('toast.privOk')); return; }
              if (status && status.mocked) { api.toast(t('toast.mock')); return; }
              api.toast(t('toast.privFail'));
            });
          }
        },
        { id: 'privInfo', type: 'info', render: function () { return privilegeInfoHtml(); } },

        { id: 'appIdGroup', type: 'group', labelKey: 'tweaks.appId' },
        {
          id: 'switchAppId',
          type: 'submenu',
          labelKey: 'tweaks.switchAppId',
          hintKey: 'tweaks.switchAppId.hint',
          sub: 'switchAppId',
          /* Show a warning if root is not available. */
          status: function () {
            return (device.service && device.service.root) ? '' : t('tweaks.needRoot');
          }
        },

        { id: 'lifecycleGroup', type: 'group', labelKey: 'tweaks.lifecycle' },
        {
          id: 'tweaksKeepAlive',
          type: 'submenu',
          labelKey: 'tweaks.keepAlive',
          hintKey: 'tweaks.keepAlive.hint',
          sub: 'keepalive',
          /* The init script is always on once the service is root, so "Init"
             follows the privileges and not a stored switch. */
          status: function () {
            var parts = [];
            if (window.Store && window.Store.get('keepaliveSelfService', true)) {
              parts.push('Service');
            }
            if (device.service && device.service.root) {
              parts.push('Init');
            }
            return parts.length ? parts.join(' + ') : '';
          }
        },
        /* Make the remote's HOME button open the dock. Two independent ways,
           both root-only and both reversible; the dock is the only target. */
        { id: 'homeGroup', type: 'group', labelKey: 'tweaks.home' },
        {
          id: 'homeHook',
          type: 'toggle',
          labelKey: 'tweaks.home.hook',
          hintKey: 'tweaks.home.hook.hint',
          def: false,
          read: function (cb) { cb(homeState.hook); },
          write: function (value, cb) { writeHome('hook', value, cb); },
          available: function () {
            return (device.service && device.service.root) ? '' : t('tweaks.needRoot');
          }
        },
        {
          id: 'homeSetting',
          type: 'toggle',
          labelKey: 'tweaks.home.setting',
          hintKey: 'tweaks.home.setting.hint',
          def: false,
          read: function (cb) { cb(homeState.setting); },
          write: function (value, cb) { writeHome('setting', value, cb); },
          available: function () {
            return (device.service && device.service.root) ? '' : t('tweaks.needRoot');
          }
        },
        {
          id: 'tweaksAppType',
          type: 'select',
          labelKey: 'tweaks.appType',
          hintKey: 'tweaks.appType.hint',
          def: 'popup',
          options: [
            { value: 'popup', labelKey: 'tweaks.appType.popup' },
            { value: 'overlay', labelKey: 'tweaks.appType.overlay' },
            { value: 'card', labelKey: 'tweaks.appType.card' },
            { value: 'minimal', labelKey: 'tweaks.appType.minimal.danger' },
            { value: 'home', labelKey: 'tweaks.appType.home.danger' },
            { value: 'system_ui', labelKey: 'tweaks.appType.system_ui.danger' }
          ],
          read: function (cb) {
            cb(window.Store.get('tweaksAppType', 'popup'));
          },
          write: function (v, cb) {
            window.Store.set('tweaksAppType', v);
            Luna.patchAppInfo(undefined, v, function (ok, info) {
              if (!ok) {
                cb(false, info);
                return;
              }
              window.Menu.toast(t('toast.appRestart'));
              cb(true, info);
            });
          },
          available: function () {
            var device = window.Platform.deviceInfo();
            return (device.service && device.service.root) ? '' : t('tweaks.needRoot');
          }
        }
      ]
    },

    /* The text of about.html, the version, and the way back to a fresh install.
       The rows are rebuilt by buildAboutItems() once the file has been read, so
       the list starts out with the head alone. pinBottom takes the section to
       the foot of the rail. */
    {
      id: 'about',
      icon: ICON.about,
      pinBottom: true,
      titleKey: 'section.about',
      shortKey: 'section.about.short',
      subKey: 'section.about.sub',
      items: [],
      load: function (done) { loadAbout(done); }
    }
  ];

  /* Nested levels, reached from a `submenu` item instead of from the rail.
     `items` is rebuilt from live data where it starts out empty. */
  var subsections = [
    /* The foot of the dock: three places to choose a command for, then the fourth
       button, which is Settings or the Submenu. Buttons 1 and 2 are only there from two columns
       up (one column has room for two buttons), which the hints say. */
    {
      id: 'quick',
      parentId: 'look',
      entryId: 'dockQuick',
      titleKey: 'dock.quick',
      subKey: 'dock.quick.sub',
      items: [
        quickItem(1, 'dock.quick.hint.wide'),
        quickItem(2, 'dock.quick.hint.wide'),
        quickItem(3, 'dock.quick.hint.near'),
        /* Settings (the default) or the Submenu. With the Submenu the Settings
           window is reached only through an item of it, which submenuItems()
           keeps in the column whatever the places hold; the hint says so. */
        {
          id: 'dockQuick4',
          type: 'select',
          labelKey: 'dock.quick.b4',
          hintKey: 'dock.quick.hint.b4',
          def: DEF_QUICK4,
          options: [
            { value: 'settings', labelKey: 'dock.settings' },
            { value: 'submenu', labelKey: 'dock.submenu' }
          ],
          write: function (value, cb) {
            applyQuick4();
            cb(true, { local: true });
          }
        },
        /* What the Submenu button opens: eight places from the top, each may stay
           empty (all of them empty: the column holds the dock's Settings only). */
        { id: 'dockSubGroup', type: 'group', labelKey: 'dock.submenu' },
        subItem(1), subItem(2), subItem(3), subItem(4), subItem(5), subItem(6), subItem(7), subItem(8)
      ]
    },
    /* The levels of Appearance. Their rows keep the ids they had on the one long page,
       so a stored value is still read. */
    {
      id: 'theme',
      parentId: 'look',
      entryId: 'lookTheme',
      titleKey: 'look.theme',
      subKey: 'look.theme.sub',
      items: [
        /* Two switches instead of one list of palettes: the mode and the
           contrast are separate questions, and high contrast has a light and a
           dark side of its own. */
        {
          id: 'appDarkMode',
          type: 'toggle',
          labelKey: 'app.darkMode',
          hintKey: 'app.darkMode.hint',
          def: true,
          write: function (value, cb) {
            applyTheme();
            cb(true, { local: true });
          }
        },
        {
          id: 'appContrast',
          type: 'toggle',
          labelKey: 'app.contrast',
          hintKey: 'app.contrast.hint',
          def: false,
          write: function (value, cb) {
            applyTheme();
            cb(true, { local: true });
          }
        },
        {
          id: 'appAccent',
          type: 'select',
          labelKey: 'app.accent',
          hintKey: 'app.accent.hint',
          def: DEF_ACCENT,
          options: ACCENTS,
          write: function (value, cb) {
            applyAccent();
            cb(true, { local: true });
          }
        }
      ]
    },
    {
      id: 'bg',
      parentId: 'look',
      entryId: 'lookBg',
      titleKey: 'look.bg',
      subKey: 'look.bg.sub',
      items: [
        /* Pictures over the palette, one file per column per theme (see
           app.css). The dock and the rows of this window are the "main" column,
           the icon rail of this window the second one. How solid they are is the
           whole setting, the bottom of a slider being no picture at all. One
           slider per column, because the two columns are not the same job: a
           picture that is pleasant behind the icons is usually too much behind
           the text. */
        {
          id: 'appBg',
          type: 'slider',
          labelKey: 'app.bg',
          hintKey: 'app.bg.hint',
          def: DEF_BG,
          min: MIN_BG,
          max: MAX_BG,
          step: BG_STEP,
          write: function (value, cb) {
            applyBg();
            cb(true, { local: true });
          }
        },
        {
          id: 'appBgRail',
          type: 'slider',
          labelKey: 'app.bgRail',
          hintKey: 'app.bgRail.hint',
          def: DEF_BG,
          min: MIN_BG,
          max: MAX_BG,
          step: BG_STEP,
          write: function (value, cb) {
            applyBgRail();
            cb(true, { local: true });
          }
        },
        {
          id: 'appTransparency',
          type: 'slider',
          labelKey: 'app.transparency',
          hintKey: 'app.transparency.hint',
          def: DEF_TRANSPARENCY,
          min: MIN_TRANSPARENCY,
          max: MAX_TRANSPARENCY,
          step: TRANSPARENCY_STEP,
          write: function (value, cb) {
            applyTransparency();
            cb(true, { local: true });
          }
        }
      ]
    },
    {
      id: 'dock',
      parentId: 'look',
      entryId: 'dockLayout',
      titleKey: 'section.dock',
      subKey: 'look.dock.sub',
      items: [
        {
          id: 'dockColumns',
          type: 'select',
          labelKey: 'dock.columns',
          hintKey: 'dock.columns.hint',
          def: DEF_COLUMNS,
          /* Numbers, like the rows below: the count is what is being chosen. */
          options: COLUMNS.map(function (n) { return { value: n, label: n }; }),
          write: function (value, cb) {
            applyColumns();
            cb(true, { local: true });
          }
        },
        {
          id: 'dockRows',
          type: 'select',
          labelKey: 'dock.rows',
          hintKey: 'dock.rows.hint',
          def: String(DEF_ROWS),
          /* A short list, so a dropdown like the columns rather than a slider:
             the number itself matters here (unlike the opacity, where the fill
             of the track is the readout). Values are strings, as a select
             compares them against the option's attribute text. */
          options: (function () {
            var out = [];
            for (var n = MIN_ROWS; n <= MAX_ROWS; n++) out.push({ value: String(n), label: String(n) });
            return out;
          })(),
          write: function (value, cb) {
            applyRows();
            cb(true, { local: true });
          }
        },
        {
          id: 'dockSide',
          type: 'select',
          labelKey: 'dock.side',
          hintKey: 'dock.side.hint',
          def: DEF_SIDE,
          options: [
            { value: 'left', labelKey: 'align.left' },
            { value: 'right', labelKey: 'align.right' }
          ],
          write: function (value, cb) {
            applySide();
            cb(true, { local: true });
          }
        },
        {
          id: 'dockOffsetX',
          type: 'slider',
          labelKey: 'dock.offsetX',
          hintKey: 'dock.offsetX.hint',
          def: DEF_OFFSET_X,
          min: MIN_OFFSET_X,
          max: MAX_OFFSET_X,
          step: OFFSET_STEP,
          write: function (value, cb) {
            applyOffsetX();
            cb(true, { local: true });
          }
        },
        {
          id: 'dockOffsetY',
          type: 'slider',
          labelKey: 'dock.offsetY',
          hintKey: 'dock.offsetY.hint',
          def: DEF_OFFSET_Y,
          min: MIN_OFFSET_Y,
          max: MAX_OFFSET_Y,
          step: OFFSET_STEP,
          write: function (value, cb) {
            applyOffsetY();
            cb(true, { local: true });
          }
        },
        {
          id: 'dockEffect',
          type: 'select',
          labelKey: 'dock.effect',
          hintKey: 'dock.effect.hint',
          def: DEF_DOCK_EFFECT,
          options: DOCK_EFFECTS,
          write: function (value, cb) {
            applyDockEffect();
            cb(true, { local: true });
          }
        }
      ]
    },
    /* Where the balloon lands: two questions — the edge and the side of it —
       which together are the six corners and centres of the screen. */
    {
      id: 'toasts',
      parentId: 'look',
      entryId: 'lookToast',
      titleKey: 'toasts.title',
      subKey: 'look.toasts.sub',
      items: [
        {
          id: 'appToastTop',
          type: 'toggle',
          labelKey: 'app.toastTop',
          hintKey: 'app.toastTop.hint',
          def: true,
          write: function (value, cb) {
            applyToast();
            /* Shown right away: the setting is about a thing that is normally
               only on screen for two seconds. */
            window.Menu.toast(t('toast.applied'));
            cb(true, { local: true });
          }
        },
        {
          id: 'appToastAlign',
          type: 'select',
          labelKey: 'app.toastAlign',
          hintKey: 'app.toastAlign.hint',
          def: 'center',
          options: [
            { value: 'left', labelKey: 'align.left' },
            { value: 'center', labelKey: 'align.center' },
            { value: 'right', labelKey: 'align.right' }
          ],
          write: function (value, cb) {
            applyToast();
            window.Menu.toast(t('toast.applied'));
            cb(true, { local: true });
          }
        }
      ]
    },
    /* The names of the tiles: the switch, then how long, where, in what style and
       with what effect, then the two colour switches. The rows keep the ids of the
       days they sat in Appearance, so a stored timing or place is still read. */
    {
      id: 'hints',
      parentId: 'look',
      entryId: 'dockHints',
      titleKey: 'hints.title',
      subKey: 'hints.sub',
      items: [
        /* Three switches, one for each kind of tile: the apps of the list, the
           quick buttons of the foot (Settings among them), and the items of the
           submenu. Off for the apps and the quick buttons, on for the submenu in a
           fresh install. */
        {
          id: 'dockHintsApps',
          type: 'toggle',
          labelKey: 'hints.forApps',
          def: DEF_HINTS_APPS,
          write: hintsWrite
        },
        {
          id: 'dockHintsQuick',
          type: 'toggle',
          labelKey: 'hints.forQuick',
          def: DEF_HINTS_QUICK,
          write: hintsWrite
        },
        {
          id: 'dockHintsSub',
          type: 'toggle',
          labelKey: 'hints.forSubmenu',
          def: DEF_HINTS_SUB,
          write: hintsWrite
        },
        /* A count of seconds rather than a switch: some want the name only as a
           glimpse, some long enough to read. */
        {
          id: 'dockLabels',
          type: 'select',
          labelKey: 'dock.labels',
          hintKey: 'dock.labels.hint',
          def: String(DEF_LABEL_SEC),
          options: LABEL_SEC.map(secOption),
          write: hintsWrite
        },
        /* Where the name stands. Beside the dock is the default, which leaves the
           tiles uncovered; the icon is for those who want the name against it. */
        {
          id: 'dockLabelPlace',
          type: 'select',
          labelKey: 'dock.labelPlace',
          hintKey: 'dock.labelPlace.hint',
          def: DEF_LABEL_PLACE,
          options: [
            { value: 'tile', labelKey: 'dock.labelPlace.tile' },
            { value: 'dock', labelKey: 'dock.labelPlace.dock' }
          ],
          write: hintsWrite
        },
        {
          id: 'dockLabelStyle',
          type: 'select',
          labelKey: 'hints.style',
          def: DEF_HINT_STYLE,
          options: HINT_STYLES,
          write: hintsWrite
        },
        {
          id: 'dockLabelEffect',
          type: 'select',
          labelKey: 'hints.effect',
          def: DEF_HINT_EFFECT,
          options: HINT_EFFECTS,
          write: hintsWrite
        },
        /* The accent colour of the theme, for the letters and for the frame: each
           its own switch. The Solid style is filled with it and takes neither. */
        {
          id: 'dockLabelText',
          type: 'toggle',
          labelKey: 'hints.colourText',
          hintKey: 'hints.colourText.hint',
          def: false,
          write: hintsWrite
        },
        {
          id: 'dockLabelBorder',
          type: 'toggle',
          labelKey: 'hints.colourBorder',
          hintKey: 'hints.colourBorder.hint',
          def: false,
          write: hintsWrite
        }
      ]
    },
    /* The clock of the dock: two selects whose every option is the current
       moment written that way, then how the two bands are painted. */
    {
      id: 'clock',
      parentId: 'common',
      entryId: 'appClock',
      titleKey: 'clock.title',
      subKey: 'clock.sub',
      items: [
        {
          id: 'appTimeFormat',
          type: 'select',
          labelKey: 'app.timeFormat',
          hintKey: 'app.timeFormat.hint',
          def: '24h',
          options: [offOption()].concat(formatOptions(TIME_FORMATS, formatTime)),
          write: clockWrite
        },
        sizeItem('appClockSize', 'app.clockSize'),
        {
          id: 'appDateFormat',
          type: 'select',
          labelKey: 'app.dateFormat',
          hintKey: 'app.dateFormat.hint',
          def: DEF_DATE_FORMAT,
          options: [offOption()].concat(formatOptions(DATE_FORMATS, formatDate)),
          write: clockWrite
        },
        sizeItem('appDateSize', 'app.dateSize'),
        {
          id: 'appClockColour',
          type: 'toggle',
          labelKey: 'app.clockColour',
          hintKey: 'app.clockColour.hint',
          def: true,
          write: clockWrite
        },
        {
          id: 'appDateColour',
          type: 'toggle',
          labelKey: 'app.dateColour',
          hintKey: 'app.dateColour.hint',
          def: true,
          write: clockWrite
        },
        /* One switch for both bands: a bold clock over a light date would only
           ever be a mistake somebody had to undo. On by default: thin type
           over a moving picture is the first thing to get lost. */
        {
          id: 'appClockBold',
          type: 'toggle',
          labelKey: 'app.clockBold',
          hintKey: 'app.clockBold.hint',
          def: true,
          write: clockWrite
        }
      ]
    },
    {
      id: 'switchAppId',
      parentId: 'tweaks',
      entryId: 'switchAppId',
      titleKey: 'tweaks.switchAppId.title',
      subKey: 'tweaks.switchAppId.sub',
      items: [],
      load: function (api, announce) {
        buildSwitchAppIdItems();
        if (announce) announce(false);
      }
    },
    {
      id: 'keepalive',
      parentId: 'tweaks',
      entryId: 'tweaksKeepAlive',
      titleKey: 'tweaks.keepAlive',
      subKey: 'tweaks.keepAlive.sub',
      items: [
        {
          id: 'keepaliveSelfService',
          type: 'toggle',
          labelKey: 'tweaks.keepAlive.selfService',
          hintKey: 'tweaks.keepAlive.selfService.hint',
          def: true,
          read: function (cb) {
            Luna.selfKeepaliveStatus(function (status, info) {
              if (info.mocked) {
                cb(!!window.Store.get('keepaliveSelfService', true));
                return;
              }
              cb(status.enabled);
            });
          },
          write: function (value, cb) {
            if (value) {
              Luna.enableSelfKeepalive(function (success, info) {
                if (!success) {
                  var msg = info.error || 'Enable failed';
                  cb(false, { error: msg });
                  return;
                }
                window.Store.set('keepaliveSelfService', true);
                window.Menu.toast(t('toast.keepaliveSelfEnabled'));
                cb(true);
              });
            } else {
              Luna.disableSelfKeepalive(function (success, info) {
                if (!success) {
                  var msg = info.error || 'Disable failed';
                  cb(false, { error: msg });
                  return;
                }
                window.Store.set('keepaliveSelfService', false);
                window.Menu.toast(t('toast.keepaliveSelfDisabled'));
                cb(true);
              });
            }
          }
        }
      ]
    }
  ];

  /* ------------------------------------------------------------ indexing -- */
  var index = {};
  var sectionOf = {};

  /* Rebuilt whenever a level generates items (About, Switch app ID). */
  function reindex() {
    index = {};
    sectionOf = {};
    sections.concat(subsections).forEach(function (level) {
      level.items.forEach(function (item) {
        index[item.id] = item;
        sectionOf[item.id] = level.id;
      });
    });
  }

  function subsection(id) {
    for (var i = 0; i < subsections.length; i++) {
      if (subsections[i].id === id) return subsections[i];
    }
    return null;
  }

  reindex();

  /* ------------------------------------------------------------- values --- */
  function value(id) {
    var item = index[id];
    if (!item) return undefined;
    return window.Store.get(id, item.def);
  }

  /* Store locally, then push to the TV when the item knows how to. */
  function commit(id, newValue, cb) {
    var item = index[id];
    if (!item) return;
    window.Store.set(id, newValue);
    if (!item.write) {
      if (cb) cb(true, { mocked: !Luna.isAvailable(), error: null, local: true });
      return;
    }
    item.write(newValue, function (ok, info) {
      if (cb) cb(ok, info || {});
    });
  }

  /* Pull fresh values for one section; done() runs once, after the last read.
     A section may also carry load() of its own — that is how the read-only
     blocks (About) get their data, since they have no items to read. */
  function refresh(sectionId, done) {
    var section = null;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].id === sectionId) { section = sections[i]; break; }
    }
    if (!section) { if (done) done(false); return; }

    /* Collected before anything runs: a mocked luna call answers straight away,
       and a counter raised on the fly would reach zero after the first one. */
    var tasks = [];

    section.items.forEach(function (item) {
      if (!item.read) return;
      tasks.push(function (step) {
        item.read(function (remote) {
          var differs = remote !== null && typeof remote !== 'undefined' && remote !== value(item.id);
          if (differs) window.Store.set(item.id, remote);
          step(differs);
        });
      });
    });

    if (section.load) tasks.push(function (step) { section.load(step); });

    var pending = tasks.length;
    var changed = false;
    if (!pending) { if (done) done(false); return; }

    tasks.forEach(function (task) {
      task(function (didChange) {
        if (didChange) changed = true;
        pending--;
        if (pending === 0 && done) done(changed);
      });
    });
  }

  /* ------------------------------------------------------------- labels --- */
  function label(item) {
    return item.labelKey ? t(item.labelKey) : (item.label || '');
  }

  function hint(item) {
    return item.hintKey ? t(item.hintKey) : (item.hint || '');
  }

  /* A label may be a function when it has to be built fresh every render; a
     plain `label` is data that needs no translation (the app IDs of Tweaks). */
  function optionLabel(option) {
    if (typeof option.label === 'function') return option.label();
    return option.labelKey ? t(option.labelKey) : (option.label || String(option.value));
  }

  /* Sliders are absent on purpose: their row carries no text at all, the filled
     part of the track says where the value sits (see Menu.rowInner). */
  function formatValue(item) {
    var v = value(item.id);
    if (item.type === 'toggle') return v ? t('value.on') : t('value.off');
    if (item.type === 'select') {
      for (var i = 0; i < item.options.length; i++) {
        if (item.options[i].value === v) return optionLabel(item.options[i]);
      }
      return String(v);   // TV reported a value that is not in our list
    }
    return '';
  }

  /* How the privileged actions will be executed, as reported by the helper. */
  function privilegeLabel() {
    if (!window.Platform.isWebOS) return t('value.privNone');
    if (!device.service) return t('value.privUnknown');
    if (!device.service.running) return t('value.privNoService');
    return device.service.root ? t('value.privRoot') : t('value.privLimited');
  }

  function infoHtml(rows) {
    return rows.map(function (row) {
      return '<div><b>' + row[0] + ':</b> ' + row[1] + '</div>';
    }).join('');
  }

  /* Shown in the Tweaks section, next to "Request privileges". */
  function privilegeInfoHtml() {
    var running = !!(device.service && device.service.running);
    return infoHtml([
      [t('info.service'), running ? t('value.svcUp') : t('value.svcDown')],
      [t('info.privileges'), privilegeLabel()]
    ]);
  }

  /* -------------------------------------------------------------- about ---- */
  /* The text of the About section is not in the code: about.html is a plain HTML
     fragment packaged with the app, so the author, the project links and the
     community can be edited without touching JavaScript. The version comes from
     appinfo.json, the same file the TV reads. */
  var about = { html: null, version: null, loading: false, failed: false };

  function aboutHeadHtml() {
    return infoHtml([
      [t('info.app'), t('app.title')],
      [t('info.version'), or(about.version)]
    ]);
  }

  /* Nothing here takes the focus (the reset lives in Common): ▲ ▼ scroll the
     text of about.html. */
  function buildAboutItems() {
    var items = [
      { id: 'aboutHead', type: 'info', render: function () { return aboutHeadHtml(); } }
    ];

    if (about.html) {
      items.push({
        id: 'aboutText',
        type: 'info',
        /* Our own packaged file, so it goes in as markup on purpose. */
        render: function () { return '<div class="about">' + about.html + '</div>'; }
      });
    } else if (about.loading) {
      items.push({ id: 'aboutLoading', type: 'info', render: function () { return '<div>' + t('about.loading') + '</div>'; } });
    } else if (about.failed) {
      items.push({ id: 'aboutFailed', type: 'info', render: function () { return '<div>' + t('about.failed') + '</div>'; } });
    }

    sectionById('about').items = items;
    reindex();
  }

  /* Read once and kept: the file cannot change while the app runs. done(changed)
     is the section's load callback — true makes the window repaint the rows. */
  function loadAbout(done) {
    if (about.loading || about.html || about.failed) { if (done) done(false); return; }
    about.loading = true;
    buildAboutItems();

    var pending = 3;
    var htmlText = null;
    var appId = null;
    function step() {
      pending--;
      if (pending) return;
      /* {APP_ID} in the text stands for the ID the app runs under (it changes
         when the app is installed under another ID). The default is the ID the
         package ships with. */
      about.html = htmlText ? htmlText.split('{APP_ID}').join(appId || 'webocu.dock') : htmlText;
      about.loading = false;
      about.failed = !about.html;
      if (about.failed) console.warn('[webocu-dock] about.html could not be read');
      buildAboutItems();
      if (done) done(true);
    }

    window.Platform.loadText('about.html', function (text) {
      htmlText = text ? String(text) : null;
      step();
    });
    window.Platform.appInfo(function (info) {
      about.version = (info && info.version) || null;
      step();
    });
    window.Platform.getAppId(function (id) {
      appId = id;
      step();
    });
  }

  function sectionById(id) {
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].id === id) return sections[i];
    }
    return null;
  }

  buildAboutItems();

  /* ------------------------------------------------------- applications --- */
  /* One row per user app, on unless switched off and in the order the user put
     them: the show switch is "appShow:" + the id, the order is one list of ids
     in "appOrder". Both key by id, so an app keeps its place across reinstalls
     and across reads of a list that changed. The rows are only as fresh as the
     last read, which is why the first row reads again. */
  var SHOW_PREFIX = 'appShow:';
  /* The last list the dock read, so a reorder has something to work on between
     reads without asking the TV again. */
  var appsData = { list: [] };

  /* App names come from other packages, so they are escaped before the row
     puts them into innerHTML. */
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* The stored order, as a list of ids; '' (fresh install) means "by title". */
  function orderList() {
    var raw = String(window.Store.get('appOrder', ''));
    if (!raw) return [];
    return raw.split(',').filter(function (id) { return id; });
  }

  /* A list of apps in the user's order: the ones named in appOrder first, in that
     order, then anything new in the order it came in (the dock sorts by title, so
     that is alphabetical). Used by the Apps rows and by the dock alike. */
  function orderApps(list) {
    var order = orderList();
    if (!order.length) return list.slice();
    var byId = {};
    list.forEach(function (app) { byId[app.id] = app; });
    var out = [], seen = {};
    order.forEach(function (id) { if (byId[id] && !seen[id]) { out.push(byId[id]); seen[id] = true; } });
    list.forEach(function (app) { if (!seen[app.id]) out.push(app); });
    return out;
  }

  /* Move an app one step and remember the whole order. */
  function moveApp(id, delta) {
    var ordered = orderApps(appsData.list), ids = ordered.map(function (a) { return a.id; });
    var at = ids.indexOf(id), to = at + delta;
    if (at < 0 || to < 0 || to >= ids.length) return false;
    var tmp = ids[at]; ids[at] = ids[to]; ids[to] = tmp;
    window.Store.set('appOrder', ids.join(','));
    return true;
  }

  function setAppShown(id, on) {
    window.Store.set(SHOW_PREFIX + id, !!on);
  }

  /* Whether the TV needs pairing before the list is readable: only when the
     helper service is there but not root (a root service reads the list itself).
     In a desktop browser there is no service, so the row shows for testing. */
  function needsPairing() {
    return !(device.service && device.service.root);
  }

  /* list: undefined while the first read is under way, null when it failed,
     otherwise the user apps as the dock sees them (Dock.load). */
  function buildAppsItems(list) {
    appsData.list = (list && list.length) ? list.slice() : [];
    var items = [{
      /* The way to the TV's Home when no quick button of the dock opens
         it. First, and built before the list is known, so it is
         there when the read failed — which is when it is wanted most. */
      id: 'appsHome',
      type: 'action',
      labelKey: 'apps.home',
      hintKey: 'apps.home.hint',
      run: function (api) {
        var name = t('dock.home');
        api.busy(t('toast.launching', { name: name }));
        Luna.launch(HOME_APP, function (ok, info) {
          /* Leaves the app the way a click on the picture does. */
          if (ok) {
            window.Menu.hideToast();
            window.Menu.close();
            document.dispatchEvent(new CustomEvent('app:exit'));
            return;
          }
          if (info && info.mocked) { api.toast(t('toast.mock')); return; }
          api.toast(t('toast.launchFailed', { name: name }));
        });
      }
    }, {
      id: 'appsRefresh',
      type: 'action',
      labelKey: 'apps.refresh',
      hintKey: 'apps.refresh.hint',
      /* Where the list on screen came from: root service, the app manager
         asked directly, or the paired second-screen link. */
      status: function () {
        var via = window.Dock.source();
        return (via === 'service' || via === 'appmgr' || via === 'ssap' || via === 'mock') ? t('apps.via.' + via) : '';
      },
      run: function (api) {
        api.busy(t('dock.loading'));
        /* Forced: the one way past the cache of the list (and pairing below). */
        loadApps(function () {
          api.rerender();
          api.toast(t('apps.refreshed'));
        }, true);
      }
    }];

    /* Pairing with the TV, when root is not there to read the list directly. */
    if (needsPairing()) {
      if (Luna.ssapPaired()) {
        items.push({
          id: 'appsUnpair',
          type: 'action',
          labelKey: 'apps.unpair',
          hintKey: 'apps.unpair.hint',
          run: function (api) {
            Luna.forgetSsap();
            api.busy(t('dock.loading'));
            loadApps(function () { api.rerender(); api.toast(t('apps.unpaired')); }, true);
          }
        });
      } else {
        items.push({
          id: 'appsPair',
          type: 'action',
          labelKey: 'apps.pair',
          hintKey: 'apps.pair.hint',
          run: function (api) {
            api.busy(t('apps.pairing'));
            Luna.ssapPair(function (ok) {
              if (!ok) { api.toast(t('apps.pairFailed')); return; }
              loadApps(function () { api.rerender(); api.toast(t('apps.refreshed')); }, true);
            });
          }
        });
      }
    }

    if (list === undefined) {
      items.push({ id: 'appsLoading', type: 'info', render: function () { return '<div>' + t('dock.loading') + '</div>'; } });
    } else if (list === null) {
      items.push({ id: 'appsFailed', type: 'info', render: function () { return '<div>' + t('dock.failed') + '</div>'; } });
    } else if (!list.length) {
      items.push({ id: 'appsEmpty', type: 'info', render: function () { return '<div>' + t('dock.empty') + '</div>'; } });
    } else {
      items.push({ id: 'appsGroup', type: 'group', labelKey: 'apps.list' });
      /* The TV's inputs are rows like any app, after them: read in the same
         go (Dock.load), switched off until asked for. */
      orderApps(list).forEach(function (app) {
        var appId = app.id;
        var byDefault = !app.isInput;
        items.push({
          id: SHOW_PREFIX + appId,
          type: 'reorder',
          label: escapeHtml(app.title || appId),
          /* The footer writes hints as text, so the id needs no escaping. */
          hint: appId,
          /* The switch of the row. */
          on: function () { return isShown(appId, byDefault); },
          setOn: function (want) { setAppShown(appId, want); window.Dock.relabel(); return true; },
          /* ▲ ▼ while held: move the app and rebuild the list in the new order. */
          move: function (delta) {
            if (!moveApp(appId, delta)) return false;
            buildAppsItems(appsData.list);
            window.Dock.relabel();
            return true;
          }
        });
      });
    }

    sectionById('apps').items = items;
    reindex();
  }

  /* done(changed) is the section's load callback, as for About. `force` reads
     the TV instead of the dock's cache. */
  function loadApps(done, force) {
    window.Dock.load(function (list) {
      buildAppsItems(list);
      if (done) done(true);
    }, force);
  }

  buildAppsItems(undefined);

  /* Whether the dock shows an app: the switch above, or a URL preview. `def`
     is what an item never switched is: on for an app, off for a TV input
     (dock.js passes !isInput). A preview only takes away. */
  function isShown(id, def) {
    var fallback = def !== false;
    if (hiddenPreview) return fallback && hiddenPreview.indexOf(id) < 0;
    return window.Store.get(SHOW_PREFIX + id, fallback) !== false;
  }

  /* ?hide=id1,id2 — the dock without those apps, nothing stored. */
  function previewHidden(spec) {
    hiddenPreview = [];
    String(spec).split(',').forEach(function (id) {
      id = id.replace(/^\s+|\s+$/g, '');
      if (id) hiddenPreview.push(id);
    });
    return true;
  }

  /* ---------------------------------------------------------- switch app ID -- */
  /* Get current app ID. */
  function getCurrentAppId() {
    /* Try to read from PalmSystem first, fallback to default. */
    var sys = window.webOSSystem || window.PalmSystem || null;
    if (sys && sys.identifier) {
      return String(sys.identifier);
    }
    return 'webocu.dock';
  }

  /* Proceed with app ID switch after removal check. */
  function proceedWithSwitch(api, appId) {
    api.busy(t('toast.switchingAppId'));
    Luna.switchAppId(appId, function (ok, info) {
      if (ok) {
        console.log('[switch-app-id] Switch succeeded');
        api.toast(t('toast.appIdSwitchedRebootNeeded'));
      } else {
        api.toast(t('toast.appIdFailed'));
        if (info && info.output) console.warn('[webocu-dock] switch-app-id output:', info.output);
      }
    });
  }

  function buildSwitchAppIdItems() {
    var items = [];

    /* Show warning info if root is not available. */
    if (!device.service || !device.service.root) {
      items.push({
        id: 'switchIdWarning',
        type: 'info',
        render: function () {
          return '<div>' + t('tweaks.switchAppId.needRoot') + '</div>';
        }
      });
    }

    /* App names are brands, not translatable UI strings. */
    var ids = [
      { id: 'webocu.dock', label: 'WebOCU Dock' },
      { id: 'amazon', label: 'Amazon Prime Video' },
      { id: 'netflix', label: 'Netflix' },
      { id: 'ivi', label: 'ivi' },
      { id: 'yota.play', label: 'Okko' },
      { id: 'com.685631.3411', label: 'Kinopoisk' },
      { id: 'com.huawei.app.webos.mts.tv.production', label: 'KION' },
      { id: 'vkvideo', label: 'VK Video' }
    ];

    var currentAppId = getCurrentAppId();

    if (device.service && device.service.root) {
      /* Select list of app IDs. */
      items.push({
        id: 'appIdSelect',
        type: 'select',
        labelKey: 'tweaks.appId',
        def: currentAppId,
        options: ids.map(function (entry) {
          return { value: entry.id, label: entry.label };
        }),
        write: function (selectedId, cb) {
          /* Store selection locally only. */
          cb(true, { local: true });
        }
      });

      /* Apply button. */
      items.push({
        id: 'appIdApply',
        type: 'action',
        labelKey: 'tweaks.applyAppId',
        run: function (api) {
          var selectedId = value('appIdSelect') || currentAppId;
          console.log('[switch-app-id] Apply clicked, selectedId=' + selectedId + ', currentAppId=' + currentAppId);

          /* Check if trying to switch to the current ID. */
          if (selectedId === currentAppId) {
            console.log('[switch-app-id] Same ID selected, showing toast');
            api.toast(t('toast.appIdAlreadyCurrent'));
            return;
          }

          /* Show brief notification (checkAppExists takes 3-10s, toast will auto-hide). */
          api.toast(t('toast.checkingApp'));

          console.log('[switch-app-id] Calling checkAppExists for "' + selectedId + '"');
          /* First, check if an app with this ID already exists. */
          Luna.checkAppExists(selectedId, function (exists, appInfo) {
            console.log('[switch-app-id] checkAppExists result: exists=' + exists +
                        ', appInfo=' + (appInfo ? JSON.stringify(appInfo) : 'null'));
            if (exists) {
              /* App exists — show warning, user must remove it manually. */
              console.log('[switch-app-id] App exists, showing warning');
              api.toast(t('toast.appExistsRemoveManually'));
            } else {
              /* App doesn't exist, ask for confirmation to switch. */
              console.log('[switch-app-id] App does not exist, asking for confirmation');
              Dialog.show(t('tweaks.confirmSwitchAppId', { id: selectedId }), function () {
                /* armed by the user — confirmation shown. */
                proceedWithSwitch(api, selectedId);
              }, function () {
                console.log('[switch-app-id] User cancelled switch');
              });
            }
          });
        }
      });
    } else {
      /* Show as read-only list when root is not available. */
      ids.forEach(function (entry) {
        var isCurrent = entry.id === currentAppId;
        var entryLabel = entry.label;
        var checkmark = isCurrent ? ' ✓' : '';
        items.push({
          id: 'switchTo_' + entry.id.replace(/\./g, '_') + '_disabled',
          type: 'info',
          render: function () {
            return '<div>' + entryLabel + checkmark + '</div>';
          }
        });
      });
    }

    subsection('switchAppId').items = items;
    reindex();
  }

  buildSwitchAppIdItems();


  /* ------------------------------------------------- the app's own prefs --- */
  var MODES = ['dark', 'light'];
  var ALIGNS = ['left', 'center', 'right'];

  /* What sits on <html> right now. Kept because a preview param changes one half
     of the theme and has to leave the other half where it was. */
  var themeNow = { mode: 'dark', contrast: false };

  /* The app starts in English and only the stored choice changes it: the TV
     locale is never read, so it does not switch the UI. Generated rows render
     their text when they are drawn, so nothing has to be rebuilt here. */
  function applyLanguage() {
    return window.I18N.setLang(window.Store.get('appLanguage', 'en'));
  }

  /* The theme is two independent switches: the mode picks the surfaces, and the
     contrast switch replaces them with plain black or plain white. Both live on
     <html> — the CSS at the end of app.css is the only thing that knows what the
     four combinations look like. */
  function applyTheme() {
    setTheme(window.Store.get('appDarkMode', true) ? 'dark' : 'light',
             !!window.Store.get('appContrast', false));
  }

  function setTheme(mode, contrast) {
    themeNow.mode = MODES.indexOf(mode) < 0 ? 'dark' : mode;
    themeNow.contrast = contrast;
    document.documentElement.setAttribute('data-theme', themeNow.mode);
    /* Written as "off" rather than removed: one attribute to read, whichever
       state it is in. */
    document.documentElement.setAttribute('data-contrast', contrast ? 'on' : 'off');
  }

  function accentHex(name) {
    for (var i = 0; i < ACCENTS.length; i++) {
      if (ACCENTS[i].value === name) return ACCENTS[i].swatch;
    }
    return null;
  }

  /* --accent is written straight onto <html>, so it wins over the palette that
     the stylesheet picked: the chosen colour holds on dark, light and contrast
     alike. Everything accented reads that one variable, nothing else changes. */
  function applyAccent() {
    setAccent(window.Store.get('appAccent', DEF_ACCENT));
  }

  function setAccent(name) {
    var hex = accentHex(name) || accentHex(DEF_ACCENT);
    document.documentElement.style.setProperty('--accent', hex);
  }

  /* How much of a column is painted from img/*.png rather than from the palette.
     One variable and one attribute per column, and the stylesheet holds every
     path: which of the four files a column takes follows the theme, so nothing
     here needs to know their names. "appBg" is the main column (the dock and the
     rows of the window), "appBgRail" the icon rail of the window. */
  function applyBg() {
    var stored = window.Store.get('appBg', DEF_BG);
    var step = nearestBg(stored);
    if (step !== stored) window.Store.set('appBg', step);
    setBg(step);
  }

  function applyBgRail() {
    var stored = window.Store.get('appBgRail', DEF_BG);
    var step = nearestBg(stored);
    if (step !== stored) window.Store.set('appBgRail', step);
    setBgRail(step);
  }

  function setBg(percent) {
    var share = nearestBg(percent);
    document.documentElement.style.setProperty('--bg-opacity', String(share / 100));
    /* Off rather than a picture at nothing per cent: at the bottom of the range
       the column is painted from the palette again, and an invisible layer would
       still be a layer for the TV to composite behind everything else. */
    document.documentElement.setAttribute('data-bg', share > 0 ? 'on' : 'off');
  }

  function setBgRail(percent) {
    var share = nearestBg(percent);
    document.documentElement.style.setProperty('--bg-opacity-rail', String(share / 100));
    document.documentElement.setAttribute('data-bg-rail', share > 0 ? 'on' : 'off');
  }

  function nearestBg(percent) {
    return nearestStep(percent, MIN_BG, MAX_BG, BG_STEP, DEF_BG);
  }

  /* The whole overlay fades, not the panel background alone: the point of the
     setting is to see the picture through everything the app draws, rings and
     text included. The CSS keeps one variable and no rules of its own. */
  function applyTransparency() {
    var stored = window.Store.get('appTransparency', DEF_TRANSPARENCY);
    var step = nearestTransparency(stored);
    /* Pulled into the range in the store as well, so the knob on the row and
       the picture on screen agree even after a hand-edited localStorage. */
    if (step !== stored) window.Store.set('appTransparency', step);
    setTransparency(step);
  }

  /* The CSS keeps one variable, the opacity: what is not transparent. */
  function setTransparency(percent) {
    document.documentElement.style.setProperty('--ui-opacity', String((100 - nearestTransparency(percent)) / 100));
  }

  /* Snapped to the nearest stop and clamped to the range, so the floor of a
     slider is also the floor of what can ever be applied. Counted from the
     minimum, not from zero: the stops of a slider are min + n * step. */
  function nearestStep(value, min, max, step, def) {
    var number = Number(value);
    if (!isFinite(number)) return def;
    var snapped = min + Math.round((number - min) / step) * step;
    return Math.max(min, Math.min(max, snapped));
  }

  /* The stop of a short list that is nearest to the value (the smaller one when
     two are equally near), or `def` when the value is no number. A positive value
     skips the stop 0, which means "never": it is only reached by asking for 0. */
  function nearestOf(list, value, def) {
    var number = Number(value);
    if (!isFinite(number)) return def;
    var best = null;
    for (var i = 0; i < list.length; i++) {
      if (number > 0 && list[i] === 0) continue;
      if (best === null || Math.abs(list[i] - number) < Math.abs(best - number)) best = list[i];
    }
    return best;
  }

  function nearestTransparency(percent) {
    return nearestStep(percent, MIN_TRANSPARENCY, MAX_TRANSPARENCY, TRANSPARENCY_STEP, DEF_TRANSPARENCY);
  }

  /* The number of icon columns of the dock. Only the CSS knows the widths; the
     dock reads the attribute back (columns()) to know how far ▲ ▼ step. */
  function applyColumns() {
    setColumns(window.Store.get('dockColumns', DEF_COLUMNS));
  }

  function setColumns(value) {
    var cols = COLUMNS.indexOf(String(value)) < 0 ? DEF_COLUMNS : String(value);
    document.documentElement.setAttribute('data-cols', cols);
  }

  /* The edge of the screen the dock stands at: only the CSS needs it. */
  function applySide() {
    setSide(window.Store.get('dockSide', DEF_SIDE));
  }

  function setSide(value) {
    document.documentElement.setAttribute('data-side', SIDES.indexOf(value) < 0 ? DEF_SIDE : value);
  }

  function columns() {
    return Number(document.documentElement.getAttribute('data-cols')) || Number(DEF_COLUMNS);
  }

  /* Rows on screen and the vertical shift: dock.js asks for them when it draws
     (rows(), offsetY()), so they live in dockNow rather than in the CSS. */
  function applyRows() {
    var stored = window.Store.get('dockRows', DEF_ROWS);
    var step = nearestStep(stored, MIN_ROWS, MAX_ROWS, 1, DEF_ROWS);
    if (step !== stored) window.Store.set('dockRows', step);
    dockNow.rows = step;
  }

  /* The seconds of the name balloon (dock.js runs the timer). */
  function applyLabels() {
    var stored = window.Store.get('dockLabels', String(DEF_LABEL_SEC));
    dockNow.labelSec = nearestOf(LABEL_SEC, stored, DEF_LABEL_SEC);
  }

  /* What an earlier version stored under another name or meaning, carried over to the
     rows of today. It runs before pruneStore(), which would erase those keys first:
       - dockHintsOn (one switch for all the names) off, and dockLabels 0 (what "never"
         was before the switch): the three switches are off, and the timing is the
         default again;
       - dockEffect left / right: the dock's own side or the opposite one, by dockSide;
       - appOpacity (30..100, how solid the overlay is): appTransparency is what is
         left, 100 - opacity, unless a transparency was stored already. */
  function migrate() {
    var store = window.Store;
    var labels = store.get('dockLabels', null);
    var never = labels !== null && isFinite(Number(labels)) && Number(labels) === 0;
    if (store.get('dockHintsOn', true) === false || never) {
      store.set('dockHintsApps', false);
      store.set('dockHintsQuick', false);
      store.set('dockHintsSub', false);
    }
    if (never) store.set('dockLabels', String(DEF_LABEL_SEC));
    /* The entrance effects left and right became "the dock's side" and "the opposite
       side": each is what it was for the side the dock stands at. */
    var effect = store.get('dockEffect', null);
    if (effect === 'left' || effect === 'right') {
      var side = store.get('dockSide', DEF_SIDE);
      store.set('dockEffect', effect === side ? 'edge' : 'opposite');
    }
    var opacity = store.get('appOpacity', null);
    if (opacity !== null && store.get('appTransparency', null) === null && isFinite(Number(opacity))) {
      store.set('appTransparency', nearestStep(100 - Number(opacity), MIN_TRANSPARENCY, MAX_TRANSPARENCY, TRANSPARENCY_STEP, DEF_TRANSPARENCY));
    }
  }

  /* An unknown value (a store edited by hand) falls back to the default. */
  function applyLabelPlace() {
    var stored = window.Store.get('dockLabelPlace', DEF_LABEL_PLACE);
    dockNow.labelPlace = LABEL_PLACES.indexOf(stored) >= 0 ? stored : DEF_LABEL_PLACE;
  }

  /* The rest of the Hints level: the switch, the style, the effect and the two
     colours, read from the store and written on <html> for the CSS. An unknown
     style or effect (a store edited by hand) falls back to the default. */
  function pickOf(list, value, def) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].value === value) return value;
    }
    return def;
  }

  function applyHints() {
    dockNow.hintApps = !!window.Store.get('dockHintsApps', DEF_HINTS_APPS);
    dockNow.hintQuick = !!window.Store.get('dockHintsQuick', DEF_HINTS_QUICK);
    dockNow.hintSub = !!window.Store.get('dockHintsSub', DEF_HINTS_SUB);
    dockNow.labelStyle = pickOf(HINT_STYLES, window.Store.get('dockLabelStyle', DEF_HINT_STYLE), DEF_HINT_STYLE);
    dockNow.labelEffect = pickOf(HINT_EFFECTS, window.Store.get('dockLabelEffect', DEF_HINT_EFFECT), DEF_HINT_EFFECT);
    dockNow.labelText = !!window.Store.get('dockLabelText', false);
    dockNow.labelBorder = !!window.Store.get('dockLabelBorder', false);
    applyHintLook();
  }

  function applyHintLook() {
    var root = document.documentElement;
    root.setAttribute('data-hint-style', dockNow.labelStyle);
    root.setAttribute('data-hint-effect', dockNow.labelEffect);
    root.setAttribute('data-hint-text', dockNow.labelText ? 'on' : 'off');
    root.setAttribute('data-hint-border', dockNow.labelBorder ? 'on' : 'off');
  }

  /* One write for every row of the level: all of them are read back together. */
  function hintsWrite(value, cb) {
    applyLabels();
    applyLabelPlace();
    applyHints();
    window.Dock.relabel();
    cb(true, { local: true });
  }

  /* What the row leading into the Theme level previews: the accent colour. */
  function themeSummary() {
    var name = window.Store.get('appAccent', DEF_ACCENT);
    var accent = ACCENTS.filter(function (item) { return item.value === name; })[0];
    return accent ? t(accent.labelKey) : '';
  }

  /* And the Dock level: the columns and the rows on screen. */
  function dockSummary() {
    return columns() + ' × ' + dockNow.rows;
  }

  /* What the row leading into the level previews: off, or how long and in what
     style. */
  function hintsSummary() {
    if (!dockNow.hintApps && !dockNow.hintQuick && !dockNow.hintSub) return t('value.off');
    var style = HINT_STYLES.filter(function (item) { return item.value === dockNow.labelStyle; })[0];
    return t('value.sec', { n: dockNow.labelSec }) + ' · ' + t(style.labelKey);
  }

  /* The idle seconds before the app hides (app.js runs the timer). A stored
     value that is not one of the stops falls back to the default. */
  /* An unknown value (a store edited by hand) falls back to the default. */
  function applyOpenFocus() {
    var stored = window.Store.get('appOpenFocus', DEF_OPEN_FOCUS);
    dockNow.openFocus = OPEN_FOCUS.indexOf(stored) >= 0 ? stored : DEF_OPEN_FOCUS;
  }

  /* An unknown value (a store edited by hand) falls back to the default. */
  function applyDockEffect() {
    var stored = window.Store.get('dockEffect', DEF_DOCK_EFFECT);
    document.documentElement.setAttribute('data-dock-effect', pickOf(DOCK_EFFECTS, stored, DEF_DOCK_EFFECT));
  }

  function applyAutoHide() {
    dockNow.idleSec = pickAutoHide(window.Store.get('appAutoHide', String(DEF_AUTOHIDE_SEC)));
  }

  function pickAutoHide(value) {
    var n = Number(value);
    return AUTOHIDE_SEC.indexOf(n) < 0 ? DEF_AUTOHIDE_SEC : n;
  }

  /* Whether a start made by the TV (launch param boot) shows the dock: the
     stored switch, or the URL preview when there is one. */
  function openAtStart() {
    if (dockNow.openAtStart !== null) return dockNow.openAtStart;
    return !!window.Store.get('appOpenAtStart', true);
  }

  /* A stored value is used as it is, clamped to the range and not snapped to the
     step: one saved under an older step stays what it was until the slider is
     moved, which writes a value of the current step over it. */
  function inRange(value, min, max, def) {
    var number = Number(value);
    if (!isFinite(number)) return def;
    return Math.max(min, Math.min(max, number));
  }

  function applyOffsetY() {
    dockNow.offsetY = inRange(window.Store.get('dockOffsetY', DEF_OFFSET_Y), MIN_OFFSET_Y, MAX_OFFSET_Y, DEF_OFFSET_Y);
  }

  /* The distance from the edge is all CSS (.dock { left }, and the slide-in
     starts that much further out), so it goes onto <html> as a variable. */
  function applyOffsetX() {
    setOffsetX(window.Store.get('dockOffsetX', DEF_OFFSET_X));
  }

  function setOffsetX(pixels) {
    var x = inRange(pixels, MIN_OFFSET_X, MAX_OFFSET_X, DEF_OFFSET_X);
    document.documentElement.style.setProperty('--dock-x', x + 'px');
  }

  /* The three places of the foot, from the store: an unknown value falls back to
     the place's default, and nothing is written back. dock.js reads them with
     quickAt(). */
  function quickCommand(value) {
    for (var i = 0; i < QUICK.length; i++) {
      if (QUICK[i].value === value) return QUICK[i];
    }
    return null;
  }

  function pickQuick(value, slot) {
    return quickCommand(value) ? value : DEF_QUICK[slot - 1];
  }

  function subCommand(value) {
    for (var i = 0; i < SUB_COMMANDS.length; i++) {
      if (SUB_COMMANDS[i].value === value) return SUB_COMMANDS[i];
    }
    return null;
  }

  /* An unknown value (a store edited by hand, or a command a later version
     dropped) falls back to the place's default; an empty one is a choice and
     stays. */
  function pickSub(value, slot) {
    return subCommand(value) ? value : DEF_SUB[slot - 1];
  }

  function applySub() {
    for (var slot = 1; slot <= SUB_MAX; slot++) {
      dockNow.sub[slot - 1] = pickSub(window.Store.get('dockSub' + slot, DEF_SUB[slot - 1]), slot);
    }
  }

  /* The commands of the places that are filled, from the top: one to eight. The
     dock's own Settings is always among them: with Submenu on the fourth button
     it is the only way into the Settings window, so a submenu that lost it (every
     place empty, or filled with other commands) would lock the user out. When it
     is not picked it takes the first free place after the filled ones, or the
     last place when all eight are taken. Stored values stay as they were. */
  function submenuItems() {
    var list = [];
    var hasSettings = false;
    for (var i = 0; i < SUB_MAX; i++) {
      var cmd = subCommand(dockNow.sub[i]);
      if (cmd && cmd !== SUB_OFF) {
        list.push(cmd);
        if (cmd.settings) hasSettings = true;
      }
    }
    if (!hasSettings) list[Math.min(list.length, SUB_MAX - 1)] = subCommand('settings');
    return list;
  }

  /* ?sub=poweroff,restart,screenoff,home: the places from the top, nothing stored;
     what is not a command is skipped and the places past the list stay empty,
     so ?sub=off is a submenu with no place set (the column of Settings only). Naming the empty
     choice counts as naming a command, an empty "?sub=" does not. */
  function previewSub(value) {
    var names = String(value).split(',');
    var picked = 0;
    for (var slot = 1; slot <= SUB_MAX; slot++) {
      var name = names[slot - 1];
      dockNow.sub[slot - 1] = subCommand(name) ? name : 'off';
      if (subCommand(name)) picked++;
    }
    return picked > 0;
  }

  function applyQuick() {
    for (var slot = 1; slot <= 3; slot++) {
      dockNow.quick[slot - 1] = pickQuick(window.Store.get('dockQuick' + slot, DEF_QUICK[slot - 1]), slot);
    }
  }

  /* The command of a place (1..3), or null when it is empty. */
  function quickAt(slot) {
    var cmd = quickCommand(dockNow.quick[slot - 1]);
    return cmd && cmd.value !== 'off' ? cmd : null;
  }

  function pickQuick4(value) {
    return QUICK4.indexOf(value) >= 0 ? value : DEF_QUICK4;
  }

  function applyQuick4() {
    dockNow.quick4 = pickQuick4(window.Store.get('dockQuick4', DEF_QUICK4));
  }

  /* The command of the fourth button, in the shape of a QUICK entry so that
     dock.js does it the way it does the others: the Submenu is the QUICK entry
     itself, Settings the one the submenu list holds for it (settings: true). */
  function quick4() {
    return dockNow.quick4 === 'submenu' ? quickCommand('submenu') : subCommand('settings');
  }

  function setFlag(name, on) {
    document.documentElement.setAttribute(name, on ? 'on' : 'off');
  }

  function flagOn(name) {
    return document.documentElement.getAttribute(name) !== 'off';
  }

  function onFlag(value) {
    return value !== '0' && value !== 'off' && value !== 'false';
  }

  /* Where the balloon shows up. Two questions, so two rows: the edge is a
     switch (top by default) and the alignment a short list — together they are
     the six places a corner or a centre can be. Only the CSS knows what each
     combination does. */
  function applyToast() {
    setToast(window.Store.get('appToastTop', true) ? 'top' : 'bottom',
             window.Store.get('appToastAlign', 'center'));
  }

  function setToast(edge, align) {
    document.documentElement.setAttribute('data-toast-v', edge === 'bottom' ? 'bottom' : 'top');
    document.documentElement.setAttribute('data-toast-h',
      ALIGNS.indexOf(align) < 0 ? 'center' : align);
  }

  /* Show a palette without storing the choice (URL debug param). `contrast` is
     still accepted as a palette of its own: it means "this mode, high contrast". */
  function previewTheme(name) {
    if (name === 'contrast') { setTheme(themeNow.mode, true); return true; }
    if (MODES.indexOf(name) < 0) return false;
    setTheme(name, themeNow.contrast);
    return true;
  }

  /* Either half of the theme can be previewed on its own: ?theme=light&contrast=1. */
  function previewContrast(flag) {
    setTheme(themeNow.mode, flag !== '0' && flag !== 'off' && flag !== 'false');
    return true;
  }

  /* Same for the accent: paint it, remember nothing. */
  function previewAccent(name) {
    if (!accentHex(name)) return false;
    setAccent(name);
    return true;
  }

  /* The picture behind the main column: ?bg=100 is as solid as it gets, ?bg=0 no
     picture at all. Snapped and clamped like a stored value. */
  function previewBg(percent) {
    if (!isFinite(Number(percent))) return false;
    setBg(percent);
    return true;
  }

  /* And the one behind the rail of the window, a parameter of its own. */
  function previewBgRail(percent) {
    if (!isFinite(Number(percent))) return false;
    setBgRail(percent);
    return true;
  }

  /* Transparency too, snapped and clamped like a stored value: ?transparency=100 lands
     on the ceiling of the slider instead of emptying the screen. */
  function previewTransparency(percent) {
    if (!isFinite(Number(percent))) return false;
    setTransparency(percent);
    return true;
  }

  /* And the columns of the dock: ?cols=2. */
  function previewColumns(value) {
    if (COLUMNS.indexOf(String(value)) < 0) return false;
    setColumns(value);
    return true;
  }

  /* The edge: ?side=right. */
  function previewSide(value) {
    if (SIDES.indexOf(String(value)) < 0) return false;
    setSide(String(value));
    return true;
  }

  /* And the rest of the dock's geometry: ?rows=4, ?dockX=0, ?dockY=-200. */
  function previewRows(value) {
    if (!isFinite(Number(value))) return false;
    dockNow.rows = nearestStep(value, MIN_ROWS, MAX_ROWS, 1, DEF_ROWS);
    return true;
  }

  function previewOffsetX(value) {
    if (!isFinite(Number(value))) return false;
    setOffsetX(value);
    return true;
  }

  function previewOffsetY(value) {
    if (!isFinite(Number(value))) return false;
    dockNow.offsetY = inRange(value, MIN_OFFSET_Y, MAX_OFFSET_Y, DEF_OFFSET_Y);
    return true;
  }

  /* The places of the foot: ?q1=, ?q2=, ?q3= (a command of QUICK), and ?home= as
     it was before them, for the third (off|home|poweroff|restart; 0 and 1 too). */
  function previewQuick(slot, value) {
    var v = String(value);
    if (!quickCommand(v)) {
      if (slot !== 3) return false;
      v = onFlag(v) ? 'home' : 'off';
    }
    dockNow.quick[slot - 1] = v;
    return true;
  }

  /* The fourth button: ?q4=settings|submenu. */
  function previewQuick4(value) {
    if (QUICK4.indexOf(String(value)) < 0) return false;
    dockNow.quick4 = String(value);
    return true;
  }

  /* And the seconds of the name balloon: ?labels=0 hides it, ?labels=10. A preview
     is stored nowhere, so it is not held to the list of the row: any number of
     seconds up to a minute (the shots and checks need a name that outlasts their
     few seconds of budget). */
  function previewLabels(value) {
    var seconds = Number(value);
    if (!isFinite(seconds)) return false;
    dockNow.labelSec = Math.max(0, Math.min(60, seconds));
    return true;
  }

  /* The rest of the Hints level, nothing stored: ?hints=0|1 (the three kinds of tile
     together), ?hintsApps= ?hintsQuick= ?hintsSub= (one kind), ?hintStyle=, ?hintEffect=,
     ?hintText=0|1, ?hintBorder=0|1. */
  var HINT_KIND_KEY = { apps: 'hintApps', quick: 'hintQuick', sub: 'hintSub' };

  function previewHints(key, value) {
    var v = String(value);
    if (key === 'on' || key === 'apps' || key === 'quick' || key === 'sub' || key === 'text' || key === 'border') {
      if (v !== '0' && v !== '1') return false;
      var on = v === '1';
      if (key === 'on') { dockNow.hintApps = on; dockNow.hintQuick = on; dockNow.hintSub = on; }
      else if (HINT_KIND_KEY[key]) dockNow[HINT_KIND_KEY[key]] = on;
      else dockNow[key === 'text' ? 'labelText' : 'labelBorder'] = on;
    } else {
      var list = key === 'style' ? HINT_STYLES : HINT_EFFECTS;
      if (pickOf(list, v, null) === null) return false;
      dockNow[key === 'style' ? 'labelStyle' : 'labelEffect'] = v;
    }
    applyHintLook();
    return true;
  }

  /* And where the name stands: ?labelPlace=tile|dock. */
  function previewLabelPlace(value) {
    if (LABEL_PLACES.indexOf(String(value)) < 0) return false;
    dockNow.labelPlace = String(value);
    return true;
  }

  /* And the idle seconds before the app hides: ?autohide=5. Only the stops of
     the list count, as for a stored value. */
  function previewAutoHide(value) {
    if (AUTOHIDE_SEC.indexOf(Number(value)) < 0) return false;
    dockNow.idleSec = Number(value);
    return true;
  }

  /* And whether HOME is bound to the dock: ?homeBound=0|1 (what puts the pointer away when
     HOME calls the dock depends on it, see homeBound()). */
  function previewHomeBound(value) {
    if (String(value) !== '0' && String(value) !== '1') return false;
    homeBoundPreview = String(value) === '1';
    return true;
  }

  /* And how the dock comes onto the screen: ?dockEffect=edge|opposite|top|bottom|fade|pop|none. */
  function previewDockEffect(value) {
    if (pickOf(DOCK_EFFECTS, String(value), null) === null) return false;
    document.documentElement.setAttribute('data-dock-effect', String(value));
    return true;
  }

  /* And where the focus stands when the dock is shown: ?openFocus=last|first|end. */
  function previewOpenFocus(value) {
    if (OPEN_FOCUS.indexOf(String(value)) < 0) return false;
    dockNow.openFocus = String(value);
    return true;
  }

  /* And the first-showing switch: ?openAtStart=0. */
  function previewOpenAtStart(value) {
    dockNow.openAtStart = onFlag(value);
    return true;
  }

  /* And where the balloon appears: ?toastAt=bottom-left, ?toastAt=top (centre). */
  function previewToast(spec) {
    var parts = String(spec).toLowerCase().split('-');
    if (parts[0] !== 'top' && parts[0] !== 'bottom') return false;
    var align = parts.length > 1 ? parts[1] : 'center';
    if (ALIGNS.indexOf(align) < 0) return false;
    setToast(parts[0], align);
    return true;
  }

  /* Back to a fresh install: everything the app remembers goes, and the defaults
     of the model take over again. Nothing on the TV itself is touched. */
  function resetPrefs(api) {
    window.Store.reset();
    window.Dock.forgetIcons();
    applyAppPrefs();
    window.Menu.relabel();
    window.Dock.relabel();
    api.rerender();
    api.toast(t('toast.reset'));
  }

  /* Keys the store keeps although no row of the model carries them: values the
     Tweaks rows write for themselves, the select of Switch app ID, which is
     only a row while the service has root, and the dock's cache of the app list
     (dock.js). The switches of Applications are kept by their prefix — their
     rows exist only once the list has been read. */
  var KEEP_KEYS = ['keepaliveSelfService', 'tweaksAppType', 'appIdSelect',
                   'appOrder', 'ssapKey', 'ssapRoute', 'appsCache', 'homeBound'];
  /* What the settings panel this app grew out of stored. Under the same origin
     it would only sit there; under another one removing it does nothing. */
  var LEGACY_STORE = 'webocu.settings.v1';

  /* Everything a build of this app stored that this build has no row for any
     more (the width, the insets, the clock of the old panel) goes, so the store
     holds the settings that exist and nothing else. */
  function pruneStore() {
    window.Store.prune(function (id) {
      return !!index[id] || KEEP_KEYS.indexOf(id) >= 0 || id.indexOf(SHOW_PREFIX) === 0;
    });
    window.Store.forget(LEGACY_STORE);
  }

  /* Called once at startup, before anything is rendered.
     Returns true when the language differs from the one i18n started with. */
  function applyAppPrefs() {
    migrate();
    pruneStore();
    applyTheme();
    applyAccent();
    applyBg();
    applyBgRail();
    applyTransparency();
    applyColumns();
    applySide();
    applyRows();
    applyOffsetX();
    applyOffsetY();
    applyQuick();
    applyQuick4();
    applySub();
    applyLabels();
    applyLabelPlace();
    applyHints();
    applyAutoHide();
    applyOpenFocus();
    applyDockEffect();
    applyClockLook();
    applyToast();
    return applyLanguage();
  }

  /* Ask the service which HOME methods are on, for the two toggles. done(changed)
     is the section's load callback, so Tweaks repaints when the answer differs. */
  function loadHome(done) {
    Luna.homeKey('status', null, function (st) {
      var hook = !!(st && st.hook), setting = !!(st && st.setting);
      var changed = hook !== homeState.hook || setting !== homeState.setting;
      homeState.hook = hook;
      homeState.setting = setting;
      /* Only an answer that came from a root service says anything: without root the
         status is read blind, and "not bound" would be remembered over a binding made
         earlier. */
      if (st && st.root) rememberHomeBound();
      if (done) done(changed);
    });
  }

  /* Whether HOME is bound to the dock, by either method. The pointer that the TV puts on
     the screen by itself when HOME calls the dock is put away again only while this is
     true (dock.js armPointer): the two are one feature, with no switch of its own. The
     dock needs to know it at every showing: it is not asked of the TV each time (the status runs shell
     scripts), the last answer is kept in the store — written when a toggle is changed
     and when Tweaks reads the state. With nothing kept yet a service with root reads
     it once at start (refreshHomeBound). ?homeBound= previews it. */
  var homeBoundPreview = null;

  function homeBound() {
    if (homeBoundPreview !== null) return homeBoundPreview;
    return !!window.Store.get('homeBound', false);
  }

  function rememberHomeBound() {
    window.Store.set('homeBound', !!(homeState.hook || homeState.setting));
  }

  function refreshHomeBound() {
    if (window.Store.get('homeBound', null) !== null) return;
    loadHome();
  }

  /* Turn one HOME method on or off. The truth is on the TV, so the toggle's
     stored value is only a cache the next loadHome() corrects. */
  function writeHome(method, value, cb) {
    Luna.homeKey(value ? 'on' : 'off', method, function (st, info) {
      if (info && info.mocked) { cb(false, { mocked: true }); return; }
      if (!st || st.returnValue === false) { cb(false, { error: (st && st.errorText) || 'failed' }); return; }
      homeState[method === 'hook' ? 'hook' : 'setting'] = !!value;
      rememberHomeBound();
      window.Menu.toast(value ? t('tweaks.home.on') : t('tweaks.home.off'));
      cb(true);
    });
  }

  /* The state of the helper service, which Tweaks reports and gates on. */
  function loadDeviceInfo(done) {
    Luna.serviceStatus(function (status) {
      device.service = status;
      console.log('[webocu-dock] helper service: running=' + status.running + ', root=' + status.root);
      if (done) done(false);
    });
  }

  /* The app asks for root by itself when the service has none: on a TV with the
     Homebrew Channel that is the whole of Request privileges, done at start. It
     is silent and cannot fail the start — no toast, no dialog, a TV without the
     Channel just answers "no". done(root) gets the outcome. The row in Tweaks
     stays as a manual retry. */
  function autoElevate(done) {
    var svc = device.service;
    if (!svc || svc.root || svc.mocked) { done(!!(svc && svc.root)); return; }
    try {
      Luna.elevate(function (root, status) {
        if (status) device.service = status;
        buildSwitchAppIdItems();
        console.log('[webocu-dock] auto elevate: root=' + !!root);
        done(!!root);
      });
    } catch (e) {
      console.warn('[webocu-dock] auto elevate: ' + e.message);
      done(false);
    }
  }

  return {
    sections: sections,
    subsection: subsection,
    item: function (id) { return index[id]; },
    sectionOf: function (id) { return sectionOf[id]; },
    value: value,
    commit: commit,
    refresh: refresh,
    label: label,
    hint: hint,
    optionLabel: optionLabel,
    formatValue: formatValue,
    icon: function (name) { return ICON[name] || ICON_FALLBACK; },
    columns: columns,
    rows: function () { return dockNow.rows; },
    offsetY: function () { return dockNow.offsetY; },
    labelSeconds: function () { return dockNow.labelSec; },
    /* Whether the names of one kind of tile are on: 'apps', 'quick' or 'sub'. */
    hintOn: function (kind) {
      return kind === 'sub' ? dockNow.hintSub : kind === 'quick' ? dockNow.hintQuick : dockNow.hintApps;
    },
    labelPlace: function () { return dockNow.labelPlace; },
    openFocus: function () { return dockNow.openFocus; },
    homeBound: homeBound,
    refreshHomeBound: refreshHomeBound,
    autoHideSeconds: function () { return dockNow.idleSec; },
    openAtStart: openAtStart,
    timeText: timeText,
    dateText: dateText,
    quickAt: quickAt,
    quick4: quick4,
    submenu: submenuItems,
    HOME_APP: HOME_APP,
    isShown: isShown,
    orderApps: orderApps,
    applyAppPrefs: applyAppPrefs,
    previewTheme: previewTheme,
    previewContrast: previewContrast,
    previewAccent: previewAccent,
    previewBg: previewBg,
    previewBgRail: previewBgRail,
    previewTransparency: previewTransparency,
    previewColumns: previewColumns,
    previewSide: previewSide,
    previewRows: previewRows,
    previewOffsetX: previewOffsetX,
    previewOffsetY: previewOffsetY,
    previewQuick: previewQuick,
    previewQuick4: previewQuick4,
    previewSub: previewSub,
    previewLabels: previewLabels,
    previewLabelPlace: previewLabelPlace,
    previewHints: previewHints,
    previewAutoHide: previewAutoHide,
    previewOpenAtStart: previewOpenAtStart,
    previewOpenFocus: previewOpenFocus,
    previewDockEffect: previewDockEffect,
    previewHomeBound: previewHomeBound,
    previewClock: previewClock,
    previewClockSize: previewClockSize,
    previewHidden: previewHidden,
    previewToast: previewToast,
    loadDeviceInfo: loadDeviceInfo,
    autoElevate: autoElevate,
    loadIcons: loadIcons,
    loadIconsSync: loadIconsSync
  };
})();
