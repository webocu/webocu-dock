/* =========================================================================
   Entry point: remote key routing, the dock and the Settings window, app
   lifecycle and the debug params.
   ========================================================================= */

/* Track app start time for uptime reporting */
window.appStartTime = Date.now();

(function () {
  /* --------------------------------------------------------- debug params -- */
  /* Read first: ?apps= decides what the very first read of the app list
     returns, so it has to be in place before the dock opens. Applied further
     down, in the order the comment at the end explains. */
  var query = {};
  window.location.search.replace(/^\?/, '').split('&').forEach(function (pair) {
    if (!pair) return;
    var parts = pair.split('=');
    query[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || '1');
  });
  if ('apps' in query) window.Luna.mockApps(query.apps);
  if ('inputs' in query) window.Luna.mockInputs(query.inputs);
  if ('pair' in query) window.Luna.mockPair(query.pair);

  /* ----------------------------------------------------------- bootstrap -- */
  window.Platform.markPlatform();
  window.Platform.bindUiScale();
  /* The TV says when its pointer comes and goes: the dock decides whether to put it away
     (Tweaks -> HOME bound to the dock) and the page only keeps the state. */
  window.Platform.watchCursor(function (visible) { window.Dock.onCursor(visible); });

  /* The app's own preferences (language, theme) come from localStorage and are
     applied before anything is drawn. The TV locale is not followed: English is
     the language of a fresh install until the user picks another one. */
  if (window.Settings.applyAppPrefs()) window.Menu.relabel();

  /* Four previews are needed before the first showing, so they are read here and not
     with the others at the end: ?openAtStart=, ?autohide=, ?openFocus= and ?dockEffect=. */
  if ('openAtStart' in query) window.Settings.previewOpenAtStart(query.openAtStart);
  if ('openFocus' in query) window.Settings.previewOpenFocus(query.openFocus);
  if ('dockEffect' in query) window.Settings.previewDockEffect(query.dockEffect);
  if ('homeBound' in query) window.Settings.previewHomeBound(query.homeBound);
  /* ?cursor=on: the pointer is on the screen when the dock is first shown, as it is when a
     Magic Remote calls the dock (a desktop browser has no cursorStateChange to say so). */
  if (query.cursor === 'on') window.Platform.presetCursor(true);
  if ('autohide' in query) window.Settings.previewAutoHide(query.autohide);

  /* Started by the TV (Keep Alive -> Init script passes params.boot) rather than
     by the user: Settings -> General -> Autostart decides whether this first
     showing happens at all. ?boot=1 stands in for it in a desktop browser. */
  var launched = window.Platform.launchParams() || {};
  var bootStart = !!launched.boot || ('boot' in query && query.boot !== '0');
  var startHidden = bootStart && !window.Settings.openAtStart();

  /* Whether a surface of ours is up. While neither is, the app owns nothing:
     no key is taken (route) and the backdrop that catches the pointer is gone
     (data-shown, app.css), so the remote belongs to what is in front. */
  function syncShown() {
    var on = window.Dock.isOpen() || window.Menu.isOpen();
    document.documentElement.setAttribute('data-shown', on ? 'on' : 'off');
  }

  /* The first showing: the dock, or nothing when the TV started the app and
     Autostart is off. That is decided before the dock is ever opened, so it
     does not flash. The app then quits instead of hiding: nothing stays in
     memory, and HOME or the launcher starts it cold (see Platform.quitApp). If
     quitting does not work the dock is shown, as with Autostart on. */
  function showFirst() {
    if (startHidden) {
      console.log('[webocu-dock] boot launch: autostart is off, quitting (cold start on next launch)');
      window.Platform.quitApp(function () {
        window.Dock.open();
        syncShown();
      });
    } else {
      window.Dock.open();
    }
    syncShown();
  }

  /* Headless detection: navigator.userAgent contains 'HeadlessChrome' when running
     in smoke tests. This is NOT a security check - it's purely for test timing.
     Headless mode uses synchronous XHR to ensure icons load before DOM snapshot.
     Production mode loads asynchronously for better UX. */
  var isHeadless = navigator.userAgent.indexOf('HeadlessChrome') >= 0;

  if (isHeadless) {
    window.Settings.loadIconsSync();
    window.Menu.relabel();  /* Rebuild the rail of the window with loaded icons. */
    showFirst();
  } else {
    /* Production mode: the dock opens immediately with the fallback icon on its
       button; the SVG files load in background and replace it when ready. */
    showFirst();
    window.Settings.loadIcons(function (success) {
      if (!success) return;
      window.Menu.relabel();
      window.Dock.relabel();
    });
  }

  /* The state of the helper service arrives asynchronously (Tweaks shows it). */
  window.Settings.loadDeviceInfo(function () {
    window.Menu.relabel();
    /* No root yet: ask for it, silently. With it the service lists the apps and
       keeps the keepalive script in place; a list that could not be read before
       is read again. A failure here changes nothing. */
    try {
      window.Settings.autoElevate(function (root) {
        if (!root) return;
        /* Whether HOME is bound to the dock is read once when nothing is known yet. */
        window.Settings.refreshHomeBound();
        window.Menu.relabel();
        if (window.Dock.isOpen()) window.Dock.load();
      });
    } catch (e) {
      console.warn('[webocu-dock] auto elevate: ' + e.message);
    }
  });

  /* ------------------------------------------------- dock <-> settings -- */
  /* The two never share the screen: the window stands in the middle of the
     picture and the dock would only be a second focus target beside it. */
  document.addEventListener('settings:open', function () {
    window.Dock.close();
    window.Menu.open();
    syncShown();
    stopIdle();   /* the window is worked in: it never hides on its own */
  }, false);

  document.addEventListener('settings:close', function () {
    window.Menu.close();
    window.Dock.open();
    syncShown();
    armIdle();
  }, false);

  /* ---------------------------------------------------------- leaving -- */
  /* The dock is the whole app, so leaving hides the app: that is what hands
     the input focus back to whatever is playing underneath. */
  document.addEventListener('app:exit', function () {
    window.Menu.hideToast();
    window.Platform.exitApp();
  }, false);

  /* ---------------------------------------------------------- key routing - */
  /* One router for the remote and for ?keys=: the dialog wins over everything,
     then whichever of the two surfaces is up. Back and the menu key that
     neither of them took leave the app. With nothing up the key is not ours at
     all: it is not taken, and no arrow brings the dock back — whatever is in
     front of the picture keeps the remote. */
  function route(action) {
    if (window.Dialog.handleKey(action)) return true;
    if (window.Menu.isOpen()) return window.Menu.handleKey(action);
    if (!window.Dock.isOpen()) return false;
    if (window.Dock.handleKey(action)) return true;

    if (action === 'back' || action === 'menu') {
      document.dispatchEvent(new CustomEvent('app:exit'));
      return true;
    }
    return false;
  }

  document.addEventListener('keydown', function (ev) {
    var action = window.keyAction(ev.keyCode);
    /* The arrow that puts the pointer away comes back as a real key: not for the dock. */
    if (action && window.Platform.takeSwallowed(action)) { ev.preventDefault(); return; }
    if (action && route(action)) ev.preventDefault();
    /* Every key counts as activity, mapped or not, and after the route: a value
       picked by this very press is the one the new timer uses. */
    armIdle();
  }, false);

  /* ---------------------------------------------------------- idle hide --- */
  /* Settings -> General -> Auto-hide: this many seconds without a key or pointer
     movement and the app hides (the same exit as Back), so it never keeps the
     remote from the picture underneath. The window of Settings is exempt, and
     so is a hidden app. Only on a TV, or when ?autohide= asks for it: in a
     desktop browser (shots, smoke) nothing may hide by itself. */
  var idleTimer = null;
  var idleOn = window.Platform.isWebOS || 'autohide' in query;

  function stopIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function armIdle() {
    stopIdle();
    /* A Power Off / Restart window counts five seconds itself: the dock must not
       hide under it. */
    if (!idleOn || document.hidden || window.Menu.isOpen() || !window.Dock.isOpen() || window.Dialog.isOpen()) return;
    var seconds = window.Settings.autoHideSeconds();
    idleTimer = setTimeout(function () {
      idleTimer = null;
      /* Armed by a press of the pointer that then opened a Power Off / Restart
         window: the window is worked in, the dock stays. */
      if (window.Dialog.isOpen()) return;
      console.log('[webocu-dock] idle ' + seconds + 's: hiding');
      document.dispatchEvent(new CustomEvent('app:exit'));
    }, seconds * 1000);
  }

  /* Pointer activity of the Magic Remote; listeners that never block a scroll. */
  ['mousemove', 'mousedown', 'wheel'].forEach(function (name) {
    document.addEventListener(name, armIdle, { passive: true });
  });

  /* Clicking the empty area (the picture) with the Magic Remote leaves the app,
     the way Back does: the overlay must not keep swallowing remote input. With
     nothing up there is no backdrop to click (data-shown), and this does
     nothing. */
  document.getElementById('backdrop').addEventListener('click', function () {
    if (!window.Dock.isOpen() && !window.Menu.isOpen()) return;
    window.Menu.close();
    window.Dock.close();
    document.dispatchEvent(new CustomEvent('app:exit'));
  }, false);

  /* ----------------------------------------------------------- lifecycle -- */
  document.addEventListener('visibilitychange', function () {
    /* Back from the background: the dock draws its cached list again (no luna
       call — Dock.load reads the TV only when there is no cache yet, or when
       Settings -> Applications -> Read the list again asks it to). */
    /* Hidden: the panel goes back to where its entrance starts, unseen, so that showing
       the app again plays the effect (General -> Appearance -> Dock -> Entrance effect). */
    if (document.hidden) {
      stopIdle();
      window.Dock.rest();
      /* Whether the pointer is on the screen is not known from here on: it is put away as
         "what it was when the app went" (a call that finds none is a call by a key), and
         the next showing starts from "no pointer" unless cursorStateChange says there is
         one. */
      window.Platform.parkCursor();
      return;
    }
    window.Dock.playIn();
    if (window.Menu.isOpen()) window.Menu.refresh();
    else if (window.Dock.isOpen()) window.Dock.load();
    armIdle();
  }, false);

  /* Brought back by the launcher or a hotkey: the dock comes up fresh, whatever
     was on screen when the app was hidden — from the cached list, see above.
     Back only hides the window, so the column of the Submenu button is still up
     in it; Home again must not find the focus on an item of that column but on
     the button that opened it, with the column gone. Then the focus goes where
     General -> Focus on open says (reveal), before the list is read again. */
  document.addEventListener('webOSRelaunch', function () {
    window.Menu.close();
    window.Dock.closeSub();
    if (window.Dock.isOpen()) { window.Dock.reveal(); window.Dock.load(); } else window.Dock.open();
    syncShown();
    armIdle();
  }, false);

  /* --------------------------------------------------------- debug params -- */
  /* ?apps=N|0|fail                     the app list a desktop browser gets: N
                                        generated apps, none, or a failed read
                                        (applied before the dock opens)
     ?inputs=N                          mock N TV inputs (HDMI) for the browser;
                                        they are rows of Applications, off by default
     ?pair=ok|prompt|fail               mock the SSAP pairing result (browser)
     ?hide=id1,id2                      preview the dock without those apps
     ?cols=1..7                         preview the number of dock columns
     ?side=left|right                   preview the edge of the screen the dock stands at
     ?rows=3..7                         preview the rows on screen
     ?dockX=0..960                      preview the offset from that edge
     ?dockY=-540..540                   preview the shift from the centre of
                                        the height (minus is up; clamped so the
                                        panel stays on screen)
     ?q1= ?q2= ?q3=                     preview a quick button of the foot: off|home|
                                        syssettings|store|browser|media|homehub|poweroff|
                                        restart|screenoff|submenu (OK on submenu opens
                                        its row of icons: add keys=...,enter to shoot it)
                                        (1 and 2 show from two columns up)
     ?q4=settings|submenu               the fourth button of the foot: Settings (the
                                        default) or the Submenu
     ?sub=poweroff,restart,screenoff,home
                                        preview the items of the submenu, from the top
                                        (the commands of Appearance -> Quick launch ->
                                        Submenu plus settings, or off for an empty place;
                                        ?sub=off is a submenu with no place set: the
                                        column holds the dock's Settings only, which is
                                        always kept in it)
     ?home=off|home|poweroff|restart    the third quick button, as it was before them
                                        (0 / 1 too)
     ?labels=0..60                      preview the seconds the name balloon stays
                                        after an arrow or the pointer moved the
                                        focus (0 = never shown; the default is 0.5;
                                        the row of the window offers 0 0.5 1 3 5,
                                        a preview is held to no list)
     ?labelPlace=tile|dock              where the name stands: against the icon, or
                                        beside the panel of the dock (the default)
     ?hints=0|1                         the names of all three kinds of tile switched off /
                                        on (Appearance -> Hints; in a fresh install the
                                        apps and the quick buttons are off, the submenu on)
     ?hintsApps=0|1 ?hintsQuick=0|1 ?hintsSub=0|1
                                        the names of the apps / the quick buttons / the
                                        items of the submenu, each on its own
     ?hintStyle=pill|soft|solid|text|compact
                                        how the name looks (pill is the default)
     ?hintEffect=slide|fade|pop|none    how the name comes up (slide is the default)
     ?hintText=0|1 ?hintBorder=0|1      the letters / the frame in the accent colour
     ?autohide=5|10|20|30|60            preview the idle seconds before the app
                                        hides itself (also switches the timer on
                                        in a desktop browser, where it is off)
     ?cursor=on                         the pointer is on the screen at the first
                                        showing (a call by the Magic Remote); without
                                        it a call by a key: the pointer moves no focus
                                        until it is moved, and with HOME bound to the
                                        dock it is put away
     ?homeBound=0|1                     preview "HOME is bound to the dock" (what
                                        puts the pointer away depends on it)
     ?cursorShow=1                      the TV's pointer comes 100 ms after the first
                                        showing, as when HOME calls the dock
                                        (data-cursor-hide on <html> tells the outcome)
     ?dockEffect=edge|opposite|top|bottom|fade|pop|none
                                        how the dock comes onto the screen: out from
                                        behind its own side (the default), from the
                                        opposite side, from the top or the bottom,
                                        faded, grown, or at once
                                        (applied before the first showing)
     ?openFocus=last|first|end          where the focus of the dock stands whenever the
                                        dock is shown (applied before the first
                                        showing): where it was left (the default),
                                        the first app, or the last one
     ?openAtStart=0|1                   preview Autostart (applied before the
                                        first showing)
     ?boot=1                            pretend the TV started the app (what the
                                        launch param boot does on a TV); with
                                        ?openAtStart=0 the dock is not drawn and
                                        the page closes itself
     ?time=24h|24hn|12h|off             preview the clock above the icons
     ?date=wday|dmy|mdy|ymd|dmon|dmonwd|dm|wdaydm|wdaynum|dlong|off
                                        preview the date under the foot
     ?clockSize=xs|s|m|l|xl             preview the size of the clock (m is the default)
     ?dateSize=xs|s|m|l|xl              preview the size of the date
     ?section=common|look|apps|tweaks|about
                                        open the Settings window on a section
     ?section=switchAppId|keepalive     open a submenu (its section first)
     ?expand=appLanguage                open a select list
     ?confirm=appReset                  show the confirmation of an action
     ?theme=dark|light                  preview a mode without storing it
     ?contrast=1|0                      preview the contrast theme (?theme=contrast
                                        still works: this mode, high contrast)
     ?accent=red|azure|...              preview an accent colour (see ACCENTS)
     ?bg=0..100 ?bgRail=0..100          preview how solid the pictures from
                                        img/*.png are (step 10, 0 = no picture)
     ?transparency=0..70                preview the transparency (step 5, ceiling 70;
                                        0 is the default)
     ?toastAt=top-left|bottom-right|... preview where the balloon appears
                                        (edge[-alignment], centre when omitted)
     ?lang=en|ru                        preview a language without storing it
     ?toast=busy                        show the pending balloon (spinner)
     ?panel=0                           start with the dock hidden
     ?keys=enter,down,down              press remote keys, in that order: the
                                        only way a headless run can reach what
                                        needs several presses. Applied last,
                                        through the same router as the remote
                                        ('relaunch' is no key: it is Home pressed
                                        again, the event the TV sends to an app that
                                        is already up) */
  /* What ?keys= accepts. 'menu' is left out on purpose: it would leave the app,
     and a debug param that unloads the page has nothing left to dump. */
  var ACTIONS = ['up', 'down', 'left', 'right', 'enter', 'back'];

  if (query.theme) window.Settings.previewTheme(query.theme);
  if (query.contrast) window.Settings.previewContrast(query.contrast);
  if (query.accent) window.Settings.previewAccent(query.accent);
  if ('bg' in query) window.Settings.previewBg(query.bg);
  if ('bgRail' in query) window.Settings.previewBgRail(query.bgRail);
  if (query.transparency) window.Settings.previewTransparency(query.transparency);
  /* The dock lays its tiles out by these, so it is drawn again once. */
  var dockPreview = false;
  if (query.cols && window.Settings.previewColumns(query.cols)) dockPreview = true;
  if (query.side && window.Settings.previewSide(query.side)) dockPreview = true;
  if (query.rows && window.Settings.previewRows(query.rows)) dockPreview = true;
  if (query.dockX && window.Settings.previewOffsetX(query.dockX)) dockPreview = true;
  if (query.dockY && window.Settings.previewOffsetY(query.dockY)) dockPreview = true;
  if (query.q1 && window.Settings.previewQuick(1, query.q1)) dockPreview = true;
  if (query.q2 && window.Settings.previewQuick(2, query.q2)) dockPreview = true;
  if (query.q3 && window.Settings.previewQuick(3, query.q3)) dockPreview = true;
  if (query.q4 && window.Settings.previewQuick4(query.q4)) dockPreview = true;
  if (query.sub && window.Settings.previewSub(query.sub)) dockPreview = true;
  if (query.home && window.Settings.previewQuick(3, query.home)) dockPreview = true;
  if (query.labels && window.Settings.previewLabels(query.labels)) dockPreview = true;
  if (query.labelPlace && window.Settings.previewLabelPlace(query.labelPlace)) dockPreview = true;
  if (query.hints && window.Settings.previewHints('on', query.hints)) dockPreview = true;
  if (query.hintsApps && window.Settings.previewHints('apps', query.hintsApps)) dockPreview = true;
  if (query.hintsQuick && window.Settings.previewHints('quick', query.hintsQuick)) dockPreview = true;
  if (query.hintsSub && window.Settings.previewHints('sub', query.hintsSub)) dockPreview = true;
  if (query.hintStyle && window.Settings.previewHints('style', query.hintStyle)) dockPreview = true;
  if (query.hintEffect && window.Settings.previewHints('effect', query.hintEffect)) dockPreview = true;
  if (query.hintText && window.Settings.previewHints('text', query.hintText)) dockPreview = true;
  if (query.hintBorder && window.Settings.previewHints('border', query.hintBorder)) dockPreview = true;
  if ((query.time || query.date) && window.Settings.previewClock(query.time, query.date)) dockPreview = true;
  if (query.clockSize && window.Settings.previewClockSize('appClockSize', query.clockSize)) dockPreview = true;
  if (query.dateSize && window.Settings.previewClockSize('appDateSize', query.dateSize)) dockPreview = true;
  /* "?hide=" alone is a preview too: the parser makes it '1', nobody's id, so
     every app is on the dock whatever the store says. */
  if ('hide' in query && window.Settings.previewHidden(query.hide)) dockPreview = true;
  if (dockPreview) window.Dock.relabel();
  if (query.toastAt) window.Settings.previewToast(query.toastAt);
  if (query.lang && window.I18N.setLang(query.lang)) {
    window.Menu.relabel();
    window.Dock.relabel();
  }
  if (query.panel === '0') window.Dock.close();
  if (query.section) {
    window.Dock.close();
    window.Menu.showSection(query.section);
  }
  if (query.expand) {
    window.Dock.close();
    window.Menu.expand(query.expand);
  }
  if (query.confirm) {
    window.Dock.close();
    window.Menu.confirmAction(query.confirm);
  }
  /* What the TV does when HOME calls the dock: the pointer shows up a moment later, by
     itself (the same event, cursorStateChange, a Magic Remote's pointer comes with). */
  if (query.cursorShow) {
    setTimeout(function () {
      document.dispatchEvent(new CustomEvent('cursorStateChange', { detail: { visibility: true } }));
    }, 100);
  }
  // Nothing is sent: only the balloon a long luna call would leave on screen.
  if (query.toast === 'busy') window.Menu.busy(window.I18N.t('toast.launching', { name: 'Media Player' }));
  /* Last, so every other param has already put the app where the presses are
     meant to land. Only the named actions go through — the same ones the remote
     produces (see keys.js), no key codes and nothing the app cannot do. */
  if (query.keys) {
    query.keys.split(',').forEach(function (action) {
      if (ACTIONS.indexOf(action) >= 0) route(action);
      else if (action === 'relaunch') document.dispatchEvent(new CustomEvent('webOSRelaunch'));
    });
  }

  /* After every param has put the app where it is meant to be: the backdrop
     follows what is up, and the idle count starts (not for a hidden start). */
  syncShown();
  armIdle();

  var info = window.Platform.deviceInfo();
  console.log('[webocu-dock] start; webOS=' + window.Platform.isWebOS +
    '; luna=' + window.Luna.isAvailable() +
    '; model=' + info.modelName + '; fw=' + info.firmwareVersion +
    '; lang=' + window.I18N.lang());
})();
