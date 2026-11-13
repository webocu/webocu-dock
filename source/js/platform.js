/* =========================================================================
   webOS platform glue: device info, Magic Remote cursor, UI scaling, exit.
   Everything degrades gracefully in a desktop browser.
   ========================================================================= */
window.Platform = (function () {
  var sys = window.webOSSystem || window.PalmSystem || null;
  var isWebOS = !!sys || typeof window.PalmServiceBridge !== 'undefined';

  function deviceInfo() {
    var info = {
      modelName: '—',
      firmwareVersion: '—',
      sdkVersion: '—',
      screenWidth: 1920,
      screenHeight: 1080,
      uhd: false
    };
    if (sys && sys.deviceInfo) {
      try {
        var d = typeof sys.deviceInfo === 'string' ? JSON.parse(sys.deviceInfo) : sys.deviceInfo;
        info.modelName = d.modelName || info.modelName;
        info.firmwareVersion = d.version || d.firmwareVersion || info.firmwareVersion;
        info.sdkVersion = d.sdkVersion || info.sdkVersion;
        info.screenWidth = d.screenWidth || info.screenWidth;
        info.screenHeight = d.screenHeight || info.screenHeight;
        info.uhd = !!d.uhd;
      } catch (e) { /* malformed JSON from the platform */ }
    }
    return info;
  }

  /* Reads a file that travels inside the package (about.html, appinfo.json).
     WAM lets a packaged app read its own files, and a file:// read answers with
     status 0 instead of 200 — both count. Failures end up as null in the
     callback, so a missing file never throws in the middle of a render. */
  function loadText(path, cb) {
    var done = cb || function () {};
    var request;
    try { request = new XMLHttpRequest(); } catch (e) { done(null); return; }

    request.onreadystatechange = function () {
      if (request.readyState !== 4) return;
      var ok = request.status === 0 || (request.status >= 200 && request.status < 300);
      done(ok && request.responseText ? request.responseText : null);
    };

    try {
      request.open('GET', path, true);
      request.send(null);
    } catch (e) {
      done(null);
    }
  }

  /* The manifest as the TV reads it; used for the version in About. */
  var manifest;
  function appInfo(cb) {
    if (typeof manifest !== 'undefined') { cb(manifest); return; }
    loadText('appinfo.json', function (text) {
      try { manifest = text ? JSON.parse(text) : null; } catch (e) { manifest = null; }
      cb(manifest);
    });
  }

  /* Current application ID from appinfo.json. */
  function getAppId(cb) {
    appInfo(function (info) {
      cb(info && info.id ? info.id : 'webocu.dock');
    });
  }

  /* Launch parameters, also delivered on relaunch. */
  function launchParams() {
    if (!sys || !sys.launchParams) return {};
    try {
      return typeof sys.launchParams === 'string' ? JSON.parse(sys.launchParams) : sys.launchParams;
    } catch (e) {
      return {};
    }
  }

  /* Race condition guard: prevent multiple simultaneous exit attempts. */
  var isExiting = false;

  /* Leaving the app: either close fully or hide to keep in memory for fast
     recall. User configurable Keep Alive toggle in Tweaks section (default: ON). */
  function exitApp(force) {
    // Idempotent guard: ignore if already exiting (rapid BACK presses).
    if (isExiting) return;
    isExiting = true;

    // Browser fallback: always try to close the tab.
    if (!isWebOS) {
      try { window.close(); } catch (e) { /* not allowed in a plain browser tab */ }
      isExiting = false;
      return;
    }

    // Always hide (keep in memory), never exit completely.
    // App lifecycle is managed by Keep Alive settings (internal service or external daemon).
    if (sys && typeof sys.hide === 'function') sys.hide();
    else if (sys && typeof sys.deactivate === 'function') sys.deactivate();
    else console.warn('[webocu-dock] hide/deactivate methods unavailable');

    // Reset guard after hide completes.
    setTimeout(function () {
      console.log('[webocu-dock] hidden; staying in memory for fast recall');
      isExiting = false;
    }, 300);
  }

  /* Leaving the app for good, so that the next launch is a cold start: used by
     a boot start with Autostart off. hide() is no way out here: a window hidden
     before it was ever shown is not raised again by a later launch (TV log: HOME
     sent the launch, the application manager answered, and no window ever turned
     visible), while closeByAppId followed by HOME opened the app. If the page is
     still alive after two seconds the close did not work on this firmware, and
     `survived` gets to show the dock instead of leaving a window nobody can
     bring back. In a browser it is the same as exitApp(). */
  function quitApp(survived) {
    if (!isWebOS) { exitApp(); return; }
    try { window.close(); } catch (e) { console.warn('[webocu-dock] close: ' + e.message); }
    setTimeout(function () {
      console.warn('[webocu-dock] window.close() did not end the app');
      if (survived) survived();
    }, 2000);
  }

  /* Whether the Magic Remote pointer is on the screen, as far as the app has been told:
     the TV draws it, and the app only hears of it (cursorStateChange) — it cannot hide it.
     The dock reads it when it is shown, to tell a call by the pointer from one by a key. */
  var cursorOn = false;

  function setCursorState(on) {
    cursorOn = !!on;
    document.documentElement.setAttribute('data-cursor', cursorOn ? 'on' : 'off');
  }

  /* What the pointer was doing when the app was last hidden: nothing is heard of it while
     the app is in the background, so the state is put away then (parkCursor) and the next
     showing starts from "no pointer" unless cursorStateChange says there is one. A pointer
     that was on the screen when the app went away, and a call that finds it there, is a
     call by the pointer; one that finds none is a call by a key (HOME). */
  var parked = false;

  function parkCursor() {
    parked = cursorOn;
    setCursorState(false);
  }

  /* ?cursor=on (a desktop browser has no cursorStateChange): the pointer was on the screen
     before the showing and is now, which is a call by the pointer. */
  function presetCursor(on) {
    parked = !!on;
    setCursorState(on);
  }

  /* An arrow the app asked the TV to press for it (the pointer put away, see
     Luna.hidePointer) comes back to the app as a real key: it is swallowed, once, when it
     comes within the window it was asked for. */
  var swallow = { action: null, until: 0 };

  function swallowKey(action, ms) {
    swallow.action = action;
    swallow.until = Date.now() + ms;
  }

  function takeSwallowed(action) {
    if (swallow.action !== action || Date.now() > swallow.until) return false;
    swallow.action = null;
    return true;
  }

  /* webOS fires cursorStateChange when the Magic Remote pointer appears. */
  function watchCursor(onChange) {
    document.addEventListener('cursorStateChange', function (e) {
      var visible = !!(e.detail && e.detail.visibility);
      setCursorState(visible);
      if (onChange) onChange(visible);
    }, false);
    setCursorState(false);
  }

  /* The UI is laid out for 1920x1080; scale it down in smaller windows. */
  function bindUiScale() {
    function apply() {
      var scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      document.documentElement.style.setProperty('--ui-scale', scale.toFixed(5));
    }
    window.addEventListener('resize', apply, false);
    apply();
  }

  function markPlatform() {
    document.documentElement.setAttribute('data-platform', isWebOS ? 'webos' : 'browser');
  }

  return {
    isWebOS: isWebOS,
    deviceInfo: deviceInfo,
    loadText: loadText,
    appInfo: appInfo,
    getAppId: getAppId,
    launchParams: launchParams,
    exitApp: exitApp,
    quitApp: quitApp,
    watchCursor: watchCursor,
    cursorVisible: function () { return cursorOn; },
    cursorWasVisible: function () { return parked; },
    parkCursor: parkCursor,
    presetCursor: presetCursor,
    swallowKey: swallowKey,
    takeSwallowed: takeSwallowed,
    setCursorState: setCursorState,
    bindUiScale: bindUiScale,
    markPlatform: markPlatform
  };
})();
