/* =========================================================================
   luna-service access layer.

   Calls go through the built-in PalmServiceBridge, so the project needs no
   external SDK library (webOSTV.js). Every public method takes a callback
   with (result, info) where info = { mocked: Boolean, error: String|null }.

   The dock needs two things from the TV: the list of installed apps and a way
   to start one. A Developer Mode web app may or may not be allowed to ask the
   application manager directly (it depends on the firmware), so each call is a
   chain:

     1. webocu.dock.service  — our own helper service; it answers unprivileged
        and does more once elevated (Settings -> Tweaks -> Request privileges);
     2. the plain luna endpoints — work on firmwares that allow them.

   The next candidate is tried whenever the previous one fails, and every
   failure is logged, so the app log shows which path the TV accepted.
   ========================================================================= */
window.Luna = (function () {
  var available = typeof window.PalmServiceBridge !== 'undefined';
  var keepAlive = [];   // subscriptions must be referenced or GC kills the channel

  /* The service id the package ships with. tools/lint.sh looks for this very
     literal: the service manifest and this file have to agree on it, or every
     call below silently falls through to the plain endpoints. */
  var DEFAULT_SERVICE_ID = 'webocu.dock.service';

  /* Get the current app ID from PalmSystem.identifier, or use the default.
     When the app is switched to another ID (amazon, netflix, etc.), the service
     ID follows: amazon → amazon.service, netflix → netflix.service. */
  function getAppId() {
    var sys = window.webOSSystem || window.PalmSystem || null;
    if (sys && sys.identifier) {
      return String(sys.identifier);
    }
    return DEFAULT_SERVICE_ID.replace(/\.service$/, '');
  }

  var APP_ID = getAppId();
  var SERVICE_ID = APP_ID + '.service';
  var SERVICE = 'luna://' + SERVICE_ID;
  var HBCHANNEL = 'luna://org.webosbrew.hbchannel.service';
  var HB_DIR = '/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service';
  /* Application manager handles app listing and launching. */
  var APPMGR = 'luna://com.webos.service.applicationmanager';
  /* Power. tvpower/power/reboot shuts the TV down instead of bringing it back
     up, so a restart goes to the sleep service (the call the system itself makes
     for one). The firmware matches the reason against its own list and some
     builds ignore an unknown one, so it is the one the remote key sends. */
  var TVPOWER = 'luna://com.webos.service.tvpower';
  var POWER = 'luna://com.webos.service.power';
  var SLEEP = 'luna://com.webos.service.sleep';
  var POWER_REASON = 'remoteKey';
  /* The name the application manager answered under before it moved into the
     com.webos.service namespace; some firmwares still keep only this alias. */
  var APPMGR_LEGACY = 'luna://com.webos.applicationManager';

  function noop() {}

  /* Single request. Returns the bridge (or null when unavailable). */
  function call(uri, params, onOk, onErr) {
    if (!available) {
      if (onErr) onErr({ returnValue: false, errorText: 'no bridge', mocked: true });
      return null;
    }
    var bridge = new window.PalmServiceBridge();
    bridge.onservicecallback = function (payload) {
      var res;
      try { res = JSON.parse(payload); } catch (e) { res = { returnValue: false, errorText: 'bad json' }; }
      if (res.returnValue === false) { if (onErr) onErr(res); } else if (onOk) onOk(res);
    };
    bridge.call(uri, JSON.stringify(params || {}));
    return bridge;
  }

  /* Subscription; the bridge is kept in module scope on purpose. */
  function subscribe(uri, params, onOk, onErr) {
    var p = params || {};
    p.subscribe = true;
    var bridge = call(uri, p, onOk, onErr);
    if (bridge) keepAlive.push(bridge);
    return bridge;
  }

  /* Try candidates one by one until one succeeds.
     A candidate may carry ok(res) when returnValue alone does not prove that
     the action happened (Homebrew Channel exec reports the shell, not luna). */
  function chain(candidates, cb) {
    var i = 0;
    function attempt() {
      if (i >= candidates.length) {
        cb(false, { mocked: !available, error: available ? 'all endpoints failed' : 'no bridge' });
        return;
      }
      var c = candidates[i++];
      call(c.uri, c.params,
        function (res) {
          if (c.ok && !c.ok(res)) {
            console.warn('[luna] ' + c.uri + ' ran but reported no success');
            attempt();
            return;
          }
          console.log('[luna] ' + c.uri + ' accepted the call');
          cb(true, { mocked: false, error: null, uri: c.uri, root: res && res.root });
        },
        function (err) {
          console.warn('[luna] ' + c.uri + ' failed: ' + (err && err.errorText));
          attempt();
        });
    }
    attempt();
  }

  /* Like chain(), but the point is the payload, not the fact of success: each
     candidate carries pick(res) and the first one that picks something wins.
     cb(data, info) with data === null when every candidate came up empty. */
  function chainData(candidates, cb) {
    var i = 0;
    function attempt() {
      if (i >= candidates.length) {
        cb(null, { mocked: !available, error: available ? 'all endpoints failed' : 'no bridge' });
        return;
      }
      var c = candidates[i++];
      call(c.uri, c.params,
        function (res) {
          var data = null;
          try { data = c.pick(res); } catch (e) { data = null; }
          if (data === null || typeof data === 'undefined') {
            console.warn('[luna] ' + c.uri + ' answered without the data we need');
            attempt();
            return;
          }
          console.log('[luna] ' + c.uri + ' answered');
          cb(data, { mocked: false, error: null, uri: c.uri });
        },
        function (err) {
          console.warn('[luna] ' + c.uri + ' failed: ' + (err && err.errorText));
          attempt();
        });
    }
    attempt();
  }

  /* ------------------------------------------------- privileged fallbacks -- */
  /* Homebrew Channel exec of a plain shell command: returnValue alone is the
     verdict, because the output is not a luna reply to look into. */
  function hbShell(command) {
    return { uri: HBCHANNEL + '/exec', params: { command: command } };
  }

  /* ------------------------------------------------------- helper service -- */
  /* Desktop debugging has no service to ask, so the keepalive reply is an
     obviously fake one rather than nothing at all. */
  var MOCK_KEEPALIVE = {
    version: '0.0.0',
    wifi: { ipAddress: 'xxx.xxx.xxx.xxx' },
    wired: null,
    timestamp: 0
  };

  /* Is the helper service there, and is it privileged?
     cb({ running: Boolean, root: Boolean, startTime: Number|null }) */
  function serviceStatus(cb) {
    call(SERVICE + '/status', {},
      function (res) {
        cb({
          running: true,
          root: !!(res && res.root),
          startTime: res && res.startTime ? res.startTime : null
        });
      },
      function () { cb({ running: false, root: false, mocked: !available }); });
  }

  /* Keepalive endpoint: returns version, IP addresses, and timestamp.
     Designed for external monitoring to keep the app alive.
     cb(data, info) where data = { version, wifi, wired, timestamp } */
  function keepalive(cb) {
    var done = cb || noop;
    if (!available) {
      var mock = {
        version: MOCK_KEEPALIVE.version,
        wifi: MOCK_KEEPALIVE.wifi,
        wired: MOCK_KEEPALIVE.wired,
        timestamp: Date.now(),
        serviceUptime: 0,
        clientUptime: Math.floor((Date.now() - (window.appStartTime || Date.now())) / 1000)
      };
      done(mock, { mocked: true, error: null });
      return;
    }
    call(SERVICE + '/keepalive', {},
      function (res) {
        done({
          version: res.version || null,
          wifi: res.wifi || null,
          wired: res.wired || null,
          timestamp: res.timestamp || null,
          serviceUptime: res.serviceUptime || 0,
          clientUptime: Math.floor((Date.now() - (window.appStartTime || Date.now())) / 1000)
        }, { mocked: false, error: null });
      },
      function (err) {
        done(null, { mocked: false, error: (err && err.errorText) || 'failed' });
      });
  }

  /* Enable self-keepalive (service calls itself every 30s).
     cb(success, info) */
  function enableSelfKeepalive(cb) {
    var done = cb || noop;
    if (!available) {
      done(false, { mocked: true, error: 'no bridge' });
      return;
    }
    call(SERVICE + '/enableSelfKeepalive', {},
      function (res) {
        done(res.enabled === true, {
          mocked: false,
          error: res.errorText || null
        });
      },
      function (err) {
        done(false, {
          mocked: false,
          error: (err && err.errorText) || 'enable failed'
        });
      });
  }

  /* Disable self-keepalive (stop internal interval).
     cb(success, info) */
  function disableSelfKeepalive(cb) {
    var done = cb || noop;
    if (!available) {
      done(false, { mocked: true, error: 'no bridge' });
      return;
    }
    call(SERVICE + '/disableSelfKeepalive', {},
      function (res) {
        done(res.enabled === false, {
          mocked: false,
          error: res.errorText || null
        });
      },
      function (err) {
        done(false, {
          mocked: false,
          error: (err && err.errorText) || 'disable failed'
        });
      });
  }

  /* Check self-keepalive status.
     cb(status, info) where status = { enabled: bool } */
  function selfKeepaliveStatus(cb) {
    var done = cb || noop;
    if (!available) {
      done({ enabled: false }, { mocked: true, error: null });
      return;
    }
    call(SERVICE + '/selfKeepaliveStatus', {},
      function (res) {
        done({
          enabled: res.enabled === true
        }, { mocked: false, error: null });
      },
      function (err) {
        done({ enabled: false }, {
          mocked: false,
          error: (err && err.errorText) || 'status check failed'
        });
      });
  }

  /* Ask the Homebrew Channel to elevate our helper service -- the only way it is
     done: by the app itself at start (Settings.autoElevate) and by the row Tweaks
     -> Request privileges. The web app itself never gains rights: only the separate service process is respawned as
     root.
     cb(root, status) with status as reported by serviceStatus() afterwards. */
  function elevate(cb) {
    var done = cb || noop;
    if (!available) { done(false, { running: false, root: false, mocked: true }); return; }

    chain([
      hbShell(HB_DIR + '/elevate-service ' + SERVICE_ID),
      hbShell('/bin/sh ' + HB_DIR + '/elevate-service ' + SERVICE_ID)
    ], function (ok, info) {
      if (!ok) { done(false, { running: false, root: false, error: info && info.error }); return; }

      // The unprivileged instance has to die so the hub respawns it elevated.
      // The [w] pattern keeps pkill from matching its own command line.
      var pkillPattern = '[' + SERVICE_ID.charAt(0) + ']' + SERVICE_ID.slice(1);
      call(HBCHANNEL + '/exec',
        { command: 'pkill -f "' + pkillPattern + '" || true; ls-control scan-services || true' },
        recheck, recheck);
    });

    /* The hub needs a moment to pick the new role files up. */
    function recheck() {
      setTimeout(function () {
        serviceStatus(function (status) { done(!!status.root, status); });
      }, 1500);
    }
  }

  /* --------------------------------------------------------------- apps ---- */
  /* The External Input Manager: the TV's HDMI (and other) inputs, listable and
     switchable from a web app without root, each one an app of its own
     (com.webos.app.hdmiN). The dock shows them as a group when asked to. */
  var EIM = 'luna://com.webos.service.eim';

  /* What a desktop browser gets instead of the TV's list: a handful of user apps
     plus one entry of every kind the dock has to leave out (a system app, a
     hidden one and the dock itself), so the filter is exercised too. Every icon
     but one points into the TV's file system and fails to load here, which is
     the letter-tile fallback the dock falls back to on the TV as well; the one
     packaged with the app shows the picture path working. */
  var MOCK_APPS = [
    { id: 'org.webosbrew.hbchannel', title: 'Homebrew Channel', icon: 'icons/largeIcon.png', folderPath: '', systemApp: false, visible: true, iconColor: '#1f2937' },
    { id: 'org.example.player', title: 'Media Player', icon: '/media/developer/apps/usr/palm/applications/org.example.player/icon.png', systemApp: false, visible: true, iconColor: '#7c3aed' },
    { id: 'org.example.video', title: 'Web Video', icon: '/media/developer/apps/usr/palm/applications/org.example.video/icon.png', systemApp: false, visible: true, iconColor: '#dc2626' },
    { id: 'org.example.music', title: 'Music', icon: '/media/developer/apps/usr/palm/applications/org.example.music/icon.png', systemApp: false, visible: true, iconColor: '#059669' },
    { id: 'org.example.weather', title: 'Weather', icon: '/media/developer/apps/usr/palm/applications/org.example.weather/icon.png', systemApp: false, visible: true, iconColor: '#0284c7' },
    { id: 'org.example.news', title: 'News', icon: '/media/developer/apps/usr/palm/applications/org.example.news/icon.png', systemApp: false, visible: true, iconColor: '#ea580c' },
    { id: 'org.example.photos', title: 'Photos', icon: '/media/developer/apps/usr/palm/applications/org.example.photos/icon.png', systemApp: false, visible: true, iconColor: '#db2777' },
    { id: 'org.example.radio', title: 'Radio', icon: '/media/developer/apps/usr/palm/applications/org.example.radio/icon.png', systemApp: false, visible: true, iconColor: '#ca8a04' },
    /* The app entry of an input: a system app, never a tile itself, but the
       source of the icon ?inputs= tiles borrow (dock.js combine). */
    { id: 'com.webos.app.hdmi1', title: 'HDMI 1', icon: 'icons/largeIcon.png', folderPath: '', systemApp: true, visible: true },
    { id: 'com.webos.app.browser', title: 'Web Browser', icon: '/usr/palm/applications/com.webos.app.browser/icon.png', systemApp: true, visible: true },
    { id: 'org.example.hidden', title: 'Hidden Helper', icon: '', systemApp: false, visible: false },
    { id: 'webocu.dock', title: 'WebOCU Dock', icon: 'icons/largeIcon.png', folderPath: '', systemApp: false, visible: true }
  ];

  /* What the next mocked listApps() answers (URL debug param ?apps=): null for
     the built-in list, 'fail' for a failed call, or a number of generated apps —
     zero is an empty TV, a big number a list that has to scroll. ?inputs= and
     ?pair= stand in for the two things only a real TV can do. */
  var mockSpec = null;
  var mockInputsSpec = null;
  var mockPairSpec = null;

  function mockApps(spec) {
    mockSpec = (spec === null || typeof spec === 'undefined') ? null : String(spec);
  }

  function mockInputs(spec) {
    mockInputsSpec = (spec === null || typeof spec === 'undefined') ? null : String(spec);
  }

  function mockPair(spec) {
    mockPairSpec = (spec === null || typeof spec === 'undefined') ? null : String(spec);
  }

  function mockList() {
    if (mockSpec === null) return MOCK_APPS.slice();
    if (mockSpec === 'fail') return null;
    var count = Math.max(0, Math.min(200, Number(mockSpec) || 0));
    var base = MOCK_APPS.slice(0, 8);
    var list = [];
    for (var i = 0; i < count; i++) {
      var from = base[i % base.length];
      list.push({
        id: from.id + '.' + i,
        title: from.title + ' ' + (i + 1),
        icon: from.icon,
        folderPath: from.folderPath,
        systemApp: false,
        visible: true,
        iconColor: from.iconColor
      });
    }
    return list;
  }

  /* One app of the TV's list, whichever shape it came in, as the dock wants it.
     `systemApp` from applicationmanager and `removable` from a launch point are
     both kept, so the dock can drop system apps by whichever field it has. */
  function normalizeApp(raw) {
    if (!raw || !raw.id) return null;
    return {
      id: String(raw.id),
      title: String(raw.title || raw.id),
      icon: raw.icon ? String(raw.icon) : '',
      largeIcon: raw.largeIcon ? String(raw.largeIcon) : '',
      folderPath: raw.folderPath ? String(raw.folderPath) : '',
      iconColor: raw.iconColor || raw.bgColor || null,
      systemApp: typeof raw.systemApp === 'boolean' ? raw.systemApp : undefined,
      removable: typeof raw.removable === 'boolean' ? raw.removable : undefined,
      visible: raw.visible
    };
  }

  function normalizeList(list) {
    if (!list) return null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var app = normalizeApp(list[i]);
      if (app) out.push(app);
    }
    return out;
  }

  /* List the installed apps. cb(apps, info), apps normalized or null, and
     info.via naming the source that answered: 'service' | 'appmgr' | 'ssap'.

     Three sources, kept apart so the read never asks the person anything:
       1. the helper service — it answers with the list only once elevated
          (root), and that is the whole story on a rooted TV;
       2. the plain applicationmanager endpoints, called by the app itself —
          many firmwares let a Developer Mode app read the list this way;
       3. SSAP, only when the TV was paired before (a key is stored), read
          with that key and no prompt.
     Pairing itself (the prompt on the TV) is never started from here: only the
     "Pair with TV" row of Settings -> Applications asks for it (ssapPair). A key
     the TV no longer accepts simply makes this source fail. */
  function listApps(cb) {
    var done = cb || noop;
    if (!available) {
      var mocked = mockList();
      done(normalizeList(mocked), { mocked: true, error: mocked ? null : 'mocked failure', via: 'mock' });
      return;
    }
    call(SERVICE + '/listApps', {},
      function (res) {
        var apps = pickApps(res);
        if (apps) { done(normalizeList(apps), { mocked: false, error: null, via: 'service', root: res.root }); return; }
        plain();
      },
      function (err) {
        console.warn('[luna] ' + SERVICE + '/listApps: ' + (err && err.errorText) +
                     (err && typeof err.root === 'boolean' ? ' (root=' + err.root + ')' : ' (service unreachable)'));
        plain();
      });

    function plain() {
      chainData([
        { uri: APPMGR + '/listApps', params: {}, pick: pickApps },
        { uri: APPMGR_LEGACY + '/listApps', params: {}, pick: pickApps },
        { uri: APPMGR + '/listLaunchPoints', params: {}, pick: pickPoints },
        { uri: APPMGR_LEGACY + '/listLaunchPoints', params: {}, pick: pickPoints }
      ], function (list, info) {
        if (list) { done(normalizeList(list), { mocked: false, error: null, via: 'appmgr', uri: info.uri }); return; }
        if (!ssapPaired()) { done(null, { mocked: false, error: info.error, via: null }); return; }
        ssapList(store('ssapKey'), storeJson('ssapRoute'), function (points, sInfo) {
          if (points) { done(normalizeList(points), { mocked: false, error: null, via: 'ssap' }); return; }
          console.warn('[luna] ssap list failed: ' + (sInfo && sInfo.error));
          done(null, { mocked: false, error: (sInfo && sInfo.error) || 'ssap failed', via: null, prompted: !!(sInfo && sInfo.prompted) });
        });
      });
    }
  }

  function pickApps(res) {
    return (res && res.apps && res.apps.length !== undefined) ? res.apps : null;
  }

  function pickPoints(res) {
    return (res && res.launchPoints && res.launchPoints.length !== undefined) ? res.launchPoints : null;
  }

  /* The SSAP key and route live in the same localStorage the rest of
     the app uses (window.Store), so a reset or a prune reaches them too. These
     wrappers keep the rest of this file reading plainly. */
  function store(id) { return window.Store ? window.Store.get(id, '') : ''; }
  function setStore(id, v) { if (window.Store) window.Store.set(id, v); }
  function clearStore(id) { if (window.Store) window.Store.set(id, ''); }
  function storeJson(id) { var v = window.Store ? window.Store.get(id, null) : null; return v || null; }
  function setStoreJson(id, v) { if (window.Store) window.Store.set(id, v); }

  /* ---------------------------------------------------------------- SSAP --- */
  /* How an un-rooted TV gives up its app list: the helper service pairs once over
     the TV's own second-screen websocket (the TV shows a one-time prompt) and
     keeps the key; later reads reuse it. Ported from Hearth (MIT), which worked
     this out — see about.html. The client never speaks SSAP itself: only the
     service can set the Origin header the firmware now demands. */
  var LIST_URI = 'ssap://com.webos.applicationManager/listLaunchPoints';
  var PAIR_WAIT_MS = 60000;

  /* The register message the TV wants, in two forms: the long modern one and the
     short legacy one, tried in that order (newer firmware shuts the door on the
     old text). The service tries each over each of its routes. */
  var SSAP_PERMS_NEW = ['LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CLOSE', 'TEST_OPEN', 'TEST_PROTECTED', 'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_MEDIA_PLAYBACK', 'CONTROL_INPUT_TV', 'CONTROL_POWER', 'CONTROL_TV_SCREEN', 'READ_APP_STATUS', 'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST', 'READ_NETWORK_STATE', 'READ_RUNNING_APPS', 'READ_TV_CHANNEL_LIST', 'WRITE_NOTIFICATION_TOAST', 'READ_POWER_STATE', 'READ_COUNTRY_INFO', 'READ_SETTINGS', 'CONTROL_INPUT_TEXT', 'CONTROL_MOUSE_AND_KEYBOARD', 'WRITE_SETTINGS', 'WRITE_NOTIFICATION_ALERT', 'READ_INSTALLED_APPS', 'READ_UPDATE_INFO'];
  var SSAP_PERMS_OLD = ['LAUNCH', 'READ_INSTALLED_APPS', 'READ_RUNNING_APPS'];

  function registerMessage(key, variant) {
    var manifest = variant === 'new'
      ? { manifestVersion: 1, permissions: SSAP_PERMS_NEW }
      : { manifestVersion: 1, appVersion: '1.0', permissions: SSAP_PERMS_OLD };
    var payload = { forcePairing: false, pairingType: 'PROMPT', manifest: manifest };
    if (key) payload['client-key'] = key;
    return JSON.stringify({ type: 'register', id: 'register_0', payload: payload });
  }

  function registerTexts(key) {
    return [registerMessage(key, 'new'), registerMessage(key, 'old')];
  }

  /* pair → {key, route} once the person accepts on the TV. cb(ok, data). The
     one place a prompt is ever shown (Settings -> Applications -> Pair with TV);
     a key that came back is kept, and listApps() reads with it from then on. */
  function ssapPair(cb) {
    var done = cb || noop;
    if (!available) { done(mockPairSpec === 'ok', mockPairResult()); return; }
    call(SERVICE + '/ssapPair', { registers: registerTexts(''), waitMs: PAIR_WAIT_MS },
      function (res) {
        var ok = !!(res && res.returnValue && res.route && res.key);
        if (ok) {
          setStore('ssapKey', res.key);
          setStoreJson('ssapRoute', res.route);
        }
        done(ok, { key: res && res.key, route: res && res.route, results: res && res.results });
      },
      function (err) { done(false, { error: (err && err.errorText) || 'pair failed' }); });
  }

  function mockPairResult() {
    if (mockPairSpec === 'ok') return { key: 'mock-key', route: { port: 3000, tls: false, origin: 'file://', reg: 0 } };
    return { error: mockPairSpec === 'prompt' ? 'waiting for OK on the TV' : 'the TV refused' };
  }

  function ssapList(key, route, cb) {
    var done = cb || noop;
    if (!available) { done(null, { mocked: true, error: 'no bridge' }); return; }
    var reg = registerMessage(key, variantOfRoute(route));
    call(SERVICE + '/ssapList', { route: route, register: reg, uri: LIST_URI },
      function (res) {
        if (res && res.prompted) { done(null, { mocked: false, error: 'key not accepted', prompted: true }); return; }
        var points = res && res.payload ? res.payload.launchPoints : null;
        done((points && points.length !== undefined) ? points : null,
          { mocked: false, error: points ? null : 'no launch points', via: 'ssap' });
      },
      function (err) { done(null, { mocked: false, error: (err && err.errorText) || 'ssap list failed' }); });
  }

  /* The route remembers which register text paired (reg: 0 new, 1 old). */
  function variantOfRoute(route) {
    return (route && route.reg === 1) ? 'old' : 'new';
  }

  function ssapPaired() {
    return !!(store('ssapKey') && storeJson('ssapRoute'));
  }

  /* The pointer of the Magic Remote, put away. The TV shows it by itself when HOME calls
     the dock, and an arrow of the remote is what makes it go (the remote is switched to
     the 5-way mode); neither the page nor the service can press a key or hide the pointer,
     so the helper service sends an arrow the way a remote app does, over the SSAP socket of
     the pointer. That needs the pairing (Settings -> Applications -> Pair with TV), made
     with a key that has CONTROL_MOUSE_AND_KEYBOARD — the long register message above.
     Any of the four arrows does it; LEFT is the one chosen, and the dock swallows the
     arrow that comes back to it (Platform.swallowKey). cb(ok, info). */
  var POINTER_HIDE_BUTTON = 'LEFT';

  function hidePointer(cb) {
    var done = cb || noop;
    if (!available) { done(false, { mocked: true, error: 'no bridge' }); return; }
    if (!ssapPaired()) { done(false, { mocked: false, unpaired: true, error: 'the TV is not paired' }); return; }
    var route = storeJson('ssapRoute');
    var reg = registerMessage(store('ssapKey'), variantOfRoute(route));
    call(SERVICE + '/pointerKey', { route: route, register: reg, button: POINTER_HIDE_BUTTON },
      function (res) { done(!!(res && res.returnValue), { mocked: false, error: res && res.returnValue ? null : (res && res.errorText) || 'failed' }); },
      function (err) { done(false, { mocked: false, error: (err && err.errorText) || 'pointer key failed' }); });
  }

  /* The full reset the user asked for: the key and the route. */
  function forgetSsap() {
    clearStore('ssapKey');
    clearStore('ssapRoute');
  }

  /* -------------------------------------------------------------- inputs --- */
  /* The TV's HDMI (and other) inputs, each an app the dock can launch. cb(list)
     with list normalized like apps (isInput marks them), or [] when none. */
  function listInputs(cb) {
    var done = cb || noop;
    if (!available) { done(mockInputs2()); return; }
    call(EIM + '/getAllInputStatus', {},
      function (res) { done(pickInputs(res)); },
      function () { done([]); });
  }

  function pickInputs(res) {
    var devices = (res && res.devices) || [];
    var out = [];
    for (var i = 0; i < devices.length; i++) {
      var d = devices[i];
      if (!d || !d.appId) continue;
      /* eim's own icon only when it is a full path or URL: a bare file name
         has no folder to be read from, and an empty icon lets the dock borrow
         the one of the input's app entry (dock.js combine). */
      var own = typeof d.icon === 'string' && /^(\/|file:|https?:)/.test(d.icon) ? d.icon : '';
      out.push({
        id: String(d.appId),
        title: String(d.label || d.appId),
        icon: own, largeIcon: '', folderPath: '',
        iconColor: null, isInput: true,
        connected: d.connected !== false,
        port: typeof d.port === 'number' ? d.port : 0
      });
    }
    out.sort(function (a, b) { return a.port - b.port; });
    return out;
  }

  function mockInputs2() {
    if (mockInputsSpec === null) return [];
    var n = Math.max(0, Math.min(8, Number(mockInputsSpec) || 0));
    var list = [];
    for (var i = 1; i <= n; i++) {
      list.push({ id: 'com.webos.app.hdmi' + i, title: 'HDMI ' + i, icon: '', largeIcon: '', folderPath: '', iconColor: null, isInput: true, connected: true, port: i });
    }
    return list;
  }

  /* Start an app by id. cb(ok, info). Launching is not privileged the way the
     list is on some firmwares, but the service still goes first so that one log
     line tells which path the TV accepted for both calls. */
  /* Restart and power off, for the dock's foot button — which asks first (a
     countdown window, dock.js), so nothing here is ever called on its own. The
     direct calls go first; the Homebrew Channel, which runs the same luna-send as
     root, is the way when the firmware refuses them to a web app.
     cb(success, info), like launch(). */
  function powerCall(uri, altUri, cb) {
    var done = cb || noop;
    if (!available) { done(false, { mocked: true, error: 'no bridge' }); return; }
    var params = { reason: POWER_REASON };
    chain([
      { uri: uri, params: params },
      { uri: altUri, params: params },
      hbShell("luna-send -n 1 " + uri + " '" + JSON.stringify(params) + "'")
    ], done);
  }

  function reboot(cb) {
    powerCall(SLEEP + '/shutdown/machineReboot', POWER + '/shutdown/machineReboot', cb);
  }

  function powerOff(cb) {
    powerCall(TVPOWER + '/power/powerOff', POWER + '/shutdown/machineOff', cb);
  }

  /* The screen off, the TV still running (the sound goes on); any key of the remote
     brings it back. The call is tvpower's own and takes no reason: with an empty
     parameter object it is what the Homebrew Channel's exec does on a TV that
     refuses the direct call to a web app. cb(success, info), like launch(). */
  function screenOff(cb) {
    var done = cb || noop;
    if (!available) { done(false, { mocked: true, error: 'no bridge' }); return; }
    chain([
      { uri: TVPOWER + '/power/turnOffScreen', params: {} },
      hbShell('luna-send -n 1 ' + TVPOWER + "/power/turnOffScreen '{}'")
    ], done);
  }

  /* `params` (optional) is handed to the app it starts: the hotkey screens of the TV are
     com.webos.app.tvhotkey with { activateType: ... }. */
  function launch(id, cb, params) {
    var done = cb || noop;
    if (!available) { done(false, { mocked: true, error: 'no bridge' }); return; }
    var payload = params ? { id: id, params: params } : { id: id };
    chain([
      { uri: SERVICE + '/launch', params: payload },
      { uri: APPMGR + '/launch', params: payload },
      { uri: APPMGR_LEGACY + '/launch', params: payload }
    ], done);
  }

  /* The icon of another app as a data URI, read by the helper service. Only
     needed when the web view refuses to load the file:// path itself (the app
     directories of other packages are not always readable from a web app).
     cb(dataUri, info) with dataUri === null when the service could not read it. */
  function appIcon(path, cb) {
    var done = cb || noop;
    if (!available) { done(null, { mocked: true, error: 'no bridge' }); return; }
    chainData([
      {
        uri: SERVICE + '/icon',
        params: { path: path },
        pick: function (res) { return (res && res.dataUri) || null; }
      }
    ], done);
  }

  /* ---------------------------------------------------------- home button -- */
  /* Point the remote's HOME at the dock, or put the stock home back. The work is
     privileged (it injects an input hook, or writes a system setting), so it all
     lives in the helper service and only acts once elevated; the two methods are
     'hook' and 'setting'. action is 'status' | 'on' | 'off'.
     cb(state, info). state for 'status' = { hook, setting, root }. */
  function homeKey(action, method, cb) {
    var done = cb || noop;
    if (!available) {
      done({ hook: false, setting: false, root: false }, { mocked: true, error: 'no bridge' });
      return;
    }
    call(SERVICE + '/homeKey', { action: action, method: method },
      function (res) { done(res || {}, { mocked: false, error: null }); },
      function (err) { done(null, { mocked: false, error: (err && err.errorText) || 'home key failed' }); });
  }

  /* Check if an application with the given ID exists in the system.
     cb(exists, appInfo, info) where exists is true if found, appInfo is the app
     object from listApps (or null), info = { mocked, error }. The same read as
     the dock's (listApps), so both find apps along the same chain; a failed
     read counts as "not there", as it always did. */
  function checkAppExists(appId, cb) {
    var done = cb || noop;
    if (!available) { done(false, null, { mocked: true, error: 'no bridge' }); return; }
    listApps(function (list, info) {
      var found = null;
      for (var i = 0; list && i < list.length; i++) {
        if (list[i].id === appId) { found = list[i]; break; }
      }
      console.log('[luna] checkAppExists "' + appId + '": ' + (found ? 'found' : 'not found') +
                  ' among ' + (list ? list.length : 0) + ' apps' + (info && info.error ? ' (' + info.error + ')' : ''));
      done(!!found, found, { mocked: false, error: (info && info.error) || null });
    });
  }

  /* Clone app to a new ID by repackaging IPK and installing via Luna Service.
     This is the recommended method as it uses standard webOS installation.
     The zygote script (tweaks/zygote.sh) creates the IPK from the installed app
     and installs it. Requires root privileges (Homebrew Channel).
     cb(ok, info) where ok is true if the switch succeeded. */
  function switchAppId(newId, cb) {
    var done = cb || noop;
    if (!available) { done(false, { mocked: true, error: 'no bridge' }); return; }

    console.log('[luna] switchAppId: calling cloneAppId for "' + newId + '"');

    /* Call our service to handle the cloning + installation */
    call(SERVICE + '/cloneAppId', { newId: newId },
      function (res) {
        console.log('[luna] cloneAppId response:', JSON.stringify(res));
        var success = res && res.returnValue === true;
        done(success, {
          mocked: false,
          error: success ? null : (res.errorText || 'cloning failed'),
          output: res.output || ''
        });
      },
      function (res) {
        console.log('[luna] cloneAppId error:', JSON.stringify(res));
        done(false, {
          mocked: false,
          error: (res && res.errorText) || 'cloneAppId call failed'
        });
      });
  }

  /* Patch appinfo.json fields: lockable and defaultWindowType.
     cb(ok, info) where info = { output, note, errorText } */
  function patchAppInfo(lockable, windowType, cb) {
    var done = cb || noop;
    if (!available) {
      done(false, { mocked: true, error: 'no bridge' });
      return;
    }

    var params = {};
    if (typeof lockable !== 'undefined') params.lockable = lockable;
    if (typeof windowType !== 'undefined') params.windowType = windowType;

    call(SERVICE + '/patchAppInfo', params,
      function (res) {
        console.log('[luna] patchAppInfo succeeded');
        done(true, res);
      },
      function (err) {
        console.warn('[luna] patchAppInfo failed: ' + (err && err.errorText));
        done(false, err);
      });
  }

  return {
    isAvailable: function () { return available; },
    /* True while ?apps= or ?inputs= stand in for the TV: the dock then keeps its
       cache of the app list out of the way, so a shot shows the mocked list. */
    isMocked: function () { return mockSpec !== null || mockInputsSpec !== null; },
    call: call,
    subscribe: subscribe,
    serviceStatus: serviceStatus,
    keepalive: keepalive,
    enableSelfKeepalive: enableSelfKeepalive,
    disableSelfKeepalive: disableSelfKeepalive,
    selfKeepaliveStatus: selfKeepaliveStatus,
    elevate: elevate,
    listApps: listApps,
    listInputs: listInputs,
    launch: launch,
    reboot: reboot,
    powerOff: powerOff,
    screenOff: screenOff,
    appIcon: appIcon,
    homeKey: homeKey,
    ssapPaired: ssapPaired,
    ssapPair: ssapPair,
    forgetSsap: forgetSsap,
    hidePointer: hidePointer,
    mockApps: mockApps,
    mockInputs: mockInputs,
    mockPair: mockPair,
    checkAppExists: checkAppExists,
    switchAppId: switchAppId,
    patchAppInfo: patchAppInfo
  };
})();
