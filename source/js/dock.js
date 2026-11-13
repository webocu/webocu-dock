/* =========================================================================
   The dock: a small panel at the left of the screen with the icons of the
   installed user apps, one to seven columns of them, and a foot of small buttons
   at the right: up to three quick ones the user sets (Appearance -> Quick
   launch: webOS Home, LG Store, Browser, ..., Power Off, Restart; an empty one is
   not drawn, and with one column only the third is) and Settings. OK
   starts the focused app; the Settings button opens the Settings window
   (menu.js). The TV picture stays visible beside the panel.

   What counts as a user app is what the app manager reports with
   systemApp === false — the store and Developer Mode installs — minus the
   hidden ones and the dock itself, followed by the TV's inputs (HDMI etc.),
   which are read along with them. Settings -> Applications switches each of
   them on or off the dock — the inputs start off. The list is read from the TV once and kept in the store
   (appsCache): every later start draws it from there without a luna call, so
   the icons are on screen at once. Settings -> Applications -> Read the list
   again (and pairing) reads it anew; an app installed meanwhile shows up then.

   How many rows are on screen, how far the panel stands off the left edge and
   where it sits on the height of the screen are settings (Appearance); a longer
   list scrolls with the focus. The name of the focused tile is shown in a
   balloon beside the panel, so the panel itself can stay as narrow as one icon.
   ========================================================================= */
window.Dock = (function () {
  var elDock = document.getElementById('dock');
  var elPanel = document.getElementById('dockPanel');
  var elGrid = document.getElementById('dockGrid');
  var elQuick = [1, 2, 3].map(function (n) { return document.getElementById('dockQuick' + n); });
  var elSettings = document.getElementById('dockSettings');
  var elSub = document.getElementById('dockSub');
  var elLabel = document.getElementById('dockLabel');
  var elNote = document.getElementById('dockNote');
  var elClock = document.getElementById('dockClock');
  var elDate = document.getElementById('dockDate');

  var S = window.Settings;
  var t = window.I18N.t;

  /* The layout the UI layer is drawn in (--ui-scale fits it to the screen). */
  var LAYOUT_H = 1080;
  /* The size of a tile in app.css (--tile); the panel shrinks it only when the
     clock and the date would push the tallest dock off the screen. */
  var TILE = 112;
  /* Focus ids of the buttons of the foot (quick 1..3, then Settings); app ids
     never start with '#'. */
  var QUICK_ID = ['#q1', '#q2', '#q3'];
  var SETTINGS_ID = '#settings';
  /* The countdown of the Power Off / Restart window, in seconds. */
  var POWER_WAIT = 5;
  /* The width of the layout (LAYOUT_H is its height), and the gap between the
     dock and the row of the submenu. */
  var LAYOUT_W = 1920;
  var SUB_GAP = 20;
  var LABEL_GAP = 12;          // between a tile and the balloon with its name
  var labelMods = '';          // how the balloon is anchored now, see labelClass()
  /* The name of a tile shows only for a focus the user moved: an arrow of the remote
     or the pointer coming onto a tile (moved()). A focus that is painted again by the
     dock itself — it opened, its list arrived, the language changed, it was brought
     back — keeps the balloon down. */
  var announce = false;
  /* The dock was shown and its focus is to be placed (placeFocus), see openFocus. */
  var wantFocus = false;

  var isOpen = false;
  /* 'loading' | 'ready' | 'empty' | 'failed' | 'hidden' (every app switched off
     in Settings -> Applications). */
  var state = 'loading';
  var allApps = [];            // the user apps, then the TV's inputs, in order
  var apps = [];               // the ones the dock shows
  var focusId = null;          // app id, a QUICK_ID or SETTINGS_ID; survives a reload
  var subOpen = false;         // the submenu of a Submenu quick button is up
  var subSlot = 0;             // the button that opened it: quick 1..3, or 4 (Settings set to Submenu)
  var subIndex = 0;            // the focused item of Settings.submenu()
  var subToward = 'left';      // where the dock is from the column: 'left' | 'right'
  var scrollEl = null;
  var scrollY = 0;
  var loadToken = 0;
  var loadWaiters = [];
  var listVia = null;          // which source gave the list: 'service' | 'appmgr' | 'ssap' | 'mock'
  var labelTimer = null;
  var clockShown = null;
  var dateShown = null;

  /* The store key of the cached list, and the fields of an app worth keeping:
     what the tile, the letter and the launch need. Icon data URIs stay out —
     they are large, and the service reads them again on demand. */
  var CACHE_KEY = 'appsCache';
  var CACHE_FIELDS = ['id', 'title', 'icon', 'largeIcon', 'folderPath', 'iconColor', 'bgColor', 'isInput'];

  /* Data URIs of the app icons, kept so a page the system reloaded draws its
     pictures at once, without the disk and without asking the helper service for
     every one of them again. They come from the service: icons the web view could
     not load, and a background copy of those it drew from their file.
     They live in IndexedDB, a quota of their own, and not in localStorage: that
     quota is shared with the settings store, whose writes fail silently when it
     is used up, so a full icon cache must never be able to take room from it.
     The copy in memory (iconCache) is what the tiles read; the database is
     loaded once at start and written one record at a time. Without IndexedDB the
     cache simply lives for the session. Only reads that worked are kept; a failure
     is remembered for a minute and then tried again, because it is often only the
     moment — the service not elevated yet, or still starting after a reboot. */
  var ICON_KEY = ownId() + '.icons.v1';   // the old localStorage entry, removed at start
  var ICON_DB = ownId() + '.icons';
  var ICON_STORE = 'icons';
  var ICON_MAX = 64 * 1024;           // one launcher icon is a few kilobytes
  var ICON_TOTAL = 5 * 1024 * 1024;   // characters of data URIs, all icons together
  var ICON_RETRY_MS = 60000;
  var iconCache = {};
  /* What the database holds (id -> data URI), to write only the difference. */
  var iconStored = {};
  var iconDb = null;
  /* 'loading' until the database answered, then 'ready', or 'off' when there is
     none (or it failed): then nothing is stored and nothing is copied. */
  var iconDbState = 'loading';
  /* A reset asked for an empty cache while the database was still loading. */
  var iconWipe = false;
  var iconFailedAt = {};
  var iconPending = {};
  /* Icons the web view drew from their file are copied into the store too, one
     read at a time (iconQueue) and each id once per page (iconTried). */
  var iconTried = {};
  var iconQueue = [];
  var iconBusy = false;
  var iconLogged = {};

  /* The old localStorage copy only takes room from the settings store. The icons
     are copied again from their files as they are drawn. */
  window.Store.forget(ICON_KEY);
  openIconDb(loadIcons);

  /* ------------------------------------------------------------- model --- */
  function ownId() {
    var sys = window.webOSSystem || window.PalmSystem || null;
    return (sys && sys.identifier) ? String(sys.identifier) : 'webocu.dock';
  }

  /* The user apps out of whatever the TV reported. System apps are dropped by
     whichever field the source carried: applicationmanager marks them
     systemApp:true, a launch point marks them removable:false. */
  function userApps(list) {
    var self = ownId();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var app = list[i];
      if (!app || !app.id) continue;
      if (app.systemApp === true) continue;
      if (app.removable === false) continue;
      if (app.visible === false) continue;
      if (app.id === self) continue;
      out.push(app);
    }
    /* By name first, the way a person looks for an app; the id breaks a tie so
       the title order is stable. */
    out.sort(function (a, b) {
      var byTitle = titleOf(a).toLowerCase().localeCompare(titleOf(b).toLowerCase());
      return byTitle || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    return out;
  }

  /* One list out of the two reads: the user apps by name, then the inputs in
     the order of their ports (as Luna.listInputs gives them), each marked
     isInput — an input the app list already carried is not added twice. Then
     the order of Settings -> Applications over the whole of it (orderApps keeps
     this order for anything it was not told about). */
  function combine(list, inputs) {
    /* Every entry the TV reported, system apps included: an input is an app of
       its own there (com.webos.app.hdmi1 ...), and that entry has the icon the
       input list does not carry. */
    var raw = {};
    (list || []).forEach(function (app) { if (app && app.id) raw[app.id] = app; });
    var out = userApps(list || []);
    var seen = {};
    out.forEach(function (app) { seen[app.id] = true; });
    (inputs || []).forEach(function (input) {
      if (!input || !input.id || seen[input.id]) return;
      seen[input.id] = true;
      var copy = {};
      for (var key in input) if (Object.prototype.hasOwnProperty.call(input, key)) copy[key] = input[key];
      copy.isInput = true;
      var own = raw[input.id];
      if (own && !copy.icon && !copy.largeIcon) {
        ['icon', 'largeIcon', 'folderPath', 'iconColor'].forEach(function (key) {
          if (own[key]) copy[key] = own[key];
        });
      }
      out.push(copy);
    });
    return S.orderApps(out);
  }

  function titleOf(app) {
    return String(app.title || app.id || '');
  }

  /* What the dock shows: what Settings -> Applications has not switched off.
     An app is on until switched off, an input off until switched on. allApps
     keeps the full list, because the settings tab is built from it. */
  function applyVisibility() {
    apps = allApps.filter(function (app) { return S.isShown(app.id, !app.isInput); });
    if (state === 'ready' || state === 'hidden') state = apps.length ? 'ready' : 'hidden';
  }

  /* ------------------------------------------------------------- cache --- */
  /* A mocked list (?apps=, ?inputs=) neither reads nor writes the cache: a shot
     has to show what its URL asks for, not what an earlier page stored. */
  function cacheUsable() {
    return !(window.Luna.isMocked && window.Luna.isMocked());
  }

  function readCache() {
    if (!cacheUsable()) return null;
    var cached = window.Store.get(CACHE_KEY, null);
    if (!cached || !cached.apps || typeof cached.apps.length !== 'number') return null;
    return cached;
  }

  function trimApp(app) {
    var out = {};
    for (var i = 0; i < CACHE_FIELDS.length; i++) {
      var key = CACHE_FIELDS[i];
      if (app[key] !== undefined && app[key] !== null && app[key] !== '') out[key] = app[key];
    }
    return out;
  }

  /* Only a successful read is kept, so a failed one is tried again next start. */
  function writeCache() {
    if (!cacheUsable()) return;
    window.Store.set(CACHE_KEY, { apps: allApps.map(trimApp), via: listVia });
  }

  function finishLoad() {
    applyVisibility();
    placeFocus();
    render();
    var waiters = loadWaiters;
    loadWaiters = [];
    waiters.forEach(function (cb) { cb(state === 'failed' ? null : allApps.slice()); });
  }

  /* The list the dock shows. Without `force` the cached one is used when there
     is one, and the TV is not asked at all; with it (Read the list again,
     pairing) — or with no cache yet — the TV is read and the cache replaced.
     While a list is already on screen it stays there until the new one
     arrives: a reread should not blink the icons away. done(list) gets the user
     apps and inputs (or null when the read failed) — the Applications tab
     reads through here, so both always show the same list. */
  function load(done, force) {
    if (done) loadWaiters.push(done);
    var token = ++loadToken;

    var cached = force ? null : readCache();
    if (cached) {
      /* Split and combined again: Settings -> Applications may have moved an
         app since the list was stored. `inputs` is the shape of an older
         build's cache, which kept them apart. */
      var cachedApps = [], cachedInputs = [];
      cached.apps.forEach(function (app) { (app && app.isInput ? cachedInputs : cachedApps).push(app); });
      allApps = combine(cachedApps, cachedInputs.concat(cached.inputs || []));
      listVia = cached.via || null;
      state = allApps.length ? 'ready' : 'empty';
      finishLoad();
      return;
    }

    if (state !== 'ready' && state !== 'hidden') { state = 'loading'; render(); }
    /* Both reads go out together and the list is drawn once both answered,
       so the inputs never pop in after the apps. listInputs answers [] on any
       failure, so it never holds the dock up. */
    var pending = 2;
    var appList = null, appInfo = null, inputList = [];
    function settle() {
      if (--pending > 0 || token !== loadToken) return;   // a newer read is under way
      if (!appList) {
        allApps = [];
        state = 'failed';
        console.warn('[webocu-dock] app list unavailable: ' + ((appInfo && appInfo.error) || 'unknown'));
        /* Right after the TV started the application manager may not answer yet:
           say so instead of leaving only the empty dock. A read the user asked
           for (force) is reported by Settings itself. The next showing reads
           again, as there is still no cache. */
        if (!force) window.Menu.toast(t('toast.appmgrNotReady'));
      } else {
        allApps = combine(appList, inputList);
        listVia = (appInfo && appInfo.via) || null;
        state = allApps.length ? 'ready' : 'empty';
        /* A reread drops every stored picture: the icon files may have changed
           with an update, and a stored picture is preferred over its file. */
        if (force) forgetIcons();
        var inputCount = allApps.filter(function (app) { return app.isInput; }).length;
        console.log('[webocu-dock] ' + (allApps.length - inputCount) + ' user apps of ' +
                    appList.length + ', ' + inputCount + ' inputs');
        writeCache();
      }
      finishLoad();
    }
    window.Luna.listInputs(function (inputs) {
      inputList = inputs || [];
      settle();
    });
    window.Luna.listApps(function (list, info) {
      appList = list;
      appInfo = info;
      settle();
    });
  }

  /* ------------------------------------------------------------- icons --- */
  /* Where the web view should look for an app's icon. The app manager hands out
     absolute paths on the TV; a relative one is resolved against the folder of
     the app, and without a folder it is a path inside the dock itself (the
     desktop mocks). The large icon first: the tile draws it at 80px. */
  function iconPath(app) {
    var path = String(app.largeIcon || app.icon || '');
    if (!path || /^(file|https?|data):/.test(path) || path.charAt(0) === '/') return path;
    if (app.folderPath) return String(app.folderPath).replace(/\/+$/, '') + '/' + path;
    return path;
  }

  function iconUrl(path) {
    return path.charAt(0) === '/' ? 'file://' + path : path;
  }

  /* A colour the app picked for itself, if it is a plain hex value; otherwise
     one of a few fixed hues chosen by the id, so a letter tile keeps its colour
     from one launch to the next. */
  var LETTER_COLOURS = ['#7c3aed', '#dc2626', '#059669', '#0284c7', '#ea580c', '#db2777', '#ca8a04', '#4f46e5'];

  function letterColour(app) {
    var own = String(app.iconColor || app.bgColor || '');
    if (/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(own)) return own;
    var sum = 0;
    for (var i = 0; i < app.id.length; i++) sum = (sum + app.id.charCodeAt(i)) % 997;
    return LETTER_COLOURS[sum % LETTER_COLOURS.length];
  }

  function letterHtml(app) {
    var letter = titleOf(app).replace(/^\s+/, '').charAt(0).toUpperCase() || '?';
    return '<span class="dock__letter" style="background:' + letterColour(app) + '">' +
             escapeHtml(letter) +
           '</span>';
  }

  /* ---------------------------------------------------- icon database --- */
  function iconDbOff(why) {
    if (iconDbState !== 'off') console.warn('[webocu-dock] icon cache is kept in memory only: ' + why);
    iconDbState = 'off';
  }

  /* done(db), once; db is null when there is no IndexedDB or it will not open. */
  function openIconDb(done) {
    var finished = false;
    function end(db) { if (!finished) { finished = true; done(db); } }
    var request;
    try {
      if (!window.indexedDB) { end(null); return; }
      request = window.indexedDB.open(ICON_DB, 1);
    } catch (e) { end(null); return; }
    request.onupgradeneeded = function () { request.result.createObjectStore(ICON_STORE); };
    request.onsuccess = function () { end(request.result); };
    request.onerror = function () { end(null); };
    request.onblocked = function () { end(null); };
  }

  function loadIcons(db) {
    if (!db) { iconDbOff('IndexedDB is not available'); return; }
    iconDb = db;
    var found = [];
    try {
      var request = db.transaction(ICON_STORE, 'readonly').objectStore(ICON_STORE).openCursor();
      request.onsuccess = function () {
        var cursor = request.result;
        if (!cursor) { finishIconLoad(found); return; }
        var record = cursor.value;
        if (record && typeof record.d === 'string') found.push({ id: cursor.key, d: record.d, t: record.t || 0 });
        cursor['continue']();
      };
      request.onerror = function () { iconDbOff('read failed'); };
    } catch (e) { iconDbOff(String(e)); }
  }

  /* Oldest first, so the order "oldest out" survives a restart. What the session
     already read stays after them (it is newer), and a reset that came while the
     database was loading wins over what is in it. */
  function finishIconLoad(found) {
    found.sort(function (a, b) { return a.t - b.t; });
    var merged = {};
    var gained = false;
    found.forEach(function (record) {
      iconStored[record.id] = record.d;
      if (!iconWipe && !Object.prototype.hasOwnProperty.call(iconCache, record.id)) {
        merged[record.id] = record.d;
        gained = true;
      }
    });
    Object.keys(iconCache).forEach(function (id) { merged[id] = iconCache[id]; });
    iconCache = merged;
    iconWipe = false;
    iconDbState = 'ready';
    writeIcons();
    pumpIcons();
    /* The first showing was drawn before the pictures were here. */
    if (gained && isOpen) render();
  }

  /* Oldest out when the total grows past the cap (keys keep the order they were
     added in), then the difference to the database goes in one transaction —
     never the whole cache. A failed write turns the database off for the session
     and leaves the cache in memory; the settings store is not affected. */
  function writeIcons() {
    var ids = Object.keys(iconCache);
    var total = 0;
    for (var i = ids.length - 1; i >= 0; i--) {
      total += iconCache[ids[i]].length;
      if (total > ICON_TOTAL) delete iconCache[ids[i]];
    }
    if (iconDbState !== 'ready') return;   // loading: finishIconLoad writes; off: memory only
    var gone = Object.keys(iconStored).filter(function (id) { return !(id in iconCache); });
    var fresh = Object.keys(iconCache).filter(function (id) { return iconStored[id] !== iconCache[id]; });
    if (!gone.length && !fresh.length) return;
    try {
      var tx = iconDb.transaction(ICON_STORE, 'readwrite');
      var store = tx.objectStore(ICON_STORE);
      gone.forEach(function (id) { store['delete'](id); delete iconStored[id]; });
      fresh.forEach(function (id) { store.put({ d: iconCache[id], t: Date.now() }, id); iconStored[id] = iconCache[id]; });
      tx.onabort = function () { iconDbOff('write failed'); };
    } catch (e) { iconDbOff(String(e)); }
  }

  /* Drops every stored picture. Used by Reset, and by a read of the list that
     was asked for: an app update may have changed its icon file, and the stored
     picture is preferred over the file, so it would show the old one for good.
     The next drawing takes the files, and keepIcon() copies them again. */
  function forgetIcons() {
    iconCache = {};
    if (iconDbState === 'loading') iconWipe = true;
    iconFailedAt = {};
    iconTried = {};
    iconQueue = [];
    writeIcons();
  }

  /* Total length of the stored pictures. */
  function iconBytes() {
    var total = 0;
    Object.keys(iconCache).forEach(function (id) { total += iconCache[id].length; });
    return total;
  }

  function iconLog(app, text) {
    if (iconLogged[app.id] === text) return;
    iconLogged[app.id] = text;
    console.log('[webocu-dock] icon ' + app.id + ': ' + text);
  }

  /* The stored picture first; the letter while a recent failure is fresh; the
     file otherwise. */
  function iconHtml(app) {
    var cached = iconCache[app.id];
    var src = cached;
    if (!src) {
      if (iconFailedAt[app.id] && Date.now() - iconFailedAt[app.id] < ICON_RETRY_MS) return letterHtml(app);
      src = iconUrl(iconPath(app));
    }
    if (!src) return letterHtml(app);
    return '<img class="dock__img" alt="" src="' + escapeHtml(src) + '">';
  }

  /* The web view refused the picture: ask the helper service to read the file,
     and fall back to the letter when it cannot either. A file:// URL is a file
     too; anything else (an http URL of a launch point) is not something the
     service serves, and only the log says so. A stored picture that no longer
     draws is dropped. Several tiles of one app (a render while a read is under
     way) wait for the same answer. */
  function iconFailed(img, app) {
    var id = app.id;
    var shown = String(img.getAttribute('src') || '');
    if (shown.indexOf('data:') === 0) {
      delete iconCache[id];
      writeIcons();
      iconLog(app, 'stored picture did not draw');
      failIcon(app, [img]);
      return;
    }
    var path = iconPath(app).replace(/^file:\/\//, '');
    if (path.charAt(0) !== '/') {
      iconLog(app, (path || 'no icon') + ' failed in the web view, not a file the service can read');
      failIcon(app, [img]);
      return;
    }
    readIcon(app, path, img, null);
  }

  /* Asks the helper service for the file and keeps the answer. `img` is the tile
     picture that could not draw it and takes the data over; null for the copy
     of an icon the web view drew fine, which stays on screen whatever the
     service says (and so is not turned into a letter). `done` runs at the end,
     whichever way it went. */
  function readIcon(app, path, img, done) {
    var id = app.id;
    function finish() { if (done) done(); }
    if (iconPending[id]) {
      if (img) iconPending[id].push(img);
      finish();
      return;
    }
    iconPending[id] = img ? [img] : [];
    window.Luna.appIcon(path, function (dataUri, info) {
      var waiting = iconPending[id] || [];
      delete iconPending[id];
      if (!dataUri) {
        iconLog(app, 'service failed: ' + ((info && info.error) || 'unknown'));
        if (waiting.length) failIcon(app, waiting);
        finish();
        return;
      }
      delete iconFailedAt[id];
      /* An oversized picture is drawn but not stored: it would crowd out the
         rest; the next page asks the service for it again. */
      if (dataUri.length <= ICON_MAX) {
        iconLog(app, 'service ok');
        iconCache[id] = dataUri;
        writeIcons();
      } else {
        iconLog(app, 'service ok, too large to store');
      }
      waiting.forEach(function (one) { one.src = dataUri; });
      finish();
    });
  }

  /* A picture the web view drew from its file is copied into the store as well,
     so the next start draws it at once and does not depend on the disk. Only
     while the store has room: past the cap the oldest would be pushed out and
     the pictures would take turns being read and dropped on every start, so the
     rest stay on the disk. Needs the root service; without it nothing is kept
     and the picture on screen is left alone. */
  function keepIcon(app) {
    var id = app.id;
    if (iconDbState === 'off' || iconCache[id] || iconTried[id]) return;
    if (iconPath(app).replace(/^file:\/\//, '').charAt(0) !== '/') return;
    iconTried[id] = true;
    iconQueue.push(app);
    pumpIcons();
  }

  /* One copy at a time. Waits while the database is loading (what it holds is
     not known yet); one already stored is skipped; a full cache ends the queue. */
  function pumpIcons() {
    if (iconBusy || iconDbState !== 'ready') return;
    while (iconQueue.length) {
      var app = iconQueue.shift();
      if (iconCache[app.id]) continue;
      if (iconBytes() + ICON_MAX > ICON_TOTAL) { iconQueue = []; return; }
      iconBusy = true;
      readIcon(app, iconPath(app).replace(/^file:\/\//, ''), null, function () {
        iconBusy = false;
        pumpIcons();
      });
      return;
    }
  }

  function failIcon(app, imgs) {
    iconFailedAt[app.id] = Date.now();
    imgs.forEach(function (img) { toLetter(img, app); });
  }

  function toLetter(img, app) {
    var holder = img.parentNode;
    if (holder) holder.innerHTML = letterHtml(app);
  }

  /* Names and paths come from other packages, so they are escaped before
     reaching innerHTML. */
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ------------------------------------------------------------ render --- */
  function render() {
    var cols = S.columns();
    var html = '<div class="dock__scroll">';

    if (state === 'ready') {
      for (var i = 0; i < apps.length; i++) {
        html += '<div class="dock__tile" role="option" data-index="' + i + '" data-id="' + escapeHtml(apps[i].id) + '">' +
                  '<span class="dock__icon">' + iconHtml(apps[i]) + '</span>' +
                '</div>';
      }
    } else {
      /* One tile-sized placeholder: the panel keeps its shape, and the balloon
         beside it (#dockNote) says what happened in as many words as it takes. */
      html += '<div class="dock__state dock__state--' + state + '"><span class="dock__glyph"></span></div>';
    }
    html += '</div>';
    elGrid.innerHTML = html;
    scrollEl = elGrid.firstChild;

    /* The visible rows set the height of the grid: a short list makes a short
       panel instead of a column of empty space. */
    var rows = state === 'ready' ? Math.ceil(apps.length / cols) : 1;
    elPanel.style.setProperty('--rows', String(Math.max(1, Math.min(S.rows(), rows))));

    var imgs = scrollEl.querySelectorAll('.dock__img');
    for (var j = 0; j < imgs.length; j++) bindIcon(imgs[j]);

    for (var q = 1; q <= 3; q++) {
      var cmd = S.quickAt(q);
      elQuick[q - 1].innerHTML = cmd ? '<span class="dock__gear">' + S.icon(cmd.icon) + '</span>' : '';
      elQuick[q - 1].setAttribute('aria-label', cmd ? t(cmd.nameKey) : '');
    }
    /* The fourth button: Settings, or the Submenu when Appearance says so. */
    var cmd4 = S.quick4();
    elSettings.innerHTML = '<span class="dock__gear">' + S.icon(cmd4.icon) + '</span>';
    elSettings.setAttribute('aria-label', t(cmd4.nameKey));

    /* The bands first: their height is part of what has to fit the screen. */
    paintFootTiles(current());
    paintClock();
    /* Before anything is placed against the panel: the balloons read its
       offsets, and the shift moves them. */
    fitPanel();
    placePanel();
    paintNote();
    resolveFocus();
    scrollY = Math.min(scrollY, scrollMax());
    paintFocus();
    refreshSub();
  }

  function bindIcon(img) {
    var tile = img.parentNode && img.parentNode.parentNode;
    var app = tile ? apps[Number(tile.getAttribute('data-index'))] : null;
    if (!app) return;
    img.addEventListener('error', function () { iconFailed(img, app); }, false);
    img.addEventListener('load', function () {
      if (String(img.getAttribute('src')).indexOf('data:') === 0) return;
      iconLog(app, 'file ok');
      keepIcon(app);
    }, false);
  }

  /* The time above the icons, the date under the foot (Settings -> General ->
     Clock). Written only when the text changed, so the tick below costs nothing
     for the 59 seconds of a minute that look the same. */
  function paintClock() {
    var time = S.timeText();
    var date = S.dateText();
    if (time !== clockShown) { elClock.textContent = time; clockShown = time; }
    if (date !== dateShown) { elDate.textContent = date; dateShown = date; }
  }

  setInterval(function () {
    if (isOpen) paintClock();
  }, 1000);

  /* Seven rows and both bands of the clock come to some 1136px (a few more at the
     large sizes of the clock and the date, Settings -> General -> Clock and date),
     more than the 1080 of the layout.
     Rather than a lower ceiling of rows, the tiles of this one panel give up
     what is over, shared out over the rows and the foot — a few pixels each,
     only in that case. --foot-half is computed on <html> from the root --tile,
     so it is set again here from the smaller one. */
  function fitPanel() {
    elPanel.style.removeProperty('--tile');
    elPanel.style.removeProperty('--foot-half');
    /* The submenu is no child of the panel but its tiles are the foot's size. */
    elSub.style.removeProperty('--foot-half');
    var over = elPanel.offsetHeight - LAYOUT_H;
    if (over <= 0) return;
    var rows = Number(elPanel.style.getPropertyValue('--rows')) || 1;
    var tile = TILE - Math.ceil(over / (rows + 1));
    var half = 'calc((' + tile + 'px - var(--tile-gap)) / 2)';
    elPanel.style.setProperty('--tile', tile + 'px');
    elPanel.style.setProperty('--foot-half', half);
    elSub.style.setProperty('--foot-half', half);
  }

  /* Where the panel sits on the height of the screen: centred, then shifted by
     Appearance -> Vertical position. The shift is a top margin of twice its
     size, because the dock centres the panel's margin box: half of the margin
     moves the panel, the other half is the centring taking it back. Clamped so
     the panel never leaves the screen, whatever its height (rows, columns) —
     the setting goes up to half the screen and a tall panel has less room. */
  function placePanel() {
    var room = Math.max(0, Math.floor((LAYOUT_H - elPanel.offsetHeight) / 2));
    var shift = Math.max(-room, Math.min(room, S.offsetY()));
    elPanel.style.marginTop = (2 * shift) + 'px';
    /* How far the panel stands from each edge of the screen: the entrance effects that
       bring it out from behind an edge (Appearance -> Dock -> Entrance effect) start that
       far, plus its own size, beyond it — whatever the offsets, the side and the shift. */
    var left = elDock.offsetLeft + elPanel.offsetLeft;
    elPanel.style.setProperty('--panel-left', left + 'px');
    elPanel.style.setProperty('--panel-right', (LAYOUT_W - left - elPanel.offsetWidth) + 'px');
    elPanel.style.setProperty('--panel-top', elPanel.offsetTop + 'px');
    elPanel.style.setProperty('--panel-bottom', (LAYOUT_H - elPanel.offsetTop - elPanel.offsetHeight) + 'px');
  }

  function paintNote() {
    var text = '';
    if (state === 'loading') text = t('dock.loading');
    else if (state === 'empty') text = t('dock.empty');
    else if (state === 'hidden') {
      text = t('dock.allHidden', { path: [t('dock.settings'), t('section.apps')].join(' → ') });
    }
    /* The way to root is spelled with the names the window itself shows, so
       the words in the hint always match the rows they point at. */
    else if (state === 'failed') {
      text = t('dock.failed') + ' ' + t('dock.failed.hint', {
        path: [t('dock.settings'), t('section.tweaks'), t('app.requestPriv')].join(' → ')
      });
    }
    elNote.textContent = text;
    /* Level with the placeholder, the only tile in the grid while it shows. */
    elNote.style.top = (elPanel.offsetTop + elGrid.offsetTop + Math.round(elGrid.offsetHeight / 2)) + 'px';
    elNote.className = 'dock__note' + (text && isOpen ? ' is-on' : '');
  }

  /* ------------------------------------------------------------- focus --- */
  /* The focus is kept as an id, so it stays on the same app across a reload
     that adds or removes others; an app that went away hands it to the first.
     A quick button that is gone (emptied, or hidden by one column) hands its
     focus to Settings, the one that is always there. */
  function current() {
    var slot = QUICK_ID.indexOf(focusId) + 1;
    if (slot && quickShown(slot)) return { kind: 'quick', slot: slot };
    if (slot || focusId === SETTINGS_ID || state !== 'ready') return { kind: 'settings' };
    for (var i = 0; i < apps.length; i++) {
      if (apps[i].id === focusId) return { kind: 'app', index: i };
    }
    return { kind: 'app', index: 0 };
  }

  /* While there is no list the Settings button is the only sure thing to stand
     on, but that is not a choice of the user's: focusId is left alone, so the
     list that arrives a moment later gets the focus back on its first app. */
  function resolveFocus() {
    var at = current();
    if (at.kind === 'app') focusId = apps[at.index].id;
  }

  /* Whether quick button `slot` (1..3) is drawn: it has a command, and buttons 1
     and 2 have room only from two columns up. */
  function quickShown(slot) {
    return !!S.quickAt(slot) && (slot === 3 || S.columns() > 1);
  }

  /* The buttons of the foot that are there, left to right, Settings last. */
  function footButtons() {
    var list = [];
    for (var q = 1; q <= 3; q++) {
      if (quickShown(q)) list.push({ id: QUICK_ID[q - 1], el: elQuick[q - 1] });
    }
    list.push({ id: SETTINGS_ID, el: elSettings });
    return list;
  }

  function paintFootTiles(at) {
    for (var q = 1; q <= 3; q++) {
      elQuick[q - 1].className = 'dock__tile dock__tile--quick' +
        (quickShown(q) ? '' : ' dock__tile--off') +
        (at.kind === 'quick' && at.slot === q ? ' is-focused' : '');
    }
    elSettings.className = 'dock__tile dock__tile--settings' + (at.kind === 'settings' ? ' is-focused' : '');
  }

  /* Where the focus stands each time the dock is shown (General -> Focus on open).
     Asked for by open() and reveal(), and carried out as soon as there is a list to
     stand on: the cached one at once, otherwise when it arrives (finishLoad). The
     last selected is the focus as it is, so it only clears the request; with no
     list to stand on the foot keeps the focus, as it does while the list is read.
     No balloon with the name: it is the dock that moved the focus, not the user. */
  function placeFocus() {
    if (!wantFocus) return;
    var mode = S.openFocus();
    if (mode === 'last') { wantFocus = false; return; }
    if (state === 'loading') return;
    wantFocus = false;
    if (state !== 'ready' || !apps.length) return;
    focusId = apps[mode === 'end' ? apps.length - 1 : 0].id;
  }

  function focusApp(index) {
    focusId = apps[index].id;
    paintFocus();
  }

  function focusFoot(id) {
    focusId = id;
    paintFocus();
  }

  /* `keepScroll` is the wheel: it moves the view and not the focus, so the
     focused tile is allowed to be out of sight until an arrow brings it back. */
  function paintFocus(keepScroll) {
    var at = current();
    var tiles = scrollEl ? scrollEl.querySelectorAll('.dock__tile') : [];
    for (var i = 0; i < tiles.length; i++) {
      tiles[i].className = 'dock__tile' + (at.kind === 'app' && i === at.index ? ' is-focused' : '');
    }
    paintFootTiles(at);

    if (at.kind === 'app' && tiles[at.index] && !keepScroll) ensureVisible(tiles[at.index]);
    else setScroll(scrollY);

    if (at.kind === 'app' && tiles[at.index]) paintLabel(tiles[at.index], titleOf(apps[at.index]));
    else if (at.kind === 'quick') paintLabel(elQuick[at.slot - 1], t(S.quickAt(at.slot).nameKey));
    else paintLabel(elSettings, t(S.quick4().nameKey));
  }

  function moved(fn) {
    announce = true;
    try { fn(); } finally { announce = false; }
  }

  /* The balloon with the name follows the focus. Appearance -> Hints -> Hint placement says
     where it stands: against the focused tile, under it, or over it when the screen
     ends below (the foot of a panel pushed to the bottom); or beside the panel of the
     dock, level with the tile. Either way never past an edge of the screen — whichever
     side of the picture the dock is on, however far it is moved from its edge.
     Its place is worked out from offsets rather than from getBoundingClientRect():
     the whole UI layer is scaled (--ui-scale), and the offsets are already in the
     1920x1080 layout the balloon lives in. The scroll is a transform, which
     offsets do not see, so it is taken off here; the buttons of the foot sit in a
     box of their own (.dock__foot). The name of an item of the submenu stands
     beside its column instead. */
  /* Appearance -> Show hints says for how many seconds (0: never). Every paint
     starts the count again, so the name stays while the focus keeps moving
     and fades (the CSS transition) once it rests. */
  function paintLabel(tile, text) {
    elLabel.textContent = text;
    var inSub = tile.parentNode === elSub;
    var top;
    /* Which switch of Appearance -> Hints decides: the items of the submenu, the quick
       buttons of the foot (Settings among them), or the apps of the list. */
    var kind = inSub ? 'sub' : (tile === elSettings || !!tile.getAttribute('data-slot')) ? 'quick' : 'apps';
    if (inSub) {
      /* The name of an item stands beside the column, on the side away from the
         dock, level with the icon, and not past either edge of the screen. */
      top = Math.round(tile.offsetHeight / 2) + elSub.offsetTop + tile.offsetTop;
      var away = subToward === 'left';
      var edge = elDock.offsetLeft + elSub.offsetLeft + (away ? elSub.offsetWidth + SUB_GAP : -SUB_GAP);
      var span = elLabel.offsetWidth;
      var from = away ? edge : edge - span;
      from = Math.max(0, Math.min(LAYOUT_W - span, from));
      elLabel.style.left = (from + (away ? 0 : span) - elDock.offsetLeft) + 'px';
      labelMods = ' dock__label--sub' + (subToward === 'left' ? '' : ' dock__label--sub-left');
    } else {
      var inFoot = tile === elSettings || !!tile.getAttribute('data-slot');
      var box = inFoot ? tile.parentNode : elGrid;
      var tileTop = elPanel.offsetTop + box.offsetTop + tile.offsetTop - (inFoot ? 0 : scrollY);
      var width = elLabel.offsetWidth;
      var height = elLabel.offsetHeight;
      if (S.labelPlace() === 'dock') {
        /* Beside the panel, level with the icon: on the side of the picture, or on
           the other side of the panel when the name does not fit on that one (the
           way the column of the Submenu is placed), or against the edge of the
           screen when it fits on neither. */
        var half = Math.round(height / 2);
        top = Math.max(half, Math.min(LAYOUT_H - half, tileTop + Math.round(tile.offsetHeight / 2)));
        var toRight = elDock.offsetLeft + elDock.offsetWidth + SUB_GAP;
        var toLeft = elDock.offsetLeft - SUB_GAP - width;
        var fits = function (x) { return x >= 0 && x + width <= LAYOUT_W; };
        var picture = document.documentElement.getAttribute('data-side') === 'right' ? toLeft : toRight;
        var other = picture === toRight ? toLeft : toRight;
        var at = fits(picture) || !fits(other) ? picture : other;
        elLabel.style.left = (Math.max(0, Math.min(LAYOUT_W - width, at)) - elDock.offsetLeft) + 'px';
        labelMods = at === toLeft ? ' dock__label--dock-left' : ' dock__label--dock';
      } else {
        var centre = elDock.offsetLeft + elPanel.offsetLeft + box.offsetLeft + tile.offsetLeft + Math.round(tile.offsetWidth / 2);
        var left = Math.max(0, Math.min(LAYOUT_W - width, centre - Math.round(width / 2)));
        elLabel.style.left = (left - elDock.offsetLeft) + 'px';
        var below = tileTop + tile.offsetHeight + LABEL_GAP;
        var over = below + height > LAYOUT_H;
        top = over ? Math.max(height, tileTop - LABEL_GAP) : below;
        labelMods = over ? ' dock__label--tile-up' : ' dock__label--tile';
      }
    }
    /* Beats the side of the dock the CSS gives the balloon by default. */
    elLabel.style.right = 'auto';
    elLabel.style.top = top + 'px';
    var seconds = S.labelSeconds();
    stopLabelTimer();
    var on = announce && isOpen && !!text && seconds > 0 && S.hintOn(kind);
    elLabel.className = labelClass(on);
    if (on) labelTimer = setTimeout(hideLabel, seconds * 1000);
  }

  /* How the balloon is anchored (the CSS reads the modifiers: the submenu names
     hang from a side of the point, a tile's name from its top or its bottom edge),
     so they outlive the fade-out: dropping them early would slide the balloon back
     to where the CSS puts it by default while it fades. `is-on` comes right after
     the class, so a check for "dock__label is-on" holds for every kind. */
  function labelClass(on) {
    return 'dock__label' + (on ? ' is-on' : '') + labelMods;
  }

  function hideLabel() {
    labelTimer = null;
    elLabel.className = labelClass();
  }

  function stopLabelTimer() {
    if (labelTimer) { clearTimeout(labelTimer); labelTimer = null; }
  }

  /* The column the focus left for the foot, so ▲ goes back to it. */
  var footFrom = 0;

  /* Which of the n buttons of the foot a column stands over: the columns are
     shared out over the buttons from the left, so with two buttons the first
     half of the columns goes with the left one (the middle one of three goes
     with it), Settings under the rest — and under all of them when it is alone. */
  function buttonUnder(column, n, cols) {
    return Math.floor(column * n / cols);
  }

  /* The way back up from button `pos`: the column the focus left, when that lies
     over the same button, else the button's own edge — the last column for
     Settings, the first one over the button for the others (a button no column
     is over, with more buttons than columns, takes the nearest). */
  function columnOver(pos, n, cols) {
    if (buttonUnder(footFrom, n, cols) === pos) return footFrom;
    if (pos === n - 1) return cols - 1;
    for (var c = 0; c < cols; c++) {
      if (buttonUnder(c, n, cols) === pos) return c;
    }
    return Math.min(cols - 1, Math.floor(pos * cols / n));
  }

  /* ▲ ▼ step a row, ◀ ▶ a column. Below the last row is the foot: the column
     the focus came from picks the button (buttonUnder), and ▲ from a button goes
     back to the app above it (columnOver). In the foot ◀ ▶ walk the buttons that
     are there. A row that is shorter than the one above it (an odd count in
     several columns) is reached from its neighbour's column. */
  function move(action) {
    var cols = S.columns();
    var count = state === 'ready' ? apps.length : 0;
    var at = current();
    var buttons = footButtons();

    if (at.kind !== 'app') {
      var pos = buttons.length - 1;
      for (var b = 0; b < buttons.length; b++) {
        if (buttons[b].id === (at.kind === 'quick' ? QUICK_ID[at.slot - 1] : SETTINGS_ID)) pos = b;
      }
      switch (action) {
        case 'left':
          if (pos > 0) focusFoot(buttons[pos - 1].id);
          break;
        case 'right':
          if (pos < buttons.length - 1) focusFoot(buttons[pos + 1].id);
          break;
        case 'up':
          if (!count) break;
          var lastRowStart = Math.floor((count - 1) / cols) * cols;
          focusApp(Math.min(lastRowStart + columnOver(pos, buttons.length, cols), count - 1));
          break;
      }
      return;
    }

    var index = at.index;
    var row = Math.floor(index / cols);
    var lastRow = Math.floor((count - 1) / cols);
    switch (action) {
      case 'up':
        if (row > 0) focusApp(index - cols);
        break;
      case 'down':
        if (row < lastRow) { focusApp(Math.min(index + cols, count - 1)); break; }
        footFrom = index % cols;
        focusFoot(buttons[buttonUnder(footFrom, buttons.length, cols)].id);
        break;
      case 'left':
        if (index % cols > 0) focusApp(index - 1);
        break;
      case 'right':
        if (index % cols < cols - 1 && index + 1 < count) focusApp(index + 1);
        break;
    }
  }

  /* ------------------------------------------------------------ submenu --- */
  /* The Submenu quick button opens a column of small icons beside the dock
     (Settings.submenu(): one to eight commands the user picked in Appearance ->
     Quick launch; the dock's own Settings is always among them, so it is never
     empty). It is drawn once per opening, the focus starts on its first
     item, the top one, and while it is up it has the keys: ▲ ▼ step along the
     column, the arrow towards the dock and Back close it, the other one does
     nothing. The dock's own focus stays on the button that opened it, as a mark
     of where the panel came from. */
  function renderSub() {
    var items = S.submenu();
    var html = '';
    for (var i = 0; i < items.length; i++) {
      html += '<div class="dock__tile dock__tile--sub" role="menuitem" data-sub="' + i + '" aria-label="' +
              escapeHtml(t(items[i].nameKey)) + '"><span class="dock__gear">' + S.icon(items[i].icon) + '</span></div>';
    }
    elSub.innerHTML = html;
  }

  /* Beside the button that opened it, its bottom edge level with the button's
     (the button is at the bottom of the panel, so the column grows up along it);
     from the same offsets paintLabel() reads: the panel's offsetTop already holds
     the vertical shift (placePanel), and the dock box is where Appearance put it,
     so the column goes wherever the dock goes. Eight items are 518px, the shortest
     panel is taller, so the column is inside the panel's height — and the screen's,
     the clamp below is only a safety. Beside means the side of the picture; when
     the column does not fit there (seven columns far from the edge) it goes to the
     other side of the dock, never over it. subToward remembers where the dock is
     from the column, for the arrows and for the name. Written as pixels from the
     left edge of the dock box (the CSS only lays the column out). */
  function placeSub() {
    var button = subSlot === 4 ? elSettings : elQuick[subSlot - 1];
    var width = elSub.offsetWidth;
    var height = elSub.offsetHeight;
    var bottom = elPanel.offsetTop + button.parentNode.offsetTop + button.offsetTop + button.offsetHeight;
    elSub.style.top = Math.max(0, Math.min(LAYOUT_H - height, bottom - height)) + 'px';

    var right = elDock.offsetLeft + elDock.offsetWidth + SUB_GAP;     // beside the dock, at its right
    var left = elDock.offsetLeft - SUB_GAP - width;                   // and at its left
    var fits = function (x) { return x >= 0 && x + width <= LAYOUT_W; };
    var picture = document.documentElement.getAttribute('data-side') === 'right' ? left : right;
    var other = picture === right ? left : right;
    var x = fits(picture) || !fits(other) ? picture : other;
    subToward = x === left ? 'right' : 'left';
    elSub.style.left = (Math.max(0, Math.min(LAYOUT_W - width, x)) - elDock.offsetLeft) + 'px';
  }

  function paintSub() {
    var tiles = elSub.querySelectorAll('.dock__tile');
    for (var i = 0; i < tiles.length; i++) {
      tiles[i].className = 'dock__tile dock__tile--sub' + (i === subIndex ? ' is-focused' : '');
    }
    if (tiles[subIndex]) paintLabel(tiles[subIndex], t(S.submenu()[subIndex].nameKey));
  }

  function openSub(slot) {
    subOpen = true;
    subSlot = slot;
    subIndex = 0;
    renderSub();
    placeSub();
    elSub.className = 'dock__sub is-on';
    elSub.setAttribute('aria-hidden', 'false');
    paintSub();
  }

  /* The focus goes back to the button: its name, not the item's, is what the
     balloon says again. */
  function closeSub() {
    if (!subOpen) return;
    subOpen = false;
    elSub.className = 'dock__sub';
    elSub.setAttribute('aria-hidden', 'true');
    elLabel.className = labelClass();
    if (isOpen) paintFocus();
  }

  /* After the dock was drawn again (a language, the columns, the geometry): the
     panel is redrawn and placed against the new layout, or closed when its button
     is gone (set to something else, or hidden by one column). */
  function refreshSub() {
    if (!subOpen) return;
    /* Button 4 is always there, whatever the columns; 1..3 may be emptied or hidden. */
    var cmd = subSlot === 4 ? S.quick4() : S.quickAt(subSlot);
    if (!cmd || !cmd.submenu || (subSlot < 4 && !quickShown(subSlot)) || !S.submenu().length) { closeSub(); return; }
    subIndex = Math.min(subIndex, S.submenu().length - 1);
    renderSub();
    placeSub();
    paintSub();
  }

  function focusSub(index) {
    subIndex = index;
    paintSub();
  }

  function subKey(action) {
    switch (action) {
      case 'up':
        moved(function () { if (subIndex > 0) focusSub(subIndex - 1); });
        return true;
      case 'down':
        moved(function () { if (subIndex + 1 < S.submenu().length) focusSub(subIndex + 1); });
        return true;
      case 'left':
      case 'right':
        moved(function () { if (action === subToward) closeSub(); });
        return true;
      case 'enter':
        activateSub();
        return true;
      case 'back':
        closeSub();
        return true;
      default:
        return false;
    }
  }

  /* The panel goes first: Power Off and Restart open the window with the
     countdown, and whichever way that ends the dock is as it was, the focus on
     the button. */
  function activateSub() {
    var item = S.submenu()[subIndex];
    closeSub();
    if (item) run(item);
  }

  /* The screen goes dark at once and the dock goes with it, as after a launch: an
     overlay left on top would keep the remote, and the first key of the remote
     is what lights the screen again. No window to confirm — one key undoes it. */
  function screenOff() {
    window.Luna.screenOff(function (ok, info) {
      if (ok) {
        close();
        document.dispatchEvent(new CustomEvent('app:exit'));
        return;
      }
      if (info && info.mocked) { window.Menu.toast(t('toast.mock')); return; }
      window.Menu.toast(t('toast.powerFailed'));
    });
  }

  /* ---------------------------------------------------------- scrolling --- */
  function scrollMax() {
    if (!scrollEl) return 0;
    return Math.max(0, scrollEl.offsetHeight - elGrid.clientHeight);
  }

  function setScroll(y) {
    scrollY = Math.max(0, Math.min(scrollMax(), y));
    if (scrollEl) scrollEl.style.transform = 'translateY(' + (-scrollY) + 'px)';
  }

  /* Whole rows only: the grid is a whole number of tiles tall, so a tile that has
     to come into view brings its row flush with the top or the bottom edge. */
  function ensureVisible(tile) {
    var view = elGrid.clientHeight;
    var top = tile.offsetTop;
    var bottom = top + tile.offsetHeight;
    var y = scrollY;
    if (top < y) y = top;
    else if (bottom > y + view) y = bottom - view;
    setScroll(y);
  }

  /* ------------------------------------------------------------ actions --- */
  /* Started and gone: the dock hides as soon as the app manager accepted the
     launch, because an overlay left on top of the app would keep the remote.
     In a desktop browser nothing is started, and the balloon says so. `params`
     is what the app is started with (the hotkey screens of the TV, see QUICK). */
  function launch(id, name, params) {
    window.Menu.busy(t('toast.launching', { name: name }));
    window.Luna.launch(id, function (ok, info) {
      if (ok) {
        window.Menu.hideToast();
        close();
        document.dispatchEvent(new CustomEvent('app:exit'));
        return;
      }
      if (info && info.mocked) { window.Menu.toast(t('toast.mock')); return; }
      window.Menu.toast(t('toast.launchFailed', { name: name }));
    }, params);
  }

  function openSettings() {
    close();
    document.dispatchEvent(new CustomEvent('settings:open'));
  }

  /* Power Off and Restart never run on one press: a window counts POWER_WAIT
     seconds down with the action focused, as the TV's own power prompt does, so
     OK runs it at once and doing nothing runs it at zero — Cancel (◀ or Back)
     stops it. The luna call is only ever made from that window's callback. */
  function confirmPower(kind) {
    var restart = kind === 'restart';
    var name = t(restart ? 'dock.restart' : 'dock.powerOff');
    window.Dialog.show(t(restart ? 'dialog.restart.ask' : 'dialog.powerOff.ask'), function () {
      window.Menu.busy(name + '…');
      var answered = function (ok, info) {
        if (ok) return;
        if (info && info.mocked) { window.Menu.toast(t('toast.mock')); return; }
        window.Menu.toast(t('toast.powerFailed'));
      };
      if (restart) window.Luna.reboot(answered);
      else window.Luna.powerOff(answered);
    }, null, {
      focus: 1,
      seconds: POWER_WAIT,
      confirmText: name,
      tick: function (n) { return t(restart ? 'dialog.restart' : 'dialog.powerOff', { n: n }); }
    });
  }

  /* What a command of QUICK (or of the submenu) does: the same for the button and
     for the item, so a new command is added in one place. The Submenu button
     itself is the one that is not an item (the submenu has no submenu). */
  function run(cmd) {
    if (cmd.power) confirmPower(cmd.power);
    else if (cmd.screen) screenOff();
    else if (cmd.settings) openSettings();
    else if (cmd.app) launch(cmd.app, t(cmd.nameKey), cmd.params);
  }

  /* A press of a Submenu button (1..3, or the fourth one): the same for all of
     them. Pressed again it closes what it opened. */
  function pressSubmenu(slot) {
    if (subOpen && subSlot === slot) closeSub();
    else openSub(slot);
  }

  function activate() {
    var at = current();
    if (at.kind === 'app') launch(apps[at.index].id, titleOf(apps[at.index]));
    else if (at.kind === 'quick') {
      var cmd = S.quickAt(at.slot);
      if (!cmd.submenu) run(cmd);
      else pressSubmenu(at.slot);
    }
    /* The fourth button: Settings, or the Submenu when Appearance says so. */
    else if (S.quick4().submenu) pressSubmenu(4);
    else openSettings();
  }

  /* Returns true when the dock consumed the key. Back and the menu key leave
     the app (app.js); everything else that is not ours is swallowed, because
     an overlay that passes arrows on would move nothing anyway. */
  function handleKey(action) {
    if (!isOpen) return false;
    /* Everything but the menu key is the panel's while it is up. */
    if (subOpen) return subKey(action);
    switch (action) {
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        moved(function () { move(action); });
        return true;
      case 'enter':
        activate();
        return true;
      default:
        return false;
    }
  }

  /* ------------------------------------------------------- open / close --- */
  function open() {
    if (isOpen) return;
    isOpen = true;
    armPointer();
    elDock.setAttribute('aria-hidden', 'false');
    applyVisibility();
    wantFocus = true;
    placeFocus();
    render();
    /* After the panel is drawn and placed, so the effect knows how far to come from, and
       after the start position has been taken in: a class added to an element whose style
       was never computed makes no transition (a cold start would show no effect). */
    void elDock.offsetWidth;
    elDock.classList.add('is-open');
    load();
  }

  /* While the app is hidden the panel goes back, unseen and without a transition, to where
     its entrance starts; playIn() brings it out again when the app is shown. Only after a
     rest(): a dock that is up and in view never replays its entrance. */
  var rested = false;

  function rest() {
    if (!isOpen) return;
    cancelCursorHide();
    rested = true;
    elDock.classList.add('is-snap');
    elDock.classList.remove('is-open');
  }

  function playIn() {
    if (!isOpen || !rested) return;
    rested = false;
    armPointer();
    void elDock.offsetWidth;
    elDock.classList.remove('is-snap');
    elDock.classList.add('is-open');
  }

  /* The dock is brought back while it is up (Home again, see app.js): the focus goes
     where General -> Focus on open says, and the view follows it. */
  function reveal() {
    if (!isOpen) return;
    armPointer();
    wantFocus = true;
    placeFocus();
    paintFocus();
    playIn();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    rested = false;
    cancelCursorHide();
    subOpen = false;
    elSub.className = 'dock__sub';
    elSub.setAttribute('aria-hidden', 'true');
    elDock.classList.remove('is-open');
    elDock.classList.remove('is-snap');
    elDock.setAttribute('aria-hidden', 'true');
    stopLabelTimer();
    elLabel.className = labelClass();
    elNote.className = 'dock__note';
  }

  /* --------------------------------------------------- pointer (Magic RC) - */
  function tileOf(target) {
    return target && target.closest ? target.closest('.dock__tile') : null;
  }

  function focusTile(tile) {
    if (tile.getAttribute('data-slot')) focusFoot(QUICK_ID[Number(tile.getAttribute('data-slot')) - 1]);
    else if (tile === elSettings) focusFoot(SETTINGS_ID);
    else focusApp(Number(tile.getAttribute('data-index')));
  }

  /* The panel stays up while the pointer is on the button that opened it or on
     the panel itself; on any other tile of the dock it closes, so the focus is
     never in two places. */
  function isSubButton(tile) {
    return subOpen && (tile.getAttribute('data-slot') === String(subSlot) || (subSlot === 4 && tile === elSettings));
  }

  /* The pointer coming onto a tile of the panel moves the focus there. */
  function hoverPanel(target) {
    var tile = tileOf(target);
    if (!tile) return;
    moved(function () {
      if (subOpen && !isSubButton(tile)) closeSub();
      if (!subOpen) focusTile(tile);
    });
  }

  elPanel.addEventListener('mouseover', function (ev) {
    if (pointerGuard) return;
    hoverPanel(ev.target);
  }, false);

  elPanel.addEventListener('click', function (ev) {
    var tile = tileOf(ev.target);
    if (!tile) return;
    setPointerGuard(false);
    /* A second press on the button that opened the panel closes it. */
    if (isSubButton(tile)) { closeSub(); return; }
    closeSub();
    focusTile(tile);
    activate();
  }, false);

  function subTile(target) {
    var tile = tileOf(target);
    return tile && tile.parentNode === elSub ? Number(tile.getAttribute('data-sub')) : -1;
  }

  function hoverSub(target) {
    var index = subTile(target);
    if (index >= 0) moved(function () { focusSub(index); });
  }

  elSub.addEventListener('mouseover', function (ev) {
    if (pointerGuard) return;
    hoverSub(ev.target);
  }, false);

  elSub.addEventListener('click', function (ev) {
    var index = subTile(ev.target);
    if (index < 0) return;
    setPointerGuard(false);
    focusSub(index);
    activateSub();
  }, false);

  /* The pointer of a Magic Remote on the screen when the dock is called by a key (HOME): the
     TV shows it by itself, over whatever tile it happens to be, and a hover would take the
     focus there. Two things deal with it.

     The guard (always on, the fallback): while it is up the pointer moves no focus. It comes
     down at the first real movement (the first mousemove after a showing only takes the
     point the pointer is at, a later one a few pixels away is a movement) or a press — and
     the tile under the pointer is focused then, so the pointer works at once. It is up when
     the dock is shown with no pointer on the screen; a dock called by the pointer (the
     cursor is already there) behaves as it always did.

     The pointer put away (only while HOME is bound to the dock, Settings -> Tweaks): the
     pointer was not on the screen when the app went away (Platform.parkCursor), it shows
     up within a moment of the showing, and nobody has moved it — so it is the TV's doing,
     not the user's. An arrow of the remote makes the pointer go, the app cannot press one,
     so the helper service sends it over the paired TV (Luna.hidePointer); the arrow that
     comes back to the dock is swallowed (Platform.swallowKey). One try for each showing,
     and data-cursor-hide on <html> says how it went: skipped (not armed: HOME is not
     bound, or the pointer was there before), armed, sent, done, failed, moved (the user
     moved the pointer: a call by the pointer after all), late (it showed up too late). */
  var pointerGuard = false;
  var pointerMoved = false;
  var guardX = null;
  var guardY = null;
  var hideArmed = false;
  var hideTimer = null;
  var hideShownAt = 0;
  var CURSOR_HIDE_WINDOW = 1500;   // how long after the showing the pointer may still be the TV's doing
  var CURSOR_HIDE_DELAY = 150;     // looked at once more, for a movement, before the arrow is sent

  function setPointerGuard(on) {
    pointerGuard = on;
    document.documentElement.setAttribute('data-pointer', on ? 'guard' : 'free');
  }

  function setCursorHide(state) {
    document.documentElement.setAttribute('data-cursor-hide', state);
  }

  function cancelCursorHide() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    hideArmed = false;
  }

  /* At every showing (open, the same dock called again, brought back after a hide). */
  function armPointer() {
    pointerMoved = false;
    guardX = null;
    guardY = null;
    setPointerGuard(!window.Platform.cursorVisible());
    cancelCursorHide();
    hideShownAt = Date.now();
    hideArmed = S.homeBound() && !window.Platform.cursorWasVisible();
    setCursorHide(hideArmed ? 'armed' : 'skipped');
    if (hideArmed && window.Platform.cursorVisible()) considerCursorHide();
  }

  function considerCursorHide() {
    if (!hideArmed || !isOpen || hideTimer) return;
    if (pointerMoved) { hideArmed = false; setCursorHide('moved'); return; }
    if (Date.now() - hideShownAt > CURSOR_HIDE_WINDOW) { hideArmed = false; setCursorHide('late'); return; }
    hideTimer = setTimeout(function () {
      hideTimer = null;
      if (!hideArmed || !isOpen) return;
      hideArmed = false;
      if (pointerMoved) { setCursorHide('moved'); return; }
      window.Platform.swallowKey('left', 1500);
      setCursorHide('sent');
      window.Luna.hidePointer(function (ok, info) {
        console.log('[webocu-dock] cursor hide: ' + (ok ? 'done' : 'failed (' + ((info && info.error) || 'no reason') + ')'));
        setCursorHide(ok ? 'done' : 'failed');
      });
    }, CURSOR_HIDE_DELAY);
  }

  /* From app.js, when the TV says the pointer came (true) or went (false). */
  function onCursor(visible) {
    if (visible) considerCursorHide();
  }

  document.addEventListener('mousemove', function (ev) {
    if (pointerMoved) return;
    if (guardX === null) { guardX = ev.clientX; guardY = ev.clientY; return; }
    if (Math.abs(ev.clientX - guardX) + Math.abs(ev.clientY - guardY) < 4) return;
    pointerMoved = true;
    if (!pointerGuard) return;
    setPointerGuard(false);
    if (!isOpen) return;
    var under = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!under) return;
    if (elSub.contains(under)) hoverSub(under);
    else if (elPanel.contains(under)) hoverPanel(under);
  }, false);

  document.addEventListener('mousedown', function () {
    pointerMoved = true;
    if (pointerGuard) setPointerGuard(false);
  }, false);

  /* A wheel scrolls the icons without moving the focus; the page keeps the event
     while there is anywhere to scroll to, or the document behind would move. */
  elGrid.addEventListener('wheel', function (ev) {
    if (!scrollMax()) return;
    ev.preventDefault();
    setScroll(scrollY + (ev.deltaY > 0 ? 1 : -1) * Math.round(elGrid.clientHeight / S.rows()));
    paintFocus(true);
  }, { passive: false });

  return {
    open: open,
    close: close,
    isOpen: function () { return isOpen; },
    handleKey: handleKey,
    load: load,
    /* Which source the list came from (Settings -> Applications shows it). */
    source: function () { return listVia; },
    forgetIcons: function () { forgetIcons(); },
    /* Puts the focus back on the quick button that opened the submenu column,
       and hides the column (app.js: the app is brought back by Home). */
    closeSub: function () { closeSub(); },
    reveal: reveal,
    onCursor: onCursor,
    rest: rest,
    playIn: playIn,
    /* After a language, an icon set, the visible apps or the geometry changed. */
    relabel: function () {
      applyVisibility();
      if (isOpen) render();
    }
  };
})();
