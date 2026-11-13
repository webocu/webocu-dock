# Application Startup and Service Communication Flow

## Overview

This document describes how WebOCU Dock (`webocu.dock`) starts, how the web
application (`source/js/*.js`) talks to its helper service
(`source/service/service.js`, luna id `webocu.dock.service`), and which
endpoints exist. Every statement points at the code it was read from; anything
that depends on firmware behaviour and cannot be checked from the repository is
marked as such.

The app has two surfaces that never share the screen
([app.js](source/js/app.js)):

- **the dock** ([dock.js](source/js/dock.js)) — a panel at the left or right edge of the
  picture with the icons of the installed user apps and a foot with two
  buttons, Home and Settings. It is the whole app from the user's point of view:
  OK starts an app and the app hides;
- **the Settings window** ([menu.js](source/js/menu.js) +
  [settings.js](source/js/settings.js)) — a centred window with the sections
  General (`common`), Appearance (`look`), Applications (`apps`), Tweaks
  (`tweaks`) and About (`about`). It holds the app's own properties only;
  nothing in it changes TV settings.

The helper service exists because a Developer Mode web app may or may not be
allowed to ask the application manager directly — that depends on the firmware
([luna.js](source/js/luna.js)). The service lists and launches apps,
reads icons the web view may not, and carries the app's own maintenance
(keepalive, cloning the app under another ID, patching `appinfo.json`). It is
privileged only after elevation through the Homebrew Channel, which the app
requests by itself at start while it has no root (Auto elevate, "Helper service
state") and, as a manual retry, from Settings → Tweaks → Request privileges
([service.js](source/service/service.js)).

**Document contents:**
1. Startup sequence and the lifecycle of the two surfaces
2. Complete reference of the 17 service endpoints
3. The fallback chains as `luna.js` implements them
4. UI → endpoint mapping, console output, verification, lint invariants and
   the gaps found in the current code

---

## Table of Contents

1. [Application Startup Flow](#application-startup-flow)
2. [Dock and Settings Window Lifecycle](#dock-and-settings-window-lifecycle)
3. [Service Architecture](#service-architecture)
4. [Service Endpoints Reference](#service-endpoints-reference)
5. [Fallback Chains](#fallback-chains)
6. [UI to Endpoint Mapping](#ui-to-endpoint-mapping)
7. [Console Output](#console-output)
8. [Verification and Testing](#verification-and-testing)
9. [Invariants](#invariants)
10. [Known Gaps in the Current Code](#known-gaps-in-the-current-code)
11. [File Dependencies](#file-dependencies)
12. [Code References](#code-references)

---

## Application Startup Flow

### Script load order

[index.html](source/index.html) loads, in this order: `keys.js`,
the locale files (`en` first; a language is disabled by commenting out its
`<script>`), `i18n.js`, `luna.js`, `platform.js`, `store.js`, `settings.js`,
`dialog.js`, `menu.js`, `dock.js`, `app.js`. Each file publishes one global;
`app.js` runs last and is the entry point. `dock.js` reads `window.Settings`
and `window.I18N.t` when it loads ([dock.js](source/js/dock.js)),
so it has to come after `settings.js`; `settings.js` in turn calls
`window.Dock` only from callbacks (`loadApps`, item `write`s), never while it
loads.

### Phase 1: synchronous bootstrap

Everything in [app.js](source/js/app.js) runs synchronously inside
one IIFE.

**1. Debug params parsed first** [app.js](source/js/app.js)
```javascript
if ('apps' in query) window.Luna.mockApps(query.apps);
```
`?apps=` decides what the first mocked `listApps()` returns, so it has to be in
place before the dock opens. Every other param is applied at the end (step 6).

**2. Platform** [app.js](source/js/app.js)
```javascript
window.Platform.markPlatform();   // data-platform="webos|browser" on <html>
window.Platform.bindUiScale();    // --ui-scale for the 1920x1080 layout
window.Platform.watchCursor(cb);  // data-cursor on Magic Remote pointer events; Dock.onCursor(cb) hears them.
                                  // Dock reads Platform.cursorVisible() / cursorWasVisible() at every showing
                                  // (armPointer() in dock.js): a call by a key keeps the pointer from moving
                                  // the focus until it moves, and — with HOME bound to the dock (Tweaks) —
                                  // a pointer the TV shows by itself is put away: Luna.hidePointer() makes the
                                  // service send an arrow over the SSAP pointer socket (needs Pair with TV)
```

**3. The app's own preferences** [app.js](source/js/app.js)
```javascript
if (window.Settings.applyAppPrefs()) window.Menu.relabel();
```
[settings.js](source/js/settings.js) — `applyAppPrefs()`
first runs `pruneStore()` (drops stored keys no row carries any more, and the
old `webocu.settings.v1` entry), then `applyTheme()`, `applyAccent()`,
`applyBg()`, `applyBgRail()`, `applyOpacity()`, `applyColumns()`,
`applyRows()`, `applyOffsetX()`, `applyOffsetY()`, `applyQuick()`,
`applyToast()`, and returns `applyLanguage()` (true when the
stored language differs from the one i18n started with). All of it reads
localStorage only; see [STORAGE_ARCHITECTURE.md](STORAGE_ARCHITECTURE.md). The
TV locale is not read ([app.js](source/js/app.js)).

**4. Icons and the dock** [app.js](source/js/app.js)
- **Headless Chromium** (`navigator.userAgent` contains `HeadlessChrome`, i.e.
  `make smoke` / `make shots`): `Settings.loadIconsSync()` → `Menu.relabel()` →
  `Dock.open()`. The synchronous XHR only exists so the icons are in the DOM
  before the snapshot.
- **Otherwise**: `Dock.open()` first, then `Settings.loadIcons(cb)` loads the
  seven SVGs `img/icon-{common,look,apps,tweaks,about,app,home}.svg`
  ([settings.js](source/js/settings.js),
  [settings.js](source/js/settings.js)) asynchronously; until
  then every icon is the inline fallback. When all of them loaded,
  `Menu.relabel()` and `Dock.relabel()` redraw with them; if any failed, the
  callback gets `false` and nothing is redrawn.

`Dock.open()` ([dock.js](source/js/dock.js)) applies the
Applications filter, renders the panel and calls `load()`. When the store
holds a cached list (`appsCache`, written by the last successful read) the
dock is drawn from it and **no luna call is made**; only the first start (no
cache yet, or after Reset app settings) makes `Luna.listApps()` the first luna
call of the app. Settings → Applications → "Read the list again" and pairing
call `Dock.load(done, true)`, which always reads the TV and replaces the cache.
A mocked list (`?apps=`, `?inputs=`, `Luna.isMocked()`) neither reads nor
writes the cache. In a desktop browser the call is answered synchronously from
the mock list ([luna.js](source/js/luna.js) `listApps`).

**5. Helper service state** [app.js](source/js/app.js)
```javascript
window.Settings.loadDeviceInfo(function () { window.Menu.relabel(); });
```
[settings.js](source/js/settings.js) calls
`Luna.serviceStatus()` → `luna://<app-id>.service/status`
([luna.js](source/js/luna.js)) and keeps the answer in
`device.service`, which Tweaks shows (`privInfo`) and gates on: the Switch app
ID submenu offers the select and Apply only when `root` is true
([settings.js](source/js/settings.js)).

**Auto elevate.** When that answer has no `root` (and is not a desktop mock), the
callback goes on to `Settings.autoElevate()`: the same `Luna.elevate()` that the
Request privileges row runs (Homebrew Channel `elevate-service`, then the service
is respawned as root), but silent — no toast, no dialog, wrapped in `try/catch`,
logged as `[webocu-dock] auto elevate: root=<bool>`. A TV without the Channel just
answers "no" and the start goes on. With root, the callback relabels the window and
calls `Dock.load()`: with a cached list that only redraws, with none (first start
of a rooted TV, where only the elevated service lists the apps) the list is read
again. A root service installs the keepalive script (§5). The Tweaks row stays as a
manual retry. Side effect: on a first start without root the dock may show
`toast.appmgrNotReady` for a moment before the reread; elevation respawns the
service, so calls in that second go through the fallback chain.

**6. Events, key routing and the remaining debug params**
[app.js](source/js/app.js) — see the next section. The debug
params are applied in the order of
[app.js](source/js/app.js): the theme and colour previews,
then the dock geometry previews (`?cols`, `?rows`, `?dockX`, `?dockY`,
`?home`, `?hide`, followed by one `Dock.relabel()`), `?toastAt`,
`?lang`, `?panel=0`, `?section`, `?expand`, `?confirm`, `?toast=busy`;
`?keys=` is last and goes through the same `route()` as the remote. None of the
preview params writes the store.

**7. Start line** [app.js](source/js/app.js)
```
[webocu-dock] start; webOS=<bool>; luna=<bool>; model=<…>; fw=<…>; lang=<…>
```

### Phase 2: asynchronous answers

| What | Started by | Answer handled in |
|------|-----------|-------------------|
| App list | `Dock.open()` → `load()` (cache first, see above) | [dock.js](source/js/dock.js) `load()` / `finishLoad()`: filter, sort, `state` = `ready` / `empty` / `failed`, Applications filter (`hidden` when every app is switched off), `render()`, then any waiting `load(done)` callbacks |
| SVG icons | `Settings.loadIcons()` | [app.js](source/js/app.js): `Menu.relabel()`, `Dock.relabel()` |
| Service state | `Settings.loadDeviceInfo()` | [app.js](source/js/app.js): `Menu.relabel()` |

The app is usable without the helper service: in a browser every `Luna.*` call
answers from a mock or with `mocked: true`
([luna.js](source/js/luna.js)), and on a TV the dock falls back to
the plain application manager endpoints (see [Fallback Chains](#fallback-chains)).

---

## Dock and Settings Window Lifecycle

### What the dock shows

[dock.js](source/js/dock.js) — `userApps()` keeps an app only if
`systemApp === false`, `visible !== false` and its id is not the dock's own id
(`webOSSystem`/`PalmSystem.identifier`, falling back to `webocu.dock`,
[dock.js](source/js/dock.js)). The list is sorted by
lower-cased title, with the id as tie-breaker.

On top of that, `applyVisibility()` ([dock.js](source/js/dock.js))
drops the apps switched off in Settings → Applications:
`Settings.isShown(id)` is `Store.get('appShow:' + id, true) !== false`, or the
`?hide=` preview ([settings.js](source/js/settings.js)).
The unfiltered list stays in `allApps`, because the Applications section is
built from it and has to offer the switched-off apps back.

Geometry, all from Settings → Appearance → Dock:

- **Columns** — `Settings.columns()` reads `data-cols` from `<html>`
  ([settings.js](source/js/settings.js)); `dockColumns`
  is `'1'` to `'7'`. The widths are one CSS rule on `--cols` (mirrors
  `data-cols`); the foot is always small buttons at the right edge of the
  panel, whatever the column count, and `move()` in `dock.js` shares the columns
  out over the buttons that are there, from the left (`buttonUnder`: with two
  buttons the first half of the columns goes with the left one, Settings under
  the rest); ▲ from a button goes back to the column the focus left (`footFrom`,
  `columnOver`).
- **Rows on screen** — `Settings.rows()`, `dockRows` 3–7, default 6
  ([settings.js](source/js/settings.js)). The panel is as tall
  as `min(rows, rows the list needs)`
  ([dock.js](source/js/dock.js)); a longer list scrolls with
  the focus in whole rows ([dock.js](source/js/dock.js)).
- **Position** — `dockSide`, `'left'` (default) or `'right'`; `applySide()` writes
  `data-side` on `<html>` and the CSS mirrors the dock, its slide-in and the
  name balloons. Nothing in `dock.js` depends on it.
- **Offset from the edge** (the chosen one) — `dockOffsetX` 0–960 px, step 10, default 0,
  written as the CSS variable `--dock-x`
  ([settings.js](source/js/settings.js)).
- **Vertical position** — `dockOffsetY` −540…540 px, step 10, default 0 (minus
  is up). `placePanel()` clamps it so the panel stays on screen whatever its
  height and applies it as a top margin of twice the shift
  ([dock.js](source/js/dock.js)).
- **Quick launch** — a submenu of Appearance (`quick` in `subsections`, entered from
  the row `dockQuick`): `dockQuick1` … `dockQuick3`, lists of the commands in `QUICK`
  (`settings.js`): Empty / webOS Home / webOS Settings / LG Store / Browser / Media Player / Home
  Dashboard / Power Off / Restart; defaults Empty, Empty, webOS Home →
  `Settings.quickAt(slot)`. Fourth, `dockQuick4`: button 4 is Settings (default) or the
  Submenu (`Settings.quick4()`; the column opens beside it like beside buttons 1…3,
  `subSlot` 4 in `dock.js`). In the dock
  the buttons stand left to right, 1, 2, 3, Settings, small and at the right; an
  empty one takes no room, buttons 1 and 2 are not drawn at all with one column
  (`quickShown()` in `dock.js`), and the focus of one that is gone goes to Settings
  (`current()`). An app id that a firmware names otherwise is a one-line fix in
  `QUICK`. The old `dockHome` key is no item id: `pruneStore()` drops it. The icons are
  `img/icon-home|syssettings|power|restart|store|browser|media|homehub|eco|timer.svg`.
States: `loading` / `empty` / `failed` / `hidden` draw one placeholder tile and
a balloon (`#dockNote`). The `failed` text names the way to root by the rows'
own labels — Settings → Tweaks → Request privileges — and `hidden` points at
Settings → Applications ([dock.js](source/js/dock.js)).

### Navigation in the dock

[dock.js](source/js/dock.js): ▲ ▼ step a row, ◀ ▶ a column.
Below the last row is the foot: ▼ from the first column lands on Home (when it
is on), otherwise on Settings; ◀ ▶ move between Home and Settings; ▲ from the
foot goes back to the last row. The focus is kept as an app id, so it survives
a reload of the list.

### Icons: three steps

1. `iconPath()` takes `largeIcon || icon`; a relative path is resolved against
   `folderPath`; an absolute path becomes `file://…`
   ([dock.js](source/js/dock.js)).
2. On the `<img>` `error` event, `iconFailed()` asks the helper service:
   `Luna.appIcon(path)` → `/icon`, which answers with a data URI. Absolute TV
   paths and `file://` URLs are sent; anything else (an `http` launch-point
   URL) is only logged. Several tiles of one app wait for one request.
   Once an icon has **drawn** from its `file://` path and has no stored copy,
   `keepIcon()` asks the service for it in the background (one read at a time)
   and stores it, so the next start does not depend on the disk. It stops while
   the store is full (stored length + 64 KB over 5 MB): the oldest would be
   pushed out and the pictures would take turns being read and dropped. A failed
   background read (no root service) is only logged; the picture on screen stays.
3. If that fails too, a letter tile is drawn (first letter of the title, the
   app's `iconColor`/`bgColor` if it is a hex value, otherwise a fixed hue picked
   from the id) ([dock.js](source/js/dock.js),
   [dock.js](source/js/dock.js)).

Data URIs the service read (after a failed draw, or as the background copy of a
file that drew) are kept in **IndexedDB** (database `<app-id>.icons`, store
`icons`, `{ d: dataUri, t: time }` per app id; each ≤ 64 KB, ≤ 5 MB in all,
oldest out first), so a reloaded page draws them at once. They are not in
localStorage on purpose: that quota is shared with the settings store, whose
writes fail silently when it is used up. The cache is read once at start
(`openIconDb()` → `loadIcons()`; the first showing is drawn before it arrives,
and the dock is drawn again if it brought anything) and written one record at a
time (`writeIcons()`); the old `<app-id>.icons.v1` localStorage entry is removed
at start. Without IndexedDB (or after a failed write) the cache lives in memory
for the session and nothing is copied. A failure is not stored: the letter
shows for a minute (`ICON_RETRY_MS`) and the next render tries again. Reset app
settings and Read the list again drop **every** stored picture (an app update
may have changed its icon file, and a stored picture is preferred over the file);
the pictures are copied again from the files as they are drawn.
Every outcome is logged once per app: `[webocu-dock] icon <id>: file ok /
service ok / service failed: …`.

A TV input (`isInput`) has no icon of its own in the eim answer (unless eim
gives a full path); `combine()` borrows `icon` / `largeIcon` / `folderPath`
from the input's own app entry in the raw list (`com.webos.app.hdmi1` is a
system app there).

### Launching an app

[dock.js](source/js/dock.js): `Menu.busy('Starting {name}…')`
→ `Luna.launch(id)`. A quick button with an app launches its id the same way (Home is `com.webos.app.home`)
([dock.js](source/js/dock.js), [dock.js](source/js/dock.js)).
With a quick button set to Power Off or Restart, OK opens a window instead
(`confirmPower` in `dock.js`, `Dialog.show` with options): a countdown of five
seconds ("The TV will turn off in N s"), the action focused. OK runs it at once;
doing nothing runs it at zero; ◀ (or the mouse over Cancel) stops the count and
shows the plain question, Back or Cancel closes the window. Only then
`Luna.powerOff` / `Luna.reboot` is called, with `Menu.busy`; a mocked call
(desktop browser) answers `toast.mock`, a refused one `toast.powerFailed`.
`armIdle()` does not hide the dock while the window is up. On success: `Menu.hideToast()`, `Dock.close()`, then the `app:exit` event. On
failure: `toast.mock` ("Dev mode: request not sent") when the call was mocked,
otherwise `toast.launchFailed`.

### Events between the surfaces

| Event | Dispatched by | Handled in | Effect |
|-------|---------------|-----------|--------|
| `settings:open` | Dock Settings button, [dock.js](source/js/dock.js) | [app.js](source/js/app.js) | `Dock.close()`, `Menu.open()` |
| `settings:close` | Back on the rail of the window, [menu.js](source/js/menu.js) | [app.js](source/js/app.js) | `Menu.close()`, `Dock.open()` (re-reads the list) |
| `app:exit` | successful launch; Back/menu key nobody else took ([app.js](source/js/app.js)); menu key in the window ([menu.js](source/js/menu.js)); a backdrop click ([app.js](source/js/app.js)) | [app.js](source/js/app.js) | `Menu.hideToast()`, `Platform.exitApp()` |

`Platform.exitApp()` ([platform.js](source/js/platform.js))
never quits on webOS: it calls `sys.hide()` (or `sys.deactivate()`), so the app
stays in memory. In a desktop browser it tries `window.close()`.

### Key routing

[app.js](source/js/app.js), one router for the remote and for
`?keys=`:

1. `Dialog.handleKey()` — while the confirmation is open it takes the key
   ([dialog.js](source/js/dialog.js)); it may carry a countdown (Power Off /
   Restart of a quick button of the dock);
2. `Menu.handleKey()` — if the Settings window is open, it gets the key and the
   router stops there, whatever the answer;
3. `Dock.handleKey()` — arrows and OK while the dock is open
   ([dock.js](source/js/dock.js));
4. otherwise, with the dock open, `back` / `menu` dispatch `app:exit`. With
   nothing up (the dock hidden at start, `?panel=0`) the router returns `false`
   for every key: it is not taken, and no arrow or OK brings the dock back —
   whatever is in front of the picture keeps the remote. The dock comes back
   with a start from the launcher or `webOSRelaunch`.

On a TV `<html data-shown="on|off">` follows "the dock or the Settings window is
up" (`syncShown()` in `app.js`); while it is `off` the CSS removes the full-screen
`#backdrop`, so a hidden app has no layer to catch the Magic Remote pointer. A
click on the backdrop does nothing when nothing is up.

### Autostart, first showing and idle hide

- **Autostart.** `tweaks/keepalive_daemon.sh` (the keepalive init script, always
  on for a root service, see §5) opens
  the app once per daemon start, in a background subshell: `luna-send …
  applicationmanager/launch '{"id":"<app-id>","params":{"boot":true}}'`, retried
  up to 10 times 5 s apart because the application manager may not be up yet at
  boot; the reply of `launch` is the readiness check. The script never reads the
  app list.
- **Autostart** (Settings → General, `appOpenAtStart`, default on; the id and the
  store key kept their old name so a stored value survives). `app.js` reads
  `Platform.launchParams().boot` (or `?boot=1`) before the first showing. On, the
  dock opens. Off, a boot start calls `Platform.quitApp()`: the page closes
  itself (`window.close()`), nothing stays in memory, and the next launch (HOME,
  the launcher) is a cold start without `boot`, so the dock opens
  (`[webocu-dock] boot launch: autostart is off, quitting (cold start on next
  launch)`). Hiding instead (`sys.hide()` at load) was tried and does not work:
  the TV log showed `SAM NL_APP_LAUNCH_BEGIN` at the HOME presses and no
  `LSM NL_VSC webocu.dock visible:true` at all, while `closeByAppId` followed by
  HOME opened the app. If the page is still alive 2 s after `window.close()`
  (`window.close() did not end the app`) the dock is opened, as with Autostart
  on. A start from the launcher has no `boot` and is never affected. The init
  script and the keepalive daemon are the same in both cases. Whether the param
  reaches `PalmSystem.launchParams` and `window.close()` ends the app on a given
  firmware is not verified from the repository.
- **Auto-hide** (Settings → General, `appAutoHide`: 5 / 10 / 20 / 30 / 60 s,
  default 30). `app.js` `armIdle()` restarts a timer on every key (mapped or
  not) and on `mousemove` / `mousedown` / `wheel`; when it runs out it logs
  `[webocu-dock] idle Ns: hiding` and dispatches `app:exit`. It is not armed
  while the Settings window is open or the app is hidden, and only on a TV or
  with `?autohide=`. Debug params: `?autohide=`, `?openAtStart=`, `?boot=1`.

Key codes come from [keys.js](source/js/keys.js): Back is 461 (only delivered
with `disableBackHistoryAPI: true`), Esc is its desktop alias; `menu` is the
yellow key or `M`.

### Relaunch and visibility

- `visibilitychange` to hidden: the dock panel goes back, unseen and without a transition,
  to where its entrance starts (`Dock.rest()`); to visible: it comes out again with the
  chosen entrance effect (`Dock.playIn()`, Appearance → Dock → Entrance effect: from the dock's own
  side, from the opposite side, from the top or the bottom, faded, grown or at once). Then the window
  refreshes its current level if it is open, otherwise an open dock re-reads the app list
  ([app.js](source/js/app.js)).
- `webOSRelaunch`: the window is closed, an open Submenu column is hidden (the focus
  stays on the quick button that opened it), the focus goes where General → Focus on
  open says (`Dock.reveal()`: where it was left, the first or the last app) and the dock
  re-reads the list (or opens) ([app.js](source/js/app.js)).

### Settings window

`Menu.open()` ([menu.js](source/js/menu.js)) renders the
current section and calls `refreshCurrentSection()`
([menu.js](source/js/menu.js)), which runs
`Settings.refresh(sectionId)` ([settings.js](source/js/settings.js)):
every item of the section that has `read()` is read, and the section's own
`load()` runs — Applications reads the app list through `Dock.load(done)`
([settings.js](source/js/settings.js)), About reads
`about.html` and `appinfo.json` once
([settings.js](source/js/settings.js)). For an open submenu
only the submenu's `load()` runs, and `openSub()` likewise calls only `load()`
([menu.js](source/js/menu.js)).

Sections and what they hold ([settings.js](source/js/settings.js)):

| Section | Rows |
|---------|------|
| General (`common`) | Language, Reset app settings (confirmed) |
| Appearance (`look`) | Theme group (dark mode, contrast, accent, two background sliders, opacity); Dock group (columns, rows, position, offset from the edge, vertical position, quick launch); Notifications group (top/bottom, alignment) |
| Applications (`apps`) | "Open webOS Home" (`appsHome`, first, built before the list is known), "Read the list again", then one switch per user app (`appShow:<id>`) |
| Tweaks (`tweaks`) | Request privileges + service/privilege info; Switch app ID (submenu); Keep Alive (submenu: Webocu Service; the init script has no switch, it is always on with root); Application type |
| About (`about`, pinned to the foot of the rail) | App name, version, the text of `about.html` |

---

## Service Architecture

### Service id follows the app id

```javascript
// luna.js:27, 32-42
var DEFAULT_SERVICE_ID = 'webocu.dock.service';
var APP_ID = getAppId();          // webOSSystem/PalmSystem.identifier, else 'webocu.dock'
var SERVICE_ID = APP_ID + '.service';
var SERVICE = 'luna://' + SERVICE_ID;
```

```javascript
// service.js:24-25
var SERVICE_ID = 'webocu.dock.service';
var service = new Service(SERVICE_ID);
```

The client derives the service id from the running app id. The service has the
id as a literal; `tweaks/zygote.sh` rewrites that literal when it clones the app
([zygote.sh](source/tweaks/zygote.sh)), which is why the
`var SERVICE_ID = '<id>.service';` form has to stay. The service derives the app
id back with `SERVICE_ID.replace('.service', '')` wherever it needs a path
([service.js](source/service/service.js),
[service.js](source/service/service.js),
[service.js](source/service/service.js),
[service.js](source/service/service.js)).

### Packaging

[services.json](source/service/services.json) declares `webocu.dock.service`;
[tools/package.sh](tools/package.sh) copies `source/service/`
into `build/services/webocu.dock.service/` and `ares-package` ships it next to
the app. When luna-service2 actually starts the process (on the first call, as
webOS JS services usually are) is firmware behaviour and cannot be verified from
the repository.

### Paths the service assumes

The service builds every script path under the Developer Mode install prefix:
`/media/developer/apps/usr/palm/applications/<app-id>/tweaks/…`
([service.js](source/service/service.js),
[service.js](source/service/service.js),
[service.js](source/service/service.js)). `zygote.sh` and
`patch_appinfo.sh` use the same prefix. Whether the app lands there on a rooted
TV installed through `tools/install.sh` was not verified.

### Elevation

[luna.js](source/js/luna.js) — `Luna.elevate()` is the only
place that uses the Homebrew Channel:

1. `chain()` of two `hbShell()` candidates on
   `luna://org.webosbrew.hbchannel.service/exec`:
   `<HB_DIR>/elevate-service <SERVICE_ID>`, then
   `/bin/sh <HB_DIR>/elevate-service <SERVICE_ID>`
   (`HB_DIR = /media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service`);
2. on success, one more exec:
   `pkill -f "[w]ebocu.dock.service" || true; ls-control scan-services || true`
   — the unprivileged instance has to die so the hub respawns it elevated; the
   `[w]` keeps `pkill` from matching its own command line;
3. 1.5 s later, `serviceStatus()`; the callback gets `root` from `/status`.

What `elevate-service` does is the Homebrew Channel's business and is not in
this repository.

### Root detection

```javascript
// service.js:46-48
function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}
```

Most answers carry `root: isRoot()`. Exceptions: `enableSelfKeepalive`,
`disableSelfKeepalive` and `selfKeepaliveStatus` do not include `root`.

### Communication layer

[luna.js](source/js/luna.js) is the only module that calls luna-service, through
`window.PalmServiceBridge` ([luna.js](source/js/luna.js)). A reply
with `returnValue === false` goes to the error callback; anything else to the
success callback.

```
dock.js / settings.js
   → luna.js (call / chain / chainData)
   → PalmServiceBridge
   → luna bus
   → webocu.dock.service  or  com.webos.service.applicationmanager  or  com.webos.applicationManager
```

### Service-side helpers

- `shell(command, cb, timeout)` — `child_process.exec` with a 5 s default
  timeout (`SHELL_TIMEOUT`); `cb(false, error.message)` on error, otherwise
  `cb(true, stdout || stderr)` trimmed
  ([service.js](source/service/service.js),
  [service.js](source/service/service.js)).
- `runChain(candidates, message, extra)` — tries `{ uri, params }` or
  `{ shell, rootOnly }` candidates until one answers without
  `returnValue: false`; replies `{ returnValue: true, via, root, …extra }` or
  `{ returnValue: false, errorText: 'all endpoints failed', root, …extra }`
  ([service.js](source/service/service.js)). Only `/launch` uses
  it.
- `log(text)` — `console.log('[webocu.dock.service] ' + text)`
  ([service.js](source/service/service.js)).

---

## Service Endpoints Reference

### Summary: 17 endpoints

Exactly the `service.register()` calls in
[service.js](source/service/service.js):

| Group | Endpoints | Root required |
|-------|-----------|---------------|
| State | `status`, `keepalive` | No |
| Apps | `listApps`, `launch`, `icon` | No (the firmware may refuse the underlying call to an unprivileged service) |
| SSAP pairing (Settings → Applications → Pair with TV) | `ssapPair`, `ssapList` | No |
| Pointer (the Magic Remote pointer put away after HOME opens the dock) | `pointerKey` (sends one allow-listed arrow over the paired SSAP socket) | No |
| Home key (Settings → Tweaks) | `homeKey` | `on` / `off`: yes, refused without root; `status`: no (§6) |
| App maintenance | `cloneAppId`, `patchAppInfo` | Not checked by the service; the scripts write under `/media/developer/apps` and install a package |
| Self-keepalive | `enableSelfKeepalive`, `disableSelfKeepalive`, `selfKeepaliveStatus` | No |
| Init script keepalive | `installKeepalive`, `uninstallKeepalive` (debug, no client) | Yes, refused without root |
| | `keepaliveStatus` | No |

---

### 1. State

#### `/status` — [service.js](source/service/service.js)
- **Client:** `Luna.serviceStatus(cb)` → [luna.js](source/js/luna.js),
  maps to `{ running: true, root, startTime }`, or
  `{ running: false, root: false, mocked }` on error
- **Parameters:** none
- **Returns:** `{ returnValue: true, service, root, uid, node, startTime }`
  (`uid` is `-1` when `process.getuid` is missing)
- **Used by:** startup (`loadDeviceInfo`), `Luna.elevate()` recheck

#### `/keepalive` — [service.js](source/service/service.js)
- **Client:** `Luna.keepalive(cb)` → [luna.js](source/js/luna.js);
  no UI code calls it. The real callers are the service itself (self-keepalive)
  and `tweaks/keepalive_daemon.sh`.
- **Parameters:** none
- **Returns:** `{ returnValue: true, version, wifi, wired, timestamp, serviceUptime, root }`
  - `version` from the service's `package.json`
    ([service.js](source/service/service.js))
  - `wifi` / `wired` are `{ ipAddress }` or `null`, read from
    `luna://com.webos.service.connectionmanager/getStatus`
  - if that call has not answered within 2 s, the reply goes out with both
    `null`
- **Purpose:** a cheap call that external monitoring (or the service itself)
  can make periodically so the system does not close the app. Whether it
  actually has that effect is firmware behaviour, not verifiable here.

---

### 2. Apps

#### `/listApps` — [service.js](source/service/service.js)
- **Client:** `Luna.listApps(cb)` → [luna.js](source/js/luna.js)
  (dock and Applications) and `Luna.checkAppExists(id, cb)` →
  [luna.js](source/js/luna.js) (Switch app ID)
- **Parameters:** none
- **Luna call:** `luna://com.webos.service.applicationmanager/listApps` only
  (the legacy name is tried by the client, not here)
- **Returns:** `{ returnValue: true, apps: [...], root }` — the whole list as
  the application manager gave it; the dock filters on its own side.
  On failure `{ returnValue: false, errorText, root }`.

#### `/launch` — [service.js](source/service/service.js)
- **Client:** `Luna.launch(id, cb)` → [luna.js](source/js/luna.js)
- **Parameters:** `{ id: String }` — required; without it
  `{ returnValue: false, errorText: 'id is required', root }`
- **Luna calls (`runChain`):**
  1. `luna://com.webos.service.applicationmanager/launch` `{ id }`
  2. `luna://com.webos.applicationManager/launch` `{ id }`
- **Returns:** `{ returnValue: true, via, root, id }`, or
  `{ returnValue: false, errorText: 'all endpoints failed', root, id }`

#### `/icon` — [service.js](source/service/service.js)
- **Client:** `Luna.appIcon(path, cb)` → [luna.js](source/js/luna.js)
  (service only, no other candidate)
- **Parameters:** `{ path: String }` — absolute path of the icon file
- **Checks, before and after `fs.realpath`:** the path contains no `..`, ends in
  `.png` / `.jpg` / `.jpeg` / `.svg`, and starts with one of
  `/media/cryptofs/apps/usr/palm/applications/`,
  `/media/developer/apps/usr/palm/applications/`,
  `/usr/palm/applications/`. The file must be a regular file of at most 512 KB.
  These checks are what stop a (possibly root) service from reading any file for
  whoever asks the bus — keep them.
- **Returns:** `{ returnValue: true, dataUri: 'data:<type>;base64,…', root }`;
  errors: `path not allowed`, `not found`, `not a file`, `too large`, or the
  `readFile` message.

---

### 3. App maintenance

#### `/cloneAppId` — [service.js](source/service/service.js)
- **UI:** Settings → Tweaks → Switch app ID → Apply (after `checkAppExists`
  found no app with that id and the user confirmed)
- **Client:** `Luna.switchAppId(newId, cb)` → [luna.js](source/js/luna.js)
  (service only)
- **Parameters:** `{ newId: String }` — required, else
  `{ returnValue: false, errorText: 'newId is required', root }`
- **Runs:** `sh /media/developer/apps/usr/palm/applications/<current-id>/tweaks/zygote.sh <current-id> <newId> /tmp/zygote_<newId>_clone.ipk`
  with a 30 s timeout, then `rm -f` of the IPK
- **What `zygote.sh` does** ([zygote.sh](source/tweaks/zygote.sh)): copies the
  installed app, package and service directories, rewrites the ids in
  `appinfo.json`, `packageinfo.json`, the service `package.json`,
  `services.json` and the `SERVICE_ID` literal of `service.js`, builds an IPK,
  installs it with `luna://com.webos.appInstallService/dev/install`, waits 10 s
  and checks `listApps` for the new id. The original app stays installed: the
  clone is a second package.
- **Keepalive link:** not touched. The clone is a service of its own: once it is
  root (the app asks for that at its first start, see "Helper service state") it
  puts its own `00_<newId …>_keepalive` and its own copy of the daemon in place
  (§5), and the original keeps its link.
- **Returns:** `{ returnValue: true, newId, output, root }` when the
  script exits 0; otherwise
  `{ returnValue: false, errorText: 'Installation failed (see output)', output, root }`

#### `/patchAppInfo` — [service.js](source/service/service.js)
- **UI:** Settings → Tweaks → Application type (`tweaksAppType`)
- **Client:** `Luna.patchAppInfo(lockable, windowType, cb)` →
  [luna.js](source/js/luna.js); the UI passes
  `lockable = undefined` ([settings.js](source/js/settings.js))
- **Parameters:** `{ lockable?: Boolean, windowType?: String }` — at least one;
  `windowType` must be one of `popup`, `overlay`, `card`, `minimal`, `home`,
  `system_ui`
- **Runs:** `sh /media/developer/apps/usr/palm/applications/<app-id>/tweaks/patch_appinfo.sh <app-id> windowType=<value>`
  (5 s timeout). The script rewrites `defaultWindowType` in the deployed
  `appinfo.json` and prints `SUCCESS`
  ([patch_appinfo.sh](source/tweaks/patch_appinfo.sh)).
- **Returns:** `{ returnValue: true, output, root, note: 'Restart the app for changes to take effect' }`
  when the output contains `SUCCESS`; otherwise `{ returnValue: false, errorText, output, root }`
- **Note:** `lockable` is validated but never passed to the script — see
  [Known Gaps](#known-gaps-in-the-current-code).

---

### 4. Self-keepalive (inside the service process)

State is one `setInterval` handle in process memory
([service.js](source/service/service.js)); it is gone when the
service process exits.

#### `/enableSelfKeepalive` — [service.js](source/service/service.js)
- **Client:** `Luna.enableSelfKeepalive(cb)` → [luna.js](source/js/luna.js);
  `cb(res.enabled === true, …)`
- **Effect:** calls its own `luna://<SERVICE_ID>/keepalive` immediately, then
  every 30 s
- **Returns:** `{ returnValue: true, enabled: true, period: 30000 }`, or
  `{ returnValue: true, alreadyRunning: true, enabled: true }`

#### `/disableSelfKeepalive` — [service.js](source/service/service.js)
- **Client:** `Luna.disableSelfKeepalive(cb)` → [luna.js](source/js/luna.js);
  `cb(res.enabled === false, …)`
- **Returns:** `{ returnValue: true, enabled: false }`, or
  `{ returnValue: true, alreadyStopped: true, enabled: false }`

#### `/selfKeepaliveStatus` — [service.js](source/service/service.js)
- **Client:** `Luna.selfKeepaliveStatus(cb)` → [luna.js](source/js/luna.js)
- **Returns:** `{ returnValue: true, enabled: Boolean }`

---

### 5. Init script keepalive (Homebrew Channel `init.d`)

Always on, with no switch: a service that is root puts the daemon in place by
itself at every start (the last lines of [service.js](source/service/service.js):
`if (isRoot()) installInitD(CURRENT_APP_ID, …)`, logged as `keepalive init script:
in place`). Without root nothing is done. The app gets that root by itself, see
"Helper service state".

`INIT_D_DIR = /var/lib/webosbrew/init.d`,
`INIT_D_LINK = initDLink(<app-id>) = <INIT_D_DIR>/00_<app-id, [^A-Za-z0-9_] → _>_keepalive`
(the hyphen replaced too: one rule for every app, WebOCU Settings included),
e.g. `00_webocu_dock_keepalive`. The link is named after the app id so the dock,
a clone of it and the old settings app do not overwrite each other's link.

**The link does not point into the app's folder.** The script is copied to
`<DATA_DIR>/<app-id>/keepalive_daemon.sh` (`DATA_DIR =
/media/developer/apps/var/lib/webocu`: one flat folder per app id for every file
the app keeps on the TV outside its package — this script, the home-key engine
`homehook.sh`, the home-setting `guard.sh` and `previous`), and the link points
at that copy. A link into the app's folder was left dangling by an uninstall; the
copy outlives it and removes what is left (below). The folder is shared by those
parts, so each removes only its own files and then the folder (and `DATA_DIR`)
if empty (`dropOwnFiles` in service.js); nothing removes it as a whole.

Two facts of the Homebrew Channel boot shape this. Its `startup.sh` runs the
directory with a plain `run-parts /var/lib/webosbrew/init.d`, and:
- BusyBox `run-parts` before 1.34 (commit 8c1f8aa, "permit dot later in file
  name") skips any name with a character outside `[A-Za-z0-9_-]`, and any target
  without the `x` bit. The old name `00_<app-id>_keepalive` kept the dots of the
  id and was never run on such firmware; a later rule kept the hyphen. Both are
  *legacy links* (`initDLegacyLinks`), removed by every install and uninstall,
  and by the daemon's cleanup.
- `run-parts` waits for each script, so an endless daemon would hold up every
  script after it. The daemon detaches itself (below).

#### `installInitD` — run at every start of a root service, and by `/installKeepalive`
- **Steps:** `mkdir -p <INIT_D_DIR> <DATA_DIR>/<app-id> && rm -f <legacy links>` →
  `cp <app>/tweaks/keepalive_daemon.sh <copy>.new && chmod 755 <copy>.new && mv -f <copy>.new <copy>`
  (the replacement is atomic: a shell running the old file never reads half of a
  new one) → `ln -sf <copy> <INIT_D_LINK>` →
  `KEEPALIVE_NO_LAUNCH=1 nohup sh <INIT_D_LINK> > /dev/null 2>&1 &`.
  No `pkill`: a daemon that already runs refuses a second copy of itself, so
  repeating the install restarts nothing; a newer script is used from the next
  daemon start (TV boot). `KEEPALIVE_NO_LAUNCH` keeps a daemon that the service
  starts from opening the app (it is running): only a start by `run-parts`
  after the TV booted does.
- **Existing installs:** the first root start after an update replaces the old
  link that pointed into the app's folder.

#### `/installKeepalive` — [service.js](source/service/service.js) (debug; no UI calls it)
- **Root:** required; otherwise `{ returnValue: false, errorText: 'Root privileges required', root: false }`
- **Does:** `installInitD`. **Returns:** `{ returnValue, errorText, installed, root: true, output }`

#### The daemon ([keepalive_daemon.sh](source/tweaks/keepalive_daemon.sh))
- Resolves its own symlink (`readlink -f "$0"`) and takes the app id from the
  folder it lives in (`<app-id>` for the copy, the parent of `tweaks` when run
  from the app's folder; an explicit first argument wins; `webocu.dock` if
  detection fails). Started without `KEEPALIVE_DETACHED` (by `run-parts` or by the
  service) it only starts `KEEPALIVE_DETACHED=1 nohup sh <real path> <app-id> &`
  and exits — unless `pgrep -f "keepalive_daemon.sh <app-id>$"` already finds one.
- The detached copy first asks whether the app is gone (`launcher_gone`, the same
  check as the home-key script: the apps folder exists, the app's `appinfo.json`
  does not, and still does not after `GONE_WAIT`, 15 s — an update replaces the
  folder for a moment). If so it removes the init.d link (every name) and its own
  file `<DATA_DIR>/<app-id>/keepalive_daemon.sh` (the folder and `DATA_DIR` only
  once empty) and exits: nothing is opened. The same check runs after every sleep of
  the loop, so uninstalling the app while the daemon runs cleans up too.
- Otherwise: calls `luna-send -n 1 -f luna://<app-id>.service/keepalive '{}'`
  every 30 s (`KEEPALIVE_PERIOD`, for tests). Before that loop it starts a
  background subshell that opens the app once (`launch` with `params.boot`, see
  "Autostart" under Key routing) unless `KEEPALIVE_NO_LAUNCH` is set. Its command
  line `sh …/keepalive_daemon.sh <app-id>` is what the service's anchored
  `pkill`/`pgrep -f` match: only this id, and not the `sh -c` running pkill,
  whose command line goes on past the id.
- `APPS`, `INIT_D_DIR` and `DATA_DIR` can be overridden by the environment
  (tests run it against a temporary tree).

#### `/uninstallKeepalive` — [service.js](source/service/service.js) (debug; no UI calls it)
- **Root:** required (same refusal as above). The next start of a root service
  puts the daemon back.
- **Steps (`removeInitD`):** `pkill -f "keepalive_daemon.sh <app-id>$" || true` →
  `rm -f <INIT_D_LINK> <legacy links> && (rm -f <DATA_DIR>/<app-id>/keepalive_daemon.sh{,.new};
  rmdir <DATA_DIR>/<app-id>; rmdir <DATA_DIR>; true)` — the folders only if empty
- **Returns:** `{ returnValue, errorText, uninstalled, root: true, output }`

#### `/keepaliveStatus` — [service.js](source/service/service.js)
- **Client:** none (debug, via `luna-send`)
- **Checks:** `test -L <INIT_D_LINK>` (the legacy link does not count) and
  `pgrep -f "keepalive_daemon.sh <app-id>$"`; both outputs compared exactly
- **Returns:** `{ returnValue: true, installed, running, root }`

### 6. Home key engine (`homeKey`, method `hook`)

Makes the remote's HOME button open the dock. Adapted from Hearth (MIT), credited in
`about.html`; the injection library and injector are Input Hook's (`homehook/`).
The second method, `setting`, writes the dock's id into the TV's own Home app setting
(`general.defaultApps.home`, checked at boot by `homeapp/guard.sh`, link
`46-webocu-homeapp`); its files, `guard.sh` and `previous`, sit in the app's data
folder `<DATA_DIR>/<app-id>/` the same way, the link points at the `guard.sh` of
the app that turned it on, and `guard.sh` takes the app it guards from its
folder's name. It is not described further here.

- **Client:** Settings → Tweaks → "HOME opens the dock (key hook)" (`homeHook`) →
  `Luna.homeKey(action, 'hook', cb)` → `/homeKey` with `{ action: 'status' | 'on' | 'off', method }`.
- **`status`** (no root): `{ returnValue, root, hook, hookMapped, setting, settingHome }`.
  `hookMapped` is true only when entry `773` of
  `/home/root/.config/lginputhook/keybinds.json` is `{"action":"launch","id":"<this app's id>"}`;
  `hook` also needs `ready` (at least one `/tmp/lginput-hook-*.log` with
  `InputHook initialized`, counted by `homehook.sh status`).
- **`on` / `off`** need root (`Root privileges required` otherwise). `on`: copy
  `<app>/homehook/homehook.sh` to `<DATA_DIR>/<app-id>/homehook.sh` (atomically) →
  write entry `773` for this app → `LAUNCHER_ID=<id> sh homehook.sh start` (inject now:
  `started`, `already` when the shared marker `/tmp/inputhook` is set and a process is ready,
  `nofiles`, `notarget`, `failed`) → `homehook.sh enable`. `off`: remove entry `773`
  if it is this app's → `homehook.sh disable`.
- **A copy per app id, one link per TV.** Each app keeps its own copy of the script in its
  data folder; there is one link `/var/lib/webosbrew/init.d/00_webocu_dock_homekey` and one
  entry `773`. The link name does not depend on the app id and is not moved by Switch app
  ID. The key can open one app only: **the owner is the app whose copy the link points
  at** — `enable` points it at its own copy, nothing else is recorded. The script resolves
  its own path (`readlink -f "$0"`) and takes the owner from its folder's name, so a start
  without `LAUNCHER_ID` (the boot link, a manual run) serves that app — its `homehook/`
  files, its "is it installed" check, its entry — and `webocu.dock` when the folder name
  is not an app id. `disable` and `cleanup` remove the link only when it points at their
  own copy (`result=kept` otherwise). `status` prints `link=1` only for its own link, and
  `linkowner=<id>`.
- **Boot.** `run-parts` runs the link (no argument = `boot`): a detached `bootjob`
  (lock `/tmp/webocu-hook-job.pid`) first asks `launcher_gone` (the apps folder exists,
  the owner's `appinfo.json` does not, still so after `GONE_WAIT` = 15 s) and then
  `cleanup`; otherwise it watches for the input processes (up to 150 rounds) and injects
  into each, sets `/tmp/inputhook` when one is ready. The injection is in memory only.
  `cleanup` takes the owner's entries out of `keybinds.json`, removes the link (its own)
  and its `homehook.sh` (the folder only if empty), and — when the Input Hook app is not
  installed either — its settings file and link too.

#### After Switch app ID

`/cloneAppId` copies the app's folder (with `homehook/`) and installs the clone; it
does not touch the hook: the link (to O's copy) and entry `773` stay as they were.
Take clone **C** of app **O** with the hook on for O, both installed, the TV not restarted:

1. Nothing changes for the TV: HOME still opens O. O's row shows "on". C's row shows
   "off" — `hookMapped` compares entry `773` with the id of the asking app.
2. **Hook turned on in C** (C's service must be root; C asks for that itself at its first
   start): C's script is copied to C's data folder and the link is pointed at it, entry `773`
   is rewritten to C — HOME opens C **at once**, because Input Hook watches the file
   (NOT VERIFIED on a TV) — and `start` answers `already`: the library injected earlier
   (from O's folder) stays in memory, nothing is injected twice. C is the owner now.
   O's row shows "off": the key has one target, O lost it.
3. O can be uninstalled now: nothing happens until the restart, the injection is in memory.
4. Next boot, O still installed: the link starts C's copy, the check is about C, the
   files are C's; the hook comes up, HOME opens C.
5. Next boot, O uninstalled: the same — C's copy never looks at O. O's own copy is left
   in O's data folder: only the link would run it, and the link is C's (Known Gap 10).
6. C uninstalled while owner: `cleanup` at the next boot takes C's entry out and removes
   the link and C's `homehook.sh`; O does not get HOME back (it is not mapped; turn it on
   again in O).
7. `off` in O while C is the owner: entry `773` is C's, so it stays; `disable` answers
   `kept`: the link points at C's copy and stays, C's hook survives the restart.
8. Turned on in O again: O becomes the owner, the entry goes back to O, C's row shows "off".

The `setting` method (`46-webocu-homeapp`) follows the same rule: the link points at the
`guard.sh` of the app that turned it on, and `guard.sh` guards the app its folder is
named after.

---

## Fallback Chains

### `chain()` and `chainData()` (client)

- `chain(candidates, cb)` — [luna.js](source/js/luna.js). Tries
  `{ uri, params, ok? }` in order; the first success calls
  `cb(true, { mocked: false, error: null, uri, root })`. A candidate's optional
  `ok(res)` can reject a reply that has `returnValue` but proves nothing. All
  candidates failed → `cb(false, { mocked: !available, error: 'all endpoints failed' | 'no bridge' })`.
- `chainData(candidates, cb)` — [luna.js](source/js/luna.js).
  Same walk, but each candidate's `pick(res)` must return something that is not
  `null`/`undefined`; the first one wins with `cb(data, { mocked: false, error: null, uri })`.
  Nothing picked → `cb(null, …)`.

Every failure is logged (`[luna] <uri> failed: …`), so the app log shows which
path the TV accepted.

### The chains as implemented

| Client function | Candidates, in order | Helper |
|-----------------|----------------------|--------|
| `listApps` | `luna://<app-id>.service/listApps` (root) → `luna://com.webos.service.applicationmanager/listApps` → `luna://com.webos.applicationManager/listApps` → `listLaunchPoints` (both names) → SSAP `ssapList`, only when a key is stored | [luna.js](source/js/luna.js) `listApps()`: `info.via` = `service` / `appmgr` / `ssap`, cached in `appsCache.via` and shown on the "Read the list again" row. A read never calls `ssapPair` (the prompt on the TV); only the Pair with TV row does, and `ssapPair` stores the key. `chainData`, `pick` = `res.apps` if it has a `length` — an empty array counts as an answer |
| `launch` | `…service/launch` → `…applicationmanager/launch` → `…applicationManager/launch`, all `{ id }` | `chain` |
| `appIcon` | `…service/icon` `{ path }` only | `chainData`, `pick` = `res.dataUri` |
| `checkAppExists` | same as `listApps` | `listApps()` and a search by id ([luna.js](source/js/luna.js) `checkAppExists()`) |
| `elevate` | hbchannel `exec` `elevate-service` → hbchannel `exec` `/bin/sh elevate-service` | `chain` |
| `serviceStatus`, keepalive family, `switchAppId`, `patchAppInfo` | the service only | plain `call()` |

The Homebrew Channel `exec` is used for elevation only. On the server side,
`/launch` repeats the two application manager names with `runChain()`
([service.js](source/service/service.js)); `/listApps` asks
`com.webos.service.applicationmanager` only.

### In a desktop browser

`available = typeof window.PalmServiceBridge !== 'undefined'`
([luna.js](source/js/luna.js)). Without the bridge:

- `listApps` answers from `MOCK_APPS` ([luna.js](source/js/luna.js)):
  eight user apps plus a system app, a hidden app and `webocu.dock` itself, so the
  filter is exercised. `?apps=N|0|fail` replaces it with N generated apps (at
  most 200), an empty list or a failed read
  ([luna.js](source/js/luna.js));
- `launch`, `appIcon`, `checkAppExists`, `switchAppId`, `patchAppInfo`, the
  keepalive writes and `elevate` answer with failure and `mocked: true`;
- `serviceStatus` → `{ running: false, root: false, mocked: true }`;
  `selfKeepaliveStatus` → `{ enabled: false }`; `keepalive` returns an obviously fake
  reply ([luna.js](source/js/luna.js)).

---

## UI to Endpoint Mapping

| UI | Client call | Endpoint(s) |
|----|-------------|-------------|
| Startup | `Settings.loadDeviceInfo` → `Luna.serviceStatus` | `/status` |
| Dock opens, `visibilitychange`, `webOSRelaunch`, return from Settings — only while there is no `appsCache` | `Dock.load` → `Luna.listApps` | `/listApps` → applicationmanager `listApps` (two names) |
| Dock icon the web view could not load | `Luna.appIcon` | `/icon` |
| Dock: OK on an app | `Luna.launch(id)` | `/launch` → applicationmanager `launch` (two names) |
| Dock: quick button = webOS Home (or webOS Settings = `com.palm.app.settings`, LG Store, Browser, Media Player, Home Dashboard: their own ids) | `Luna.launch('com.webos.app.home')` | same as above |
| Dock: quick button = Power Off / Restart (after the countdown window) | `Luna.powerOff` / `Luna.reboot` | `tvpower/power/powerOff` or `sleep/shutdown/machineReboot` direct, then `power/shutdown/machineOff` / `machineReboot`, then the same `luna-send` as root through the Homebrew Channel `exec` (`chain`) |
| Dock: Settings button | — | none (`settings:open`) |
| Settings → General → Language, Reset app settings | `Store` | none (localStorage) |
| Settings → Appearance (every row) | `Store` | none (localStorage) |
| Settings → Applications: Open webOS Home (leaves the app like a click on the picture) | `Luna.launch('com.webos.app.home')` | same as the dock's Home quick button |
| Settings → Applications: "Read the list again", Pair / Unpair (opening the section takes the cache) | `Dock.load(done, true)` → `Luna.listApps` | `/listApps` → applicationmanager `listApps` (two names) |
| Settings → Applications: an app's switch | `Store` (`appShow:<id>`), `Dock.relabel` | none |
| Settings → Tweaks → Request privileges | `Luna.elevate` | hbchannel `exec` (up to two), one more `exec`, then `/status` |
| Settings → Tweaks → Switch app ID → Apply | `Luna.checkAppExists`, then (confirmed) `Luna.switchAppId` | `/listApps` (or applicationmanager `listApps`), then `/cloneAppId` |
| Settings → Tweaks → Keep Alive → Webocu Service | `Luna.enableSelfKeepalive` / `Luna.disableSelfKeepalive` | `/enableSelfKeepalive` / `/disableSelfKeepalive` |
| (no UI: the root service installs it at start) | — | `installInitD` (also `/installKeepalive`, debug) |
| Settings → Tweaks → Application type | `Luna.patchAppInfo` | `/patchAppInfo` |
| Settings → Tweaks → HOME opens the dock (key hook / system setting) | `Luna.homeKey(action, method)` | `/homeKey` (§6) |
| Settings → About | `Platform.loadText`, `Platform.appInfo`, `Platform.getAppId` | none (XHR of `about.html`, `appinfo.json`) |
| (no UI) | `Luna.keepalive`; service interval; `keepalive_daemon.sh` | `/keepalive` |
| (no UI reaches it, see Known Gaps) | `Luna.selfKeepaliveStatus` | `/selfKeepaliveStatus`, `/keepaliveStatus` (debug, no client) |

The Switch app ID submenu shows the select and Apply only when `/status`
reported `root: true`; otherwise it is a read-only list of the ids
([settings.js](source/js/settings.js)).

---

## Console Output

All app lines carry the prefix `[webocu-dock]`; luna.js uses `[luna]`, the
Switch app ID flow `[switch-app-id]`, i18n `[i18n]`, the service
`[webocu.dock.service]` (the prefix is `SERVICE_ID`, so a clone logs under its
own id).

| Line | Source |
|------|--------|
| `[webocu-dock] start; webOS=…; luna=…; model=…; fw=…; lang=…` | [app.js](source/js/app.js) |
| `[webocu-dock] helper service: running=…, root=…` | [settings.js](source/js/settings.js) |
| `[webocu-dock] Icons loaded asynchronously in Nms, N failed` | [settings.js](source/js/settings.js) |
| `[webocu-dock] Icons loaded synchronously in Nms, N failed` (headless) | [settings.js](source/js/settings.js) |
| `[webocu-dock] N user apps of M` | [dock.js](source/js/dock.js) |
| `[webocu-dock] app list unavailable: <error>` | [dock.js](source/js/dock.js) |
| `[webocu-dock] about.html could not be read` | [settings.js](source/js/settings.js) |
| `[webocu-dock] hidden; staying in memory for fast recall` | [platform.js](source/js/platform.js) |
| `[luna] <uri> accepted the call` / `answered` / `failed: <errorText>` | [luna.js](source/js/luna.js), [luna.js](source/js/luna.js) |
| `[luna] checkAppExists: …`, `[luna] cloneAppId response: …` | [luna.js](source/js/luna.js) |
| `[switch-app-id] …` | [settings.js](source/js/settings.js) |
| `[webocu.dock.service] started, root=…, node=…` | [service.js](source/service/service.js) |
| `[webocu.dock.service] launch <id>` | [service.js](source/service/service.js) |

In a desktop browser with no params, the order that follows from the code is
(derived from the code, not a captured log): `… 8 user apps of 11` (the mock
answers synchronously inside `Dock.open()`), `… helper service: running=false, root=false`
(the bridge-less error callback is synchronous too), `… start; webOS=false; luna=false; …`,
then `… Icons loaded asynchronously …` once the SVG requests finish.

---

## Verification and Testing

### 1. In the browser (no TV)

```bash
make dev        # http://localhost:8080
make smoke      # tools/smoke.sh, headless Chromium
make lint
```

Useful URLs (full list: the comment at
[app.js](source/js/app.js)):
`?apps=30`, `?apps=0`, `?apps=fail`, `?cols=2`, `?rows=3`, `?dockX=0`,
`?dockY=-200`, `?home=poweroff`, `?hide=org.example.music`,
`?section=apps`, `?section=tweaks`, `?section=keepalive`, `?confirm=appReset`,
`?keys=down,down,enter`.

### 2. Service availability on the TV

```bash
luna-send -n 1 -f luna://webocu.dock.service/status '{}'
```

Expected shape (values depend on the TV, not captured here):
```json
{
  "returnValue": true,
  "service": "webocu.dock.service",
  "root": false,
  "uid": 1000,
  "node": "v…",
  "startTime": 1700000000000
}
```

### 3. The dock's calls by hand

```bash
luna-send -n 1 -f luna://webocu.dock.service/listApps '{}'
luna-send -n 1 -f luna://webocu.dock.service/launch '{"id":"<app-id>"}'
luna-send -n 1 -f luna://webocu.dock.service/icon '{"path":"/media/developer/apps/usr/palm/applications/webocu.dock/icons/largeIcon.png"}'
```

### 4. Elevation

```bash
luna-send -n 1 -f luna://webocu.dock.service/status '{}'   # root: false
# In the app: Settings (button at the foot of the dock) → Tweaks → Request privileges
luna-send -n 1 -f luna://webocu.dock.service/status '{}'   # root: true
```

### 5. Which path the TV accepted

Open DevTools (`make inspect`; the URL it prints is opened in Chrome) and open
the dock: the `[luna]` lines show which of the three `listApps` candidates
answered.

---

## Invariants

### Enforced by `make lint` ([tools/lint.sh](tools/lint.sh))

1. **Syntax** — `node --check` passes for `js/*.js` and `service/*.js`.
2. **Service manifests** — with `appinfo.json` id `X`: `service/package.json`
   `name` and `services.json` `id` equal `X.service`, `services[].name` contains
   it, and `package.json` `main` exists.
3. **The app talks to the service** — `js/luna.js` contains the quoted service
   id (`'webocu.dock.service'`) and the strings `/status`, `/listApps`,
   `/launch`.
4. **Version** — `version.txt` is `x.y.z`; `appinfo.json` and
   `service/package.json` carry the same version.
5. **`appinfo.json`** — has `id`, `version`, `vendor`, `type`, `main`, `title`,
   `icon`, `largeIcon`; `type: web`; `disableBackHistoryAPI: true`;
   `defaultWindowType` in `overlay` / `minimal` / `popup` / `system_ui` (anything
   but `popup`, which the shipped file has, prints a warning);
   `transparent: true`; no `bgColor`; `spinnerOnLaunch: false`;
   `networkStableTimeout: 0`; `icon`, `largeIcon`, `main` files exist.
6. **`index.html`** — every local `src`/`href` exists.
7. **`about.html`** — exists and is not empty.
8. **Panel backgrounds** — `img/{rail,pane}-{dark,light}.png` exist and are
   referenced from `css/app.css`; the CSS has `background-size: 100% 100%` and no
   `border-image` declaration.
9. **i18n** — `locales/en.js` exists; every language has exactly the keys of
   `en`; every `'a.b'`-shaped literal in `settings.js`, `menu.js`, `dialog.js`,
   `dock.js`, `app.js` exists in `en` (literals starting with `luna.`, `com.`,
   `window.`, `document.`, `webocu.`, the id `yota.play` and file names are
   skipped).
10. **Destructive actions** — any `Luna.reboot(` / `Luna.powerOff(` in
    `settings.js` must sit in an item literal carrying `confirmKey`, and any in
    `dock.js` must follow a `Dialog.show(` (the countdown window of the left
    button) within 1500 characters.

### Not checked by lint, but relied on

- **Script order** of `index.html` (each file reads the globals published before
  it).
- **`applyAppPrefs()` before the first render** — [app.js](source/js/app.js)
  runs before `Dock.open()`; otherwise the first frame has no theme, columns,
  geometry or language, and `pruneStore()` would run after the first writes.
- **`?apps=` before `Dock.open()`**, **`?keys=` last** — [app.js](source/js/app.js),
  [app.js](source/js/app.js).
- **The service answers unprivileged** with `returnValue: false` and an
  `errorText`, so the client can fall back and the reason is logged
  ([service.js](source/service/service.js)).
- **`/icon` path checks** — removing them lets the service read arbitrary files.
- **`var SERVICE_ID = '<id>.service';`** in `service.js` — `zygote.sh` rewrites
  that exact form.
- **ES5 only** in the browser and the service (old Node on the TV).

---

## Known Gaps in the Current Code

Read from the code, not from a TV; listed so nobody documents them as working.

1. **Keepalive state is never read back by the window.** The one Keep Alive
   switch (Webocu Service) has a `read()` ([settings.js](source/js/settings.js),
   `keepaliveSelfService`), but nothing calls it: `Settings.refresh()` walks
   `sections` only, the `keepalive` subsection has no `load()`, and for a
   submenu both `openSub()` and `refreshCurrentSection()` call only `load()`
   (`menu.js`). So `/selfKeepaliveStatus` is not called; the switch shows the
   stored value. (The init script has no switch: whether it is in place is shown
   only as "Init" in the Keep Alive row's status, which follows `root`.)
2. **Webocu Service shows "on" on a fresh install.** `keepaliveSelfService`
   defaults to `true` ([settings.js](source/js/settings.js)), and the
   Keep Alive row's status reads the same default
   ([settings.js](source/js/settings.js)), but nothing calls
   `/enableSelfKeepalive` at startup — the only caller is the switch's `write`
   ([settings.js](source/js/settings.js)). The service starts with no
   interval ([service.js](source/service/service.js)).
3. **A clone gets its keepalive only once it is root.** `/cloneAppId` no longer
   moves the init.d link: each id with a root service installs its own link and
   copy (§5), and the original keeps its own. The clone's service is a new
   service id, so it is root only after `elevate-service` ran for it — which the
   clone's own first start does (Auto elevate). Not verified on a TV.
4. **The init.d boot path is read from the sources, not from a TV:** the
   BusyBox version of a given firmware, whether `/media/developer` is mounted
   when init.d runs, and whether `elevate-service` runs without a prompt on every
   firmware, are not verified. (The service sets the `x` bit on the copy itself.)
   Links left by an older build of an app that was already uninstalled stay:
   no script is left to clean them.
5. **`/patchAppInfo` ignores `lockable`.** It is validated, logged and dropped:
   only `windowType=…` (or an empty placeholder) reaches `patch_appinfo.sh`
   ([service.js](source/service/service.js)), and the script
   handles `defaultWindowType` only.
6. **`available()`** on `tweaksAppType`
   ([settings.js](source/js/settings.js)) reads
   `Platform.deviceInfo().service`, which `deviceInfo()` never sets
   ([platform.js](source/js/platform.js)), and nothing in
   `menu.js` calls `available` — the rows are never gated.
7. **A failed write keeps the new value.** `commit()` stores the value before
   `write()` runs ([settings.js](source/js/settings.js)); on
   failure nothing restores the old one, so the "roll back" re-render in
   [menu.js](source/js/menu.js) draws the new value. This
   matters for the three rows that call the service (the two Keep Alive
   switches and Application type).
8. **The specific toast of those three rows is overwritten.** Their `write`
   shows its own toast (`keepaliveSelfEnabled`, `appRestart`, …) and answers
   without `local: true`, so `applyValue()` calls `api.report(true)`, which
   replaces it with `toast.applied` in the same tick
   ([menu.js](source/js/menu.js)).
9. **The `store.js` header** still says luna-service is the source of truth
   ([store.js](source/js/store.js)); since the TV-settings tier is gone,
   localStorage is the only store of the app's preferences.
10. **A copy that lost the link is left behind.** The home-key engine (§6) and the
    home-setting guard are copied to the data folder of every app that turns them on,
    but only the copy the one link points at ever runs. When another app takes the
    link over and the first one is uninstalled, its `homehook.sh` (or `guard.sh` and
    `previous`) stays in `<DATA_DIR>/<app-id>/`: nothing runs it to tidy up, and the
    keepalive daemon removes only its own file. Harmless (nothing links to it), but it
    keeps that folder from being removed.

---

## File Dependencies

```
source/index.html
  ├─> js/luna.js        (the only luna-service access)
  │     ├─ used by js/dock.js      listApps, appIcon, launch
  │     ├─ used by js/settings.js  serviceStatus, elevate, checkAppExists,
  │     │                          switchAppId, patchAppInfo, keepalive family
  │     └─ used by js/app.js       mockApps (?apps=), isAvailable (start line)
  ├─> js/store.js       (localStorage, used by settings.js)
  ├─> js/settings.js    (model of the window + applyAppPrefs + dock geometry
  │                      getters + isShown)
  ├─> js/menu.js        (Settings window; owns the toast the dock also uses)
  ├─> js/dock.js        (the dock; Dock.load also feeds Settings → Applications)
  └─> js/app.js         (entry point, events, key routing, debug params)

source/service/services.json (manifest)
  └─> source/service/service.js (17 endpoints)
        ├─> webos-service (ships with the firmware)
        ├─> tweaks/zygote.sh            (/cloneAppId)
        ├─> tweaks/patch_appinfo.sh     (/patchAppInfo)
        └─> /media/developer/apps/var/lib/webocu/<id>/keepalive_daemon.sh  (installInitD at start of a root service, via init.d link)
```

---

## Code References

### Client

- `chain()` — [luna.js](source/js/luna.js)
- `chainData()` — [luna.js](source/js/luna.js)
- `hbShell()` — [luna.js](source/js/luna.js)
- `listApps()` / `launch()` / `appIcon()` — [luna.js](source/js/luna.js)
- Public API — [luna.js](source/js/luna.js)
- Dock filter / load — [dock.js](source/js/dock.js)
- Dock launch / activate — [dock.js](source/js/dock.js)
- Key router — [app.js](source/js/app.js)

### Service

- `runChain()` — [service.js](source/service/service.js)
- `service.register()` calls — [service.js](source/service/service.js)

### Initialization

- `applyAppPrefs()` — [app.js](source/js/app.js) →
  [settings.js](source/js/settings.js)
- First `listApps` — [app.js](source/js/app.js) /
  [app.js](source/js/app.js) → [dock.js](source/js/dock.js)
- Service status — [app.js](source/js/app.js) →
  [settings.js](source/js/settings.js)

---

## Summary

- **17 service endpoints**: `status`, `keepalive`, `listApps`, `launch`, `icon`,
  `ssapPair`, `ssapList`, `homeKey`,
  `cloneAppId`, `patchAppInfo`, `enableSelfKeepalive`, `disableSelfKeepalive`,
  `selfKeepaliveStatus`, `installKeepalive`, `uninstallKeepalive`,
  `keepaliveStatus`.
- **The dock** needs two of them to work — `listApps` and `launch` — and both
  fall back to the two names of the application manager; `icon` is an optional
  third step before the letter tile.
- **The Settings window** uses the service for Tweaks only and reads the app
  list for Applications through the dock; General, Appearance and About are
  local.
- **Without the service** the app still runs: mocks in a browser, plain
  application manager endpoints on a TV that allows them.
