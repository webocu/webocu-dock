/* =========================================================================
   Helper service for WebOCU Dock.

   The dock asks it for the list of installed apps, starts them and reads
   their icons when the web view may not. It also carries the app's own
   maintenance (keepalive, switching the app ID, patching appinfo.json), which
   needs root. The service becomes privileged only after it is elevated, which
   on a rooted TV is done by the Homebrew Channel, asked for from inside the app,
   by the app itself at every start while the service has no root
   (Settings.autoElevate) and by hand from

     Settings -> Tweaks -> Request privileges
     (Luna.elevate() runs elevate-service <this service id> as root)

   Until then every method still answers, with returnValue: false and an
   errorText when the underlying call failed, so the app can fall back to the
   plain luna endpoints and the reason shows up in the app log.

   Node on webOS TV is old, so this file stays ES5: var, no arrow functions,
   no template literals. `webos-service` ships with the firmware.
   ========================================================================= */
var Service = require('webos-service');
var childProcess = require('child_process');
var fs = require('fs');
var net = require('net');
var tls = require('tls');
var crypto = require('crypto');

var SERVICE_ID = 'webocu.dock.service';
var service = new Service(SERVICE_ID);

/* Track service start time for uptime reporting. */
var serviceStartTime = Date.now();

/* Cache app version from package.json for keepalive endpoint. */
var appVersion = 'unknown';
try {
  appVersion = require('./package.json').version;
} catch (e) {
  log('Failed to read package.json version: ' + e.message);
}

var APPMGR = 'luna://com.webos.service.applicationmanager/';
/* The name the application manager answered under before it moved into the
   com.webos.service namespace; some firmwares still keep only this alias. */
var APPMGR_LEGACY = 'luna://com.webos.applicationManager/';
var NETWORK = 'luna://com.webos.service.connectionmanager/';

var SHELL_TIMEOUT = 5000;

/* Everything this app keeps on the TV outside its package -- the keepalive
   daemon, the home-key engine, the home-setting guard and the Home app it puts
   back -- lives in one folder per app ID, flat: <DATA_DIR>/<app-id>/<file>.
   Outside the package, because these files have to outlive an uninstall to tidy
   up after it; one folder per ID, so that the dock, its clones and WebOCU
   Settings never share a file. The folder is shared by those parts, though, so
   each removes only its own files and then the folders if they are empty
   (dropOwnFiles), never the folder as a whole. */
var DATA_DIR = '/media/developer/apps/var/lib/webocu';

function dataDir(appId) {
  return DATA_DIR + '/' + appId;
}

/* A shell step: remove these files of the app's folder, then the folder and
   DATA_DIR if nothing else is left in them. Always succeeds. */
function dropOwnFiles(appId, names) {
  var dir = dataDir(appId);
  return '(rm -f ' + names.map(function (name) { return dir + '/' + name; }).join(' ') +
         '; rmdir ' + dir + ' 2>/dev/null; rmdir ' + DATA_DIR + ' 2>/dev/null; true)';
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function log(text) {
  console.log('[' + SERVICE_ID + '] ' + text);
}

function shell(command, cb, timeout) {
  var execTimeout = timeout || SHELL_TIMEOUT;
  childProcess.exec(command, { timeout: execTimeout }, function (error, stdout, stderr) {
    if (error) { cb(false, String(error.message)); return; }
    cb(true, String(stdout || stderr || '').trim());
  });
}

/* Walk the candidates until one answers with returnValue: true.
   A candidate is either { uri, params } or { shell: 'command', rootOnly: true }. */
function runChain(candidates, message, extra) {
  var index = 0;

  function done(payload) {
    payload.root = isRoot();
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) payload[key] = extra[key];
      }
    }
    message.respond(payload);
  }

  function attempt() {
    if (index >= candidates.length) {
      done({ returnValue: false, errorText: 'all endpoints failed' });
      return;
    }
    var candidate = candidates[index++];

    if (candidate.shell) {
      if (candidate.rootOnly && !isRoot()) { attempt(); return; }
      shell(candidate.shell, function (ok, detail) {
        if (ok) { done({ returnValue: true, via: 'shell: ' + candidate.shell }); return; }
        log('shell failed (' + candidate.shell + '): ' + detail);
        attempt();
      });
      return;
    }

    service.call(candidate.uri, candidate.params || {}, function (reply) {
      var payload = (reply && reply.payload) || {};
      if (payload.returnValue === false) {
        log(candidate.uri + ' failed: ' + payload.errorText);
        attempt();
        return;
      }
      done({ returnValue: true, via: candidate.uri });
    });
  }

  attempt();
}

/* ----------------------------------------------------------------- status -- */
/* Lets the app show whether the privileged path is actually available. */
service.register('status', function (message) {
  message.respond({
    returnValue: true,
    service: SERVICE_ID,
    root: isRoot(),
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    node: process.version,
    startTime: serviceStartTime
  });
});

/* ---------------------------------------------------------------- keepalive -- */
/* Lightweight endpoint for external keepalive monitoring. Returns version,
   network IP addresses, and timestamp. Designed to be called periodically
   (e.g., via cron) to prevent the system from closing the application. */
service.register('keepalive', function (message) {
  var timestamp = Date.now();
  var responded = false;

  /* Try to get network status, but don't block on it. */
  service.call(NETWORK + 'getStatus', {}, function (reply) {
    if (responded) return;
    responded = true;

    var payload = (reply && reply.payload) || {};
    var wifi = null;
    var wired = null;

    if (payload.returnValue !== false) {
      /* Extract IP addresses from wifi and wired links. */
      if (payload.wifi && payload.wifi.ipAddress) {
        wifi = { ipAddress: payload.wifi.ipAddress };
      }
      if (payload.wired && payload.wired.ipAddress) {
        wired = { ipAddress: payload.wired.ipAddress };
      }
    }

    message.respond({
      returnValue: true,
      version: appVersion,
      wifi: wifi,
      wired: wired,
      timestamp: timestamp,
      serviceUptime: Math.floor((Date.now() - serviceStartTime) / 1000),
      root: isRoot()
    });
  });

  /* Timeout fallback: if network call takes too long, respond without IPs. */
  setTimeout(function () {
    if (responded) return;
    responded = true;

    message.respond({
      returnValue: true,
      version: appVersion,
      wifi: null,
      wired: null,
      timestamp: timestamp,
      serviceUptime: Math.floor((Date.now() - serviceStartTime) / 1000),
      root: isRoot()
    });
  }, 2000);
});

/* -------------------------------------------------------------- app management -- */
/* List all applications. Proxy for applicationmanager/listApps: the dock keeps
   the user apps (systemApp === false) and filters on its own side, so the whole
   list goes back as it came. */
service.register('listApps', function (message) {
  service.call('luna://com.webos.service.applicationmanager/listApps', {}, function (reply) {
    var payload = (reply && reply.payload) || {};
    if (payload.returnValue === false) {
      log('listApps failed: ' + (payload.errorText || 'unknown error'));
      message.respond({
        returnValue: false,
        errorText: payload.errorText || 'listApps failed',
        root: isRoot()
      });
      return;
    }
    message.respond({
      returnValue: true,
      apps: payload.apps || [],
      root: isRoot()
    });
  });
});

/* Start an app by id. Proxy for applicationmanager/launch, both service names. The
   optional `params` object goes through as it is (the hotkey screens of the TV are
   com.webos.app.tvhotkey told which one to show by params.activateType); the log
   names the app and leaves the params out. */
service.register('launch', function (message) {
  var payload = message.payload || {};
  var id = payload.id;
  if (!id) {
    message.respond({ returnValue: false, errorText: 'id is required', root: isRoot() });
    return;
  }
  var launchParams = { id: id };
  if (payload.params && typeof payload.params === 'object') launchParams.params = payload.params;
  log('launch ' + id);
  runChain([
    { uri: APPMGR + 'launch', params: launchParams },
    { uri: APPMGR_LEGACY + 'launch', params: launchParams }
  ], message, { id: id });
});

/* --------------------------------------------------------------------- SSAP -- */
/* An un-rooted web app may not list installed apps. The TV's own second-screen
   control port (SSAP) will, over a websocket on 127.0.0.1:3000/3001, but newer
   firmware closes the page's socket (code 1008) because a browser cannot choose
   its Origin header. This service opens the same socket from plain Node, where
   the Origin can be set, and does nothing else with it: it sends the register
   message the page built and one read-only request from a short allow-list.
   Ported from Hearth (MIT, https://github.com/rudra-avatar/Hearth); credited in
   about.html. ES5 only, its own tiny websocket client on net/tls/crypto. */
var SSAP_HOST = '127.0.0.1';
var SSAP_ALLOWED = ['ssap://com.webos.applicationManager/listLaunchPoints'];
/* Routes tried in order (origin '' = no Origin header); the first to answer wins. */
var SSAP_TRIES = [
  { port: 3000, tls: false, origin: 'file://' },
  { port: 3000, tls: false, origin: '' },
  { port: 3000, tls: false, origin: 'file://webocu.dock' },
  { port: 3000, tls: false, origin: 'http://localhost' },
  { port: 3001, tls: true, origin: 'file://' },
  { port: 3001, tls: true, origin: '' }
];

function ssapBuf(n) { return Buffer.alloc ? Buffer.alloc(n) : new Buffer(n); }
function ssapFrom(x, enc) { return (Buffer.from && Buffer.from !== Uint8Array.from) ? Buffer.from(x, enc) : new Buffer(x, enc); }
function ssapText(e) { return String(e && e.message ? e.message : e); }

/* One masked client frame, as the websocket standard asks of clients. */
function ssapFrame(op, payload) {
  var len = payload.length, head, mask = crypto.randomBytes(4), body = ssapBuf(len), i;
  if (len < 126) { head = ssapBuf(2); head[1] = 128 | len; }
  else if (len < 65536) { head = ssapBuf(4); head[1] = 128 | 126; head.writeUInt16BE(len, 2); }
  else { head = ssapBuf(10); head[1] = 128 | 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  head[0] = 128 | op;
  for (i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

/* Opens a websocket to route t. h: onopen(), onmessage(text), onclose(info). */
function ssapOpen(t, h) {
  var sock, closed = false, raw = ssapBuf(0), upgraded = false, parts = [];
  var key = crypto.randomBytes(16).toString('base64');
  var req = 'GET ' + (t.path || '/') + ' HTTP/1.1\r\nHost: ' + SSAP_HOST + ':' + t.port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key +
    '\r\nSec-WebSocket-Version: 13\r\n' + (t.origin ? 'Origin: ' + t.origin + '\r\n' : '') + '\r\n';
  function end(info) {
    if (closed) return;
    closed = true;
    try { sock.destroy(); } catch (e) { /* ignore */ }
    h.onclose(info);
  }
  function send(op, payload) {
    try { sock.write(ssapFrame(op, payload)); } catch (e) { end({ stage: 'send', error: ssapText(e) }); }
  }
  function frames() {
    for (;;) {
      if (closed || raw.length < 2) return;
      var op = raw[0] & 15, fin = (raw[0] & 128) !== 0, masked = (raw[1] & 128) !== 0, len = raw[1] & 127, off = 2, mask = null, body, k;
      if (len === 126) { if (raw.length < 4) return; len = raw.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (raw.length < 10) return; len = raw.readUInt32BE(2) * 4294967296 + raw.readUInt32BE(6); off = 10; }
      if (masked) { if (raw.length < off + 4) return; mask = raw.slice(off, off + 4); off += 4; }
      if (raw.length < off + len) return;
      body = raw.slice(off, off + len);
      raw = raw.slice(off + len);
      if (mask) { for (k = 0; k < body.length; k++) body[k] ^= mask[k & 3]; }
      if (op === 8) { end({ stage: 'closed', code: body.length >= 2 ? body.readUInt16BE(0) : null, reason: body.length > 2 ? body.slice(2).toString('utf8') : '' }); return; }
      if (op === 9) { send(10, body); continue; }
      if (op === 0 || op === 1 || op === 2) {
        parts.push(body);
        if (fin) { var t8 = Buffer.concat(parts).toString('utf8'); parts = []; h.onmessage(t8); }
      }
    }
  }
  function onData(chunk) {
    raw = Buffer.concat([raw, chunk]);
    if (!upgraded) {
      var s = raw.toString('binary'), i = s.indexOf('\r\n\r\n');
      if (i < 0) { if (raw.length > 16384) end({ stage: 'handshake', status: 'reply too long' }); return; }
      var line = s.slice(0, s.indexOf('\r\n'));
      if (!/^HTTP\/1\.[01] 101/.test(line)) { end({ stage: 'handshake', status: line.slice(0, 60) }); return; }
      upgraded = true;
      sock.setTimeout(0);
      raw = raw.slice(i + 4);
      h.onopen();
    }
    frames();
  }
  function ready() { sock.write(req); }
  var opts = { host: SSAP_HOST, port: t.port };
  try {
    if (t.tls) { opts.rejectUnauthorized = false; sock = tls.connect(opts, ready); } else { sock = net.connect(opts, ready); }
  } catch (e) { setTimeout(function () { end({ stage: 'socket', error: ssapText(e) }); }, 0); return { sendText: function () {}, close: function () { closed = true; } }; }
  sock.setTimeout(4000, function () { end({ stage: 'socket', error: 'timeout' }); });
  sock.on('data', onData);
  sock.on('error', function (e) { end({ stage: 'socket', error: String((e && e.code) || ssapText(e)) }); });
  sock.on('close', function () { end({ stage: 'closed', code: null, reason: 'dropped without a close frame' }); });
  return {
    sendText: function (s) { send(1, ssapFrom(s, 'utf8')); },
    close: function () { closed = true; try { sock.destroy(); } catch (e) { /* ignore */ } }
  };
}

/* One attempt on route t: register, wait for the reply (and the person's OK when
   the TV prompts), then optionally read one URI. done(result). */
function ssapAttempt(t, registerText, uri, waitMs, done) {
  var r = { port: t.port, tls: t.tls, origin: t.origin, ok: false, replied: false, prompted: false };
  var ws, finished = false, timer = null, started = Date.now();
  function finish(extra) {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    var k;
    for (k in extra) { if (extra.hasOwnProperty(k)) r[k] = extra[k]; }
    r.ms = Date.now() - started;
    try { ws.close(); } catch (e) { /* ignore */ }
    done(r);
  }
  function arm(ms, why) { if (timer) clearTimeout(timer); timer = setTimeout(function () { finish({ error: why }); }, ms); }
  arm(8000, 'no reply');
  ws = ssapOpen(t, {
    onopen: function () { ws.sendText(registerText); },
    onmessage: function (s) {
      var m, p;
      try { m = JSON.parse(s); } catch (e) { return; }
      r.replied = true;
      p = m.payload || {};
      if (m.type === 'response' && p.pairingType) { r.prompted = true; arm(waitMs, 'nobody pressed OK in time'); }
      else if (m.type === 'registered') {
        r.key = String(p['client-key'] || '');
        if (uri) { arm(15000, 'no answer to the request'); ws.sendText(JSON.stringify({ id: 'dock_svc', type: 'request', uri: uri, payload: {} })); }
        else finish({ ok: true });
      } else if (m.id === 'dock_svc') {
        if (m.type === 'error') finish({ error: String(m.error || 'error') });
        else finish({ ok: true, payload: p });
      } else if (m.type === 'error') finish({ error: String(m.error || 'the TV refused') });
    },
    onclose: function (info) { finish(info); }
  });
}

function ssapRouteOf(p) {
  var i;
  for (i = 0; i < SSAP_TRIES.length; i++) {
    if (SSAP_TRIES[i].port === p.port && SSAP_TRIES[i].tls === !!p.tls && SSAP_TRIES[i].origin === (p.origin || '')) return SSAP_TRIES[i];
  }
  return null;
}

/* Keeps the service alive while a call waits (the TV may wait for the OK press). */
function ssapKeeping(fn) {
  var act = null, released = false;
  function release() {
    if (released) return;
    released = true;
    try { if (act) service.activityManager.complete(act, function () {}); } catch (e) { /* ignore */ }
  }
  try { service.activityManager.create('dock-ssap-' + Date.now(), function (a) { act = a; if (released) release(); }); } catch (e) { /* ignore */ }
  fn(release);
}

/* ssapPair {registers:[text,...], waitMs}: every route x every register text until
   one answers. Replies {returnValue, results, key, route}. */
service.register('ssapPair', function (message) {
  var p = message.payload || {}, regs = p.registers instanceof Array ? p.registers : [], waitMs = Math.min(Number(p.waitMs) || 60000, 90000);
  var results = [], ti = 0, ri = 0;
  if (!regs.length) { message.respond({ returnValue: false, errorText: 'no register message given' }); return; }
  ssapKeeping(function (release) {
    function next() {
      var t, reg;
      if (ti >= SSAP_TRIES.length) { release(); message.respond({ returnValue: true, results: results }); return; }
      t = SSAP_TRIES[ti]; reg = ri;
      ssapAttempt(t, String(regs[reg]), '', waitMs, function (r) {
        var c = { port: r.port, tls: r.tls, origin: r.origin, reg: reg, replied: r.replied, prompted: r.prompted, ok: r.ok };
        if (r.code !== undefined) c.code = r.code;
        if (r.error) c.error = String(r.error).slice(0, 60);
        results.push(c);
        if (r.replied) {
          release();
          message.respond({ returnValue: true, results: results, key: r.key || '', route: r.ok ? { port: r.port, tls: r.tls, origin: r.origin, reg: reg } : null });
          return;
        }
        if (ri + 1 < regs.length && r.stage === 'closed' && r.code !== undefined) { ri++; } else { ri = 0; ti++; }
        next();
      });
    }
    next();
  });
});

/* ssapList {route, register, uri}: the paired read. {payload} or {prompted:true}. */
service.register('ssapList', function (message) {
  var p = message.payload || {}, t = ssapRouteOf(p.route || {}), uri = String(p.uri || '');
  if (!t) { message.respond({ returnValue: false, errorText: 'unknown route' }); return; }
  if (SSAP_ALLOWED.indexOf(uri) < 0) { message.respond({ returnValue: false, errorText: 'request not allowed' }); return; }
  ssapKeeping(function (release) {
    ssapAttempt(t, String(p.register || ''), uri, 8000, function (r) {
      release();
      if (r.ok) message.respond({ returnValue: true, payload: r.payload || {} });
      else if (r.prompted) message.respond({ returnValue: true, prompted: true });
      else message.respond({ returnValue: false, errorText: r.error || (r.code !== undefined ? 'the TV closed the connection (code ' + r.code + ')' : r.status || 'failed') });
    });
  });
});

/* One press of an arrow of the remote, sent the way the apps that are remotes send it:
   the SSAP socket of the pointer (networkinput/getPointerInputSocket), then a text message
   on it. The dock asks for it right after HOME has called it, when the TV has put its
   pointer on the screen by itself: an arrow switches the remote to the 5-way mode and the
   pointer goes (the app cannot hide it, nor press a key of its own). Only the four arrows
   are allowed, and only this one request. The main socket stays open until the press is
   sent: the path of the pointer socket belongs to that session. */
var POINTER_URI = 'ssap://com.webos.service.networkinput/getPointerInputSocket';
var POINTER_BUTTONS = ['LEFT', 'RIGHT', 'UP', 'DOWN'];

function ssapPointer(t, registerText, button, done) {
  var ws, pws = null, finished = false, timer = null, sent = false;
  function finish(res) {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    try { if (pws) pws.close(); } catch (e) { /* ignore */ }
    try { ws.close(); } catch (e) { /* ignore */ }
    done(res);
  }
  function arm(ms, why) { if (timer) clearTimeout(timer); timer = setTimeout(function () { finish({ error: why }); }, ms); }
  function openPointer(path) {
    var m = /^(wss?):\/\/[^\/:]+(?::(\d+))?(\/.*)?$/.exec(path);
    if (!m) { finish({ error: 'no usable socket path' }); return; }
    var tls2 = m[1] === 'wss';
    arm(6000, 'the pointer socket did not open');
    pws = ssapOpen({ port: m[2] ? Number(m[2]) : (tls2 ? 3001 : 3000), tls: tls2, origin: t.origin, path: m[3] || '/' }, {
      onopen: function () {
        sent = true;
        pws.sendText('type:button\nname:' + button + '\n\n');
        setTimeout(function () { finish({ ok: true }); }, 150);
      },
      onmessage: function () { /* nothing to read */ },
      onclose: function (info) { if (sent) finish({ ok: true }); else finish(info); }
    });
  }
  arm(8000, 'no reply');
  ws = ssapOpen(t, {
    onopen: function () { ws.sendText(registerText); },
    onmessage: function (s) {
      var m, p;
      try { m = JSON.parse(s); } catch (e) { return; }
      p = m.payload || {};
      if (m.type === 'response' && p.pairingType) finish({ prompted: true });
      else if (m.type === 'registered') {
        arm(8000, 'no answer to the request');
        ws.sendText(JSON.stringify({ id: 'dock_ptr', type: 'request', uri: POINTER_URI, payload: {} }));
      } else if (m.id === 'dock_ptr') {
        if (m.type === 'error') finish({ error: String(m.error || 'error') });
        else openPointer(String(p.socketPath || ''));
      } else if (m.type === 'error') finish({ error: String(m.error || 'the TV refused') });
    },
    onclose: function (info) { if (!sent) finish(info); }
  });
}

/* pointerKey {route, register, button}: {returnValue}. */
service.register('pointerKey', function (message) {
  var p = message.payload || {}, t = ssapRouteOf(p.route || {}), button = String(p.button || '');
  if (!t) { message.respond({ returnValue: false, errorText: 'unknown route' }); return; }
  if (POINTER_BUTTONS.indexOf(button) < 0) { message.respond({ returnValue: false, errorText: 'button not allowed' }); return; }
  ssapKeeping(function (release) {
    ssapPointer(t, String(p.register || ''), button, function (r) {
      release();
      if (r.ok) { log('pointerKey: ' + button + ' sent'); message.respond({ returnValue: true }); return; }
      var why = r.prompted ? 'key not accepted: pair again' :
        (r.error || (r.code !== undefined ? 'the TV closed the connection (code ' + r.code + ')' : r.status || 'failed'));
      log('pointerKey: ' + button + ' failed: ' + why);
      message.respond({ returnValue: false, errorText: why });
    });
  });
});

/* --------------------------------------------------------------- home button -- */
/* Point the remote's HOME at the dock, or put the stock home back. Two methods,
   both root-only; adapted from Hearth (MIT), credited in about.html:
     'hook'    — inject the Input Hook library and map key code 773 to launch the
                 dock (source/homehook/homehook.sh does the injecting; this writes
                 the one entry in keybinds.json and copies the boot script);
     'setting' — write the dock's id into the TV's own Home app setting
                 (general.defaultApps.home); only webOS 4.x honours it.
   homeKey {action:'status'|'on'|'off', method:'hook'|'setting'}. */
var HOME_CODE = '773';
var APP_DIR = '/media/developer/apps/usr/palm/applications/' + SERVICE_ID.replace('.service', '');
var KEYBINDS = '/home/root/.config/lginputhook/keybinds.json';
var SETTINGSSERVICE = 'luna://com.webos.settingsservice/';
var APP_ID = SERVICE_ID.replace('.service', '');
/* Both methods keep their files in this app's own folder (DATA_DIR): homehook.sh
   for the hook, guard.sh and previous for the setting. Each has one init.d link
   per TV -- the key opens one app only -- and the link points at the copy of the
   app that turned it on: where it points is who owns it. */
var HOMEKEY_ENGINE = dataDir(APP_ID);
var HOMEAPP_DIR = dataDir(APP_ID);
var HOMEAPP_LINK = '/var/lib/webosbrew/init.d/46-webocu-homeapp';

function readJsonFile(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) { return null; }
}

/* The dock's own entry in the Input Hook settings file, added or removed in place
   (Input Hook watches the file, so it must be the same path, not a rename). */
function setHookEntry(on, cb) {
  var binds = readJsonFile(KEYBINDS) || {};
  if (on) binds[HOME_CODE] = { action: 'launch', id: APP_ID };
  else if (binds[HOME_CODE] && binds[HOME_CODE].action === 'launch' && binds[HOME_CODE].id === APP_ID) delete binds[HOME_CODE];
  try {
    childProcess.exec('mkdir -p ' + '/home/root/.config/lginputhook', function () {
      try { fs.writeFileSync(KEYBINDS, JSON.stringify(binds)); cb(true); }
      catch (e) { cb(false, String(e.message)); }
    });
  } catch (e) { cb(false, String(e.message)); }
}

function hookStatus(cb) {
  shell('LAUNCHER_ID=' + APP_ID + ' sh ' + HOMEKEY_ENGINE + '/homehook.sh status', function (ok, out) {
    var binds = readJsonFile(KEYBINDS) || {};
    var mapped = !!(binds[HOME_CODE] && binds[HOME_CODE].action === 'launch' && binds[HOME_CODE].id === APP_ID);
    cb({ mapped: mapped, ready: /ready=[1-9]/.test(out || ''), link: /link=1/.test(out || '') });
  }, 12000);
}

/* luna-send through the root shell, as the guard does, so the same call works on
   the firmwares where settingsservice refuses an in-process call. */
function settingRead(cb) {
  shell("luna-send -n 1 -f " + SETTINGSSERVICE + "getSystemSettings '{\"category\":\"general\",\"keys\":[\"defaultApps\"]}'", function (ok, out) {
    var parsed = null;
    try { parsed = JSON.parse(out); } catch (e) { parsed = null; }
    var home = parsed && parsed.settings && parsed.settings.defaultApps ? parsed.settings.defaultApps.home : null;
    cb(typeof home === 'string' ? home : null, out);
  }, 8000);
}

function settingWrite(appId, cb) {
  shell("luna-send -n 1 -f " + SETTINGSSERVICE + "setSystemSettings '{\"category\":\"general\",\"settings\":{\"defaultApps\":{\"home\":\"" + appId + "\"}}}'", function (ok) { cb(ok); }, 8000);
}

service.register('homeKey', function (message) {
  var p = message.payload || {}, action = p.action || 'status', method = p.method || 'hook';

  if (action === 'status') {
    hookStatus(function (hook) {
      settingRead(function (home) {
        message.respond({ returnValue: true, root: isRoot(), hook: hook.mapped && hook.ready, hookMapped: hook.mapped, setting: home === APP_ID, settingHome: home || '' });
      });
    });
    return;
  }

  if (!isRoot()) { message.respond({ returnValue: false, errorText: 'Root privileges required', root: false }); return; }
  var on = action === 'on';

  if (method === 'hook') {
    /* Copy the boot script to this app's folder, set the key entry, then inject
       and (dis)connect the boot link through the script. The copy is replaced
       atomically: the boot link may be running the old one right now. */
    var engine = HOMEKEY_ENGINE + '/homehook.sh';
    var copy = 'mkdir -p ' + HOMEKEY_ENGINE + ' && cp ' + APP_DIR + '/homehook/homehook.sh ' + engine + '.new && chmod 755 ' + engine + '.new && mv -f ' + engine + '.new ' + engine;
    shell(copy, function () {
      setHookEntry(on, function (okEntry, err) {
        if (!okEntry) { message.respond({ returnValue: false, errorText: err || 'could not write keybinds', root: true }); return; }
        var verb = on ? 'start' : 'disable';
        shell('LAUNCHER_ID=' + APP_ID + ' sh ' + HOMEKEY_ENGINE + '/homehook.sh ' + verb, function (okRun, out) {
          if (on) {
            shell('LAUNCHER_ID=' + APP_ID + ' sh ' + HOMEKEY_ENGINE + '/homehook.sh enable', function () {
              message.respond({ returnValue: true, root: true, method: 'hook', on: true, output: String(out || '').slice(0, 200) });
            }, 8000);
          } else {
            message.respond({ returnValue: true, root: true, method: 'hook', on: false, output: String(out || '').slice(0, 200) });
          }
        }, 15000);
      });
    }, 10000);
    return;
  }

  /* method === 'setting' */
  if (on) {
    settingRead(function (prev) {
      var guard = HOMEAPP_DIR + '/guard.sh';
      var mk = 'mkdir -p ' + HOMEAPP_DIR + ' && cp ' + APP_DIR + '/homeapp/guard.sh ' + guard + '.new && chmod 755 ' + guard + '.new && mv -f ' + guard + '.new ' + guard + ' && printf %s ' + (prev || 'com.webos.app.home') + ' > ' + HOMEAPP_DIR + '/previous';
      shell(mk, function () {
        settingWrite(APP_ID, function (okWrite) {
          shell('ln -sf ' + HOMEAPP_DIR + '/guard.sh ' + HOMEAPP_LINK, function () {
            message.respond({ returnValue: okWrite, root: true, method: 'setting', on: true, previous: prev || '' });
          }, 8000);
        });
      }, 10000);
    });
  } else {
    var prevStored = '';
    try { prevStored = String(fs.readFileSync(HOMEAPP_DIR + '/previous')).replace(/\s+$/, ''); } catch (e) { prevStored = ''; }
    if (!/^[A-Za-z0-9._-]+$/.test(prevStored) || prevStored === APP_ID) prevStored = 'com.webos.app.home';
    settingWrite(prevStored, function (okWrite) {
      /* The link goes only when it is ours; the folder keeps the other parts'
         files (the keepalive daemon, the hook). */
      var linked = '';
      try { linked = String(fs.readlinkSync(HOMEAPP_LINK)); } catch (e) { linked = ''; }
      var unlink = linked === HOMEAPP_DIR + '/guard.sh' ? 'rm -f ' + HOMEAPP_LINK + '; ' : '';
      shell(unlink + dropOwnFiles(APP_ID, ['guard.sh', 'guard.sh.new', 'previous']), function () {
        message.respond({ returnValue: okWrite, root: true, method: 'setting', on: false, restored: prevStored });
      }, 8000);
    });
  }
});

/* -------------------------------------------------------------------- icons -- */
/* The icon of another app, as a data URI. The dock first lets the web view load
   the file:// path itself; this is the fallback for firmwares where the app
   directories of other packages are not readable from a web app.

   Only image files inside the directories apps are installed into are served,
   checked again after the symlinks are resolved: without that the method would
   read any file the (possibly root) service can, for whoever asks the bus. */
var ICON_ROOTS = [
  '/media/cryptofs/apps/usr/palm/applications/',
  '/media/developer/apps/usr/palm/applications/',
  '/usr/palm/applications/'
];
var ICON_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };
/* A launcher icon is a few kilobytes; anything this big is not one. */
var ICON_MAX_BYTES = 512 * 1024;

function iconType(path) {
  var dot = path.lastIndexOf('.');
  return dot >= 0 ? (ICON_TYPES[path.slice(dot).toLowerCase()] || null) : null;
}

function iconAllowed(path) {
  if (!path || path.indexOf('..') >= 0 || !iconType(path)) return false;
  for (var i = 0; i < ICON_ROOTS.length; i++) {
    if (path.indexOf(ICON_ROOTS[i]) === 0) return true;
  }
  return false;
}

service.register('icon', function (message) {
  var requested = String((message.payload || {}).path || '');

  function fail(text) {
    message.respond({ returnValue: false, errorText: text, root: isRoot() });
  }

  if (!iconAllowed(requested)) { fail('path not allowed'); return; }

  fs.realpath(requested, function (err, real) {
    if (err) { fail('not found'); return; }
    if (!iconAllowed(real)) { fail('path not allowed'); return; }
    fs.stat(real, function (statErr, stat) {
      if (statErr || !stat.isFile()) { fail('not a file'); return; }
      if (stat.size > ICON_MAX_BYTES) { fail('too large'); return; }
      fs.readFile(real, function (readErr, data) {
        if (readErr) { fail(String(readErr.message)); return; }
        message.respond({
          returnValue: true,
          dataUri: 'data:' + iconType(real) + ';base64,' + data.toString('base64'),
          root: isRoot()
        });
      });
    });
  });
});

/* -------------------------------------------------------------- app cloning -- */
/* Clone app to a new ID by repackaging IPK and installing it.
   The zygote script creates AND installs the IPK, then returns exit code. */
service.register('cloneAppId', function (message) {
  var newId = (message.payload || {}).newId;
  if (!newId) {
    message.respond({ returnValue: false, errorText: 'newId is required', root: isRoot() });
    return;
  }

  log('cloneAppId requested: ' + newId + ' (root=' + isRoot() + ')');

  var currentId = SERVICE_ID.replace('.service', '');
  var zygoteScript = '/media/developer/apps/usr/palm/applications/' + currentId + '/tweaks/zygote.sh';
  var outputIpk = '/tmp/zygote_' + newId + '_clone.ipk';

  /* Run zygote script - it creates AND installs the IPK */
  var zygoteCmd = 'sh ' + zygoteScript + ' ' + currentId + ' ' + newId + ' ' + outputIpk;
  log('Running: ' + zygoteCmd);

  /* Increased timeout: 30 seconds (creation 5s + installation 25s) */
  shell(zygoteCmd, function (ok, output) {
    log('Zygote script completed: ok=' + ok);
    log('Output: ' + output);

    if (ok) {
      /* Success - zygote script installed the app. The clone is a service of
         its own: once it is root (the app asks for that at its first start) it
         puts its own keepalive link in place, and this ID keeps its own. */
      message.respond({
        returnValue: true,
        newId: newId,
        output: output,
        root: isRoot()
      });
    } else {
      /* Failure - zygote script returned exit code != 0 */
      message.respond({
        returnValue: false,
        errorText: 'Installation failed (see output)',
        output: output,
        root: isRoot()
      });
    }

    /* Cleanup IPK file */
    shell('rm -f ' + outputIpk, function () {});
  }, 30000); /* 30 second timeout */
});

/* --------------------------------------------------------- appinfo patching -- */
/* Modify lockable and defaultWindowType fields in the deployed appinfo.json.
   Allows testing window behaviors without redeployment.
   Requires the app to be restarted for changes to take effect. */
service.register('patchAppInfo', function (message) {
  var payload = message.payload || {};
  var lockable = payload.lockable;
  var windowType = payload.windowType;

  /* Validate at least one parameter is provided */
  if (typeof lockable === 'undefined' && typeof windowType === 'undefined') {
    message.respond({
      returnValue: false,
      errorText: 'At least one parameter required: lockable or windowType',
      root: isRoot()
    });
    return;
  }

  /* Validate lockable if provided */
  if (typeof lockable !== 'undefined' && lockable !== true && lockable !== false) {
    message.respond({
      returnValue: false,
      errorText: 'lockable must be true or false',
      root: isRoot()
    });
    return;
  }

  /* Validate windowType if provided */
  var validTypes = ['popup', 'overlay', 'card', 'minimal', 'home', 'system_ui'];
  if (typeof windowType !== 'undefined' && validTypes.indexOf(windowType) < 0) {
    message.respond({
      returnValue: false,
      errorText: 'windowType must be one of: ' + validTypes.join(', '),
      root: isRoot()
    });
    return;
  }

  log('patchAppInfo requested: lockable=' + lockable + ', windowType=' + windowType);

  var currentId = SERVICE_ID.replace('.service', '');
  var patchScript = '/media/developer/apps/usr/palm/applications/' + currentId + '/tweaks/patch_appinfo.sh';

  /* Build command with arguments */
  var args = [currentId];
  if (typeof windowType !== 'undefined') {
    args.push('windowType=' + windowType);
  } else {
    args.push('');  /* Empty placeholder */
  }

  var patchCmd = 'sh ' + patchScript + ' ' + args.join(' ');
  log('Running: ' + patchCmd);

  /* Execute with 5 second timeout (this is a quick operation) */
  shell(patchCmd, function (ok, output) {
    log('patch_appinfo.sh completed: ok=' + ok);
    log('Output: ' + output);

    if (ok && output.indexOf('SUCCESS') >= 0) {
      message.respond({
        returnValue: true,
        output: output,
        root: isRoot(),
        note: 'Restart the app for changes to take effect'
      });
    } else {
      message.respond({
        returnValue: false,
        errorText: ok ? 'Script did not report success' : 'Script execution failed',
        output: output,
        root: isRoot()
      });
    }
  }, 5000);  /* 5 second timeout */
});

/* ------------------------------------------------------ keepalive self -- */
/* Self-keepalive: service calls its own /keepalive endpoint periodically
   from within the same process. This prevents the app from being closed
   by the system without needing external daemon or root privileges. */

var selfKeepaliveInterval = null;
var SELF_KEEPALIVE_PERIOD = 30000; /* 30 seconds */

service.register('enableSelfKeepalive', function (message) {
  if (selfKeepaliveInterval) {
    /* Already running */
    message.respond({
      returnValue: true,
      alreadyRunning: true,
      enabled: true
    });
    return;
  }

  log('enableSelfKeepalive: starting internal keepalive interval');

  /* Call /keepalive immediately, then every 30 seconds */
  function callSelfKeepalive() {
    service.call('luna://' + SERVICE_ID + '/keepalive', {}, function (reply) {
      var payload = (reply && reply.payload) || {};
      if (payload.returnValue) {
        log('self-keepalive: called successfully, uptime=' + (payload.serviceUptime || '?'));
      } else {
        log('self-keepalive: call failed - ' + (payload.errorText || 'unknown'));
      }
    });
  }

  /* First call immediately */
  callSelfKeepalive();

  /* Then set interval */
  selfKeepaliveInterval = setInterval(callSelfKeepalive, SELF_KEEPALIVE_PERIOD);

  message.respond({
    returnValue: true,
    enabled: true,
    period: SELF_KEEPALIVE_PERIOD
  });
});

service.register('disableSelfKeepalive', function (message) {
  if (!selfKeepaliveInterval) {
    /* Not running */
    message.respond({
      returnValue: true,
      alreadyStopped: true,
      enabled: false
    });
    return;
  }

  log('disableSelfKeepalive: stopping internal keepalive interval');

  clearInterval(selfKeepaliveInterval);
  selfKeepaliveInterval = null;

  message.respond({
    returnValue: true,
    enabled: false
  });
});

service.register('selfKeepaliveStatus', function (message) {
  message.respond({
    returnValue: true,
    enabled: selfKeepaliveInterval !== null
  });
});

/* --------------------------------------------------------- keepalive init.d -- */
/* The keepalive daemon, linked into the Homebrew Channel's init.d. It runs in
   the background and calls the /keepalive endpoint every 30 seconds to prevent
   the system from closing the app due to inactivity, and opens the app once when
   the TV starts. It is always on: a service that is root puts it in place by
   itself at every start (bottom of this file), there is no switch for it.

   The link does not point into the app's folder. The script is copied to the
   app's own folder under DATA_DIR (<DATA_DIR>/<app-id>/keepalive_daemon.sh, next
   to the home-key engine), so that it survives an uninstall of the app and
   removes the link and its own file when it finds the app gone (see
   tweaks/keepalive_daemon.sh); a link straight to the app's folder would be
   left dangling for good.

   Homebrew Channel runs the directory at boot with a plain
   `run-parts /var/lib/webosbrew/init.d`, which matters twice:
   - BusyBox run-parts before 1.34 skips any name with a character outside
     [A-Za-z0-9_-] -- a dot included, and every app ID has dots -- so the link
     is named after the ID with every character but [A-Za-z0-9_] replaced by
     '_' (the hyphen too: one rule for every app, WebOCU Settings included);
   - run-parts waits for each script, so the daemon detaches itself (see
     tweaks/keepalive_daemon.sh) instead of holding up the scripts after it. */

var INIT_D_DIR = '/var/lib/webosbrew/init.d';

/* Named after the app ID: the dock, a clone of it under another ID and the old
   settings app may all sit on one TV, and a shared name would let one of them
   overwrite or remove the daemon of another. tweaks/keepalive_daemon.sh builds
   the very same name (LINK_NAME); the two must not drift apart. */
function initDLink(appId) {
  return INIT_D_DIR + '/00_' + appId.replace(/[^A-Za-z0-9_]/g, '_') + '_keepalive';
}

/* Names of the same ID under earlier rules -- dots kept (never run on old
   BusyBox), or the hyphen kept -- removed wherever the current one is written or
   removed, so an upgrade leaves one link. Only those that differ from it. */
function initDLegacyLinks(appId) {
  var now = initDLink(appId);
  var out = [];
  [INIT_D_DIR + '/00_' + appId + '_keepalive',
   INIT_D_DIR + '/00_' + appId.replace(/[^A-Za-z0-9_-]/g, '_') + '_keepalive'].forEach(function (path) {
    if (path !== now && out.indexOf(path) < 0) out.push(path);
  });
  return out;
}

/* The script as shipped with the app, and the copy the link points to. */
function daemonSource(appId) {
  return '/media/developer/apps/usr/palm/applications/' + appId + '/tweaks/keepalive_daemon.sh';
}

function daemonDir(appId) {
  return dataDir(appId);
}

function daemonPath(appId) {
  return daemonDir(appId) + '/keepalive_daemon.sh';
}

/* The detached daemon runs as `sh <daemonPath> <app-id>`; the anchored pattern
   matches only the daemon of this ID (not of a clone whose ID extends it), and
   not the `sh -c` running pkill itself, whose command line goes on past it. */
function daemonPattern(appId) {
  return '"keepalive_daemon.sh ' + appId + '$"';
}

var CURRENT_APP_ID = SERVICE_ID.replace('.service', '');
var INIT_D_LINK = initDLink(CURRENT_APP_ID);

/* Put the daemon in place and start it unless it already runs. Safe to repeat:
   the copy is replaced atomically (a shell that is running the old file never
   reads half of a new one), and a daemon that is already up refuses a second
   copy of itself, so nothing is restarted. KEEPALIVE_NO_LAUNCH keeps the daemon
   from opening the app: here the app is running, only a TV start should open it.
   cb(ok, errorText, output) */
function installInitD(appId, cb) {
  var link = initDLink(appId);
  var copy = daemonPath(appId);

  /* Step 1: the folders, and drop the names of earlier rules */
  shell('mkdir -p ' + INIT_D_DIR + ' ' + daemonDir(appId) + ' && rm -f ' + initDLegacyLinks(appId).join(' '), function (ok1) {
    if (!ok1) { cb(false, 'Failed to create the folders'); return; }

    /* Step 2: the copy; run-parts skips a target without the x bit, and the
       packager is not known to keep it on the original */
    shell('cp ' + daemonSource(appId) + ' ' + copy + '.new && chmod 755 ' + copy + '.new && mv -f ' + copy + '.new ' + copy, function (ok2) {
      if (!ok2) { cb(false, 'Failed to copy the daemon'); return; }

      /* Step 3: Create symlink (overwrite if exists) */
      shell('ln -sf ' + copy + ' ' + link, function (ok3) {
        if (!ok3) { cb(false, 'Failed to create symlink'); return; }

        /* Step 4: Start the daemon the way run-parts does; it detaches itself */
        shell('KEEPALIVE_NO_LAUNCH=1 nohup sh ' + link + ' > /dev/null 2>&1 &', function (ok4, output) {
          cb(ok4, ok4 ? null : 'Failed to start daemon', output);
        });
      });
    });
  });
}

/* cb(ok, errorText, output) */
function removeInitD(appId, cb) {
  /* Step 1: Kill daemon process */
  shell('pkill -f ' + daemonPattern(appId) + ' || true', function () {
    /* Step 2: Remove symlink, under the earlier names too, and the copy; the
       app's folder only if the other parts left nothing in it */
    shell('rm -f ' + initDLink(appId) + ' ' + initDLegacyLinks(appId).join(' ') + ' && ' +
          dropOwnFiles(appId, ['keepalive_daemon.sh', 'keepalive_daemon.sh.new']), function (ok, output) {
      cb(ok, ok ? null : 'Failed to remove symlink', output);
    });
  });
}

service.register('installKeepalive', function (message) {
  if (!isRoot()) {
    message.respond({
      returnValue: false,
      errorText: 'Root privileges required',
      root: false
    });
    return;
  }

  log('installKeepalive: creating ' + INIT_D_LINK + ' and starting daemon');

  installInitD(CURRENT_APP_ID, function (ok, errorText, output) {
    message.respond({
      returnValue: ok,
      errorText: errorText,
      installed: ok,
      root: true,
      output: output
    });
  });
});

service.register('uninstallKeepalive', function (message) {
  if (!isRoot()) {
    message.respond({
      returnValue: false,
      errorText: 'Root privileges required',
      root: false
    });
    return;
  }

  log('uninstallKeepalive: stopping daemon and removing ' + INIT_D_LINK);

  removeInitD(CURRENT_APP_ID, function (ok, errorText, output) {
    message.respond({
      returnValue: ok,
      errorText: errorText,
      uninstalled: ok,
      root: true,
      output: output
    });
  });
});

service.register('keepaliveStatus', function (message) {
  /* Check if keepalive daemon is installed (symlink exists) and running.
     Links under earlier names do not count. */
  var checkCmd = 'test -L ' + INIT_D_LINK + ' && echo "installed" || echo "not_installed"';

  shell(checkCmd, function (ok, output) {
    var installed = output === 'installed';

    /* Check if process is running */
    var psCmd = 'pgrep -f ' + daemonPattern(CURRENT_APP_ID) + ' > /dev/null && echo "running" || echo "stopped"';

    shell(psCmd, function (ok2, output2) {
      var running = output2 === 'running';

      message.respond({
        returnValue: true,
        installed: installed,
        running: running,
        root: isRoot()
      });
    });
  });
});

log('started, root=' + isRoot() + ', node=' + process.version);

/* The keepalive daemon is always on for a service that has root: put it in place
   (and the current copy of its script) at every start. Without root nothing is
   done, and there is nothing to fail. */
if (isRoot()) {
  installInitD(CURRENT_APP_ID, function (ok, errorText) {
    log('keepalive init script: ' + (ok ? 'in place' : 'not installed (' + errorText + ')'));
  });
}
