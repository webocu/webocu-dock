# WebOCU Dock Storage Architecture

## Summary

The app's preferences live in **one place: localStorage**, as one JSON object
under the key `<app-id>.v1` — `webocu.dock.v1` for the shipped package
([store.js](source/js/store.js)). There is no TV-settings tier any
more: the dock reads the TV (the app list) and starts apps, but no row of the
Settings window reads or writes a TV setting.

A few rows also act on the TV through the helper service — the two Keep Alive
switches and Application type. For them localStorage still holds the value the
window shows; the service call is the side effect (see
[Hybrid items](#hybrid-items-store--service)).

Everything below is read from the code; statements that depend on the webOS
runtime are marked as not verified.

---

## Table of Contents

- [Layers](#layers)
- [store.js](#storejs)
- [How a value travels](#how-a-value-travels)
- [Local-only items](#local-only-items)
- [Hybrid items (Store + service)](#hybrid-items-store--service)
- [Startup: applyAppPrefs and pruneStore](#startup-applyappprefs-and-prunestore)
- [Preview params do not write the store](#preview-params-do-not-write-the-store)
- [Reset](#reset)
- [Settings Inventory](#settings-inventory)
- [Known Gaps](#known-gaps)
- [File Reference](#file-reference)

---

## Layers

```
settings.js (model: items, commit, refresh, apply*/preview*)
   │  Store.get / Store.set / Store.reset / Store.prune / Store.forget
   ▼
store.js  ── in-memory object `data`, flushed 400 ms after the last set()
   │
   ▼
localStorage['<app-id>.v1']   (JSON)

settings.js ── item.write() of three Tweaks rows ──► luna.js ──► <app-id>.service
                                                     (keepalive, patchAppInfo)
```

`dock.js` reads its settings through `Settings` — `columns()`, `rows()`,
`offsetY()`, `labelSeconds()`, `quickAt(slot)`,
`isShown(id)` ([settings.js](source/js/settings.js)).

The one key `dock.js` writes itself is **`appsCache`**: `{ apps }`,
the user apps and then the TV's inputs of the last successful read (both read
together), trimmed to `id`, `title`, `icon`, `largeIcon`, `folderPath`,
`iconColor`, `bgColor`, `isInput` (icon data URIs are not kept). A cache of an
older build, which kept `inputs` apart, is still read. `Dock.load()` draws from it without a luna call;
`Dock.load(done, true)` (Read the list again, pairing) reads the TV and
replaces it. A failed read writes nothing; a mocked list (`Luna.isMocked()`)
neither reads nor writes it; Reset app settings drops it with everything else.
`appsCache.via` records the source of the list (`service` / `appmgr` / `ssap`).

Icons are not in localStorage at all: they live in **IndexedDB**, database
`<app-id>.icons`, object store `icons` (key: app id, value `{ d: dataUri, t: time }`,
written by `dock.js` `writeIcons()`, one record at a time): only pictures the
service read — after a failed draw, or as the background copy of an icon that drew
from its `file://` path (`keepIcon()`, one read at a time, not started while the
store is full) — each ≤ 64 KB, ≤ 5 MB in all, oldest out first. IndexedDB has a
quota of its own, so a full icon cache can never take room from the settings
store (a localStorage write that hits the quota is swallowed silently,
[store.js](source/js/store.js)); `Store.prune` never sees it. Reset app settings
and Read the list again clear it through `Dock.forgetIcons()`. The earlier
localStorage entry `<app-id>.icons.v1` is removed at start. Without IndexedDB the
cache lives in memory for the session.

---

## store.js

[store.js](source/js/store.js) — 51 lines, one global `window.Store`.

| Member | What it does | Code |
|--------|--------------|------|
| key | `(PalmSystem \|\| webOSSystem).identifier + '.v1'`, `webocu.dock.v1` when there is no identifier (desktop browser) | [store.js](source/js/store.js) |
| load | `JSON.parse(localStorage.getItem(KEY) \|\| '{}')`; a parse error starts from `{}` | [store.js](source/js/store.js) |
| `get(id, fallback)` | the stored value if `data` has the key (`hasOwnProperty`), otherwise `fallback` — so a stored `false` or `0` wins over the default | [store.js](source/js/store.js) |
| `set(id, value)` | writes `data[id]` at once, flushes to localStorage 400 ms after the last call (debounced, because a slider fires many writes) | [store.js](source/js/store.js) |
| `reset()` | `data = {}` and an immediate flush | [store.js](source/js/store.js) |
| `prune(keep)` | deletes every key `keep(id)` rejects; flushes at once if anything went; returns the count | [store.js](source/js/store.js) |
| `forget(key)` | `localStorage.removeItem(key)` for another entry; refuses its own key | [store.js](source/js/store.js) |
| flush | `localStorage.setItem(KEY, JSON.stringify(data))`, quota errors swallowed | [store.js](source/js/store.js) |

Consequences:

- Reads always come from memory; localStorage is read once, when `store.js`
  loads.
- A value set less than 400 ms before the page goes away may not reach
  localStorage. Whether WAM gives the page time to flush on hide is not
  verified — the app normally hides rather than unloads
  ([platform.js](source/js/platform.js)).
- A clone under another app id reads and writes `<new-id>.v1`. Whether two app
  ids share one localStorage origin on the TV is not verified; the code itself
  says only that removing the old entry does nothing under another origin
  ([settings.js](source/js/settings.js)).
- The header comment of `store.js` ([store.js](source/js/store.js))
  still calls luna-service "the real source of truth"; that is left over from
  the settings panel and no longer true.

---

## How a value travels

### The user changes a row

`Menu.applyValue()` ([menu.js](source/js/menu.js)) →
`Settings.commit(id, value, cb)` ([settings.js](source/js/settings.js)):

1. `Store.set(id, value)` — always, first;
2. no `write` → `cb(true, { local: true })`;
3. otherwise `item.write(value, cb)`; a `write` that answers
   `{ local: true }` keeps the window quiet, anything else is reported through
   `api.report` (`toast.applied` / `toast.mock` / `toast.failed`).

Only rows of type `toggle`, `select` and `slider` are committed; `action`,
`submenu`, `group` and `info` rows store nothing.

### What the window shows

`Settings.value(id)` = `Store.get(id, item.def)`
([settings.js](source/js/settings.js)). The window never
keeps a value of its own.

### Opening a section

`Settings.refresh(sectionId)` ([settings.js](source/js/settings.js))
calls `read()` of every item of that section that has one, and stores the
answer when it differs from `value(id)`. Of the current items only
`tweaksAppType` has a `read` on a section level, and it reads the store itself
([settings.js](source/js/settings.js)) — so in practice
`refresh` changes nothing in the store. The `read`s of the Keep Alive switches
live in a subsection and are never called (see [Known Gaps](#known-gaps)).

---

## Local-only items

Every row of General, Appearance and Applications. Their `write` applies the
value to the page and answers `{ local: true }`; no luna call is made.

What "applying" means depends on the row: an attribute or a CSS variable on
`<html>` (theme, accent, backgrounds, opacity, columns, offset from the edge,
the side, notifications), a value kept in `dockNow` for
`dock.js` to read when it draws (rows, vertical position —
[settings.js](source/js/settings.js)), the i18n language, or a
`Dock.relabel()` for the Applications switches. See the
[inventory](#settings-inventory) for each row.

The Appearance → Dock rows apply their value but do not redraw the dock; that
is not needed, because the dock is closed while the window is open and is drawn
again by `Dock.open()` on `settings:close`
([app.js](source/js/app.js)).

---

## Hybrid items (Store + service)

| Item | Store | Service call | On success | On failure |
|------|-------|--------------|------------|------------|
| `keepaliveSelfService` | `commit` stores the new value, `write` stores it again on success | on → `/enableSelfKeepalive`, off → `/disableSelfKeepalive` | toast `keepaliveSelfEnabled` / `keepaliveSelfDisabled`, at once replaced by `toast.applied` (see [Known Gaps](#known-gaps)) | `cb(false, { error })`; the new value stays stored |
| `tweaksAppType` | `commit` stores it, `write` stores it again before the call | `/patchAppInfo` with `windowType` (`lockable` undefined) | toast `appRestart`, at once replaced by `toast.applied` | `cb(false, info)`; the new value stays stored |

Code: [settings.js](source/js/settings.js) (Keep Alive),
[settings.js](source/js/settings.js) (Application type).

What the service holds is not mirrored back: the self-keepalive interval lives
in the service process memory ([service.js](source/service/service.js)),
the init script has no switch and no stored value: a root service writes the
symlink `00_<app id, [^A-Za-z0-9_] as _>_keepalive` under `/var/lib/webosbrew/init.d`
at every start, pointing at its own copy of the daemon,
`/media/developer/apps/var/lib/webocu/<app id>/keepalive_daemon.sh`, which removes
the link and the copy when the app is uninstalled (`installInitD`,
[service.js](source/service/service.js); each id keeps its own, Switch app ID
moves nothing). That folder, `<DATA_DIR>/<app id>/`, is the app's one place on
the TV outside its package: the home-key engine (`homehook.sh`) and the
home-setting guard (`guard.sh`, `previous`) sit there too, flat, and each part
removes only its own files. The window type is
`defaultWindowType` in the deployed `appinfo.json`
([patch_appinfo.sh](source/tweaks/patch_appinfo.sh)). The window shows the
stored value, not any of these.

In a desktop browser the Keep Alive `read`s fall back to the stored value when
the call is mocked ([settings.js](source/js/settings.js),
[settings.js](source/js/settings.js)) — though, as said,
nothing calls those `read`s. The writes fail: Application type passes the
`mocked: true` info on, so the toast is `toast.mock` ("Dev mode: request not
sent"); the Keep Alive writes answer `cb(false, { error })` without `mocked`
([settings.js](source/js/settings.js)), so their toast is
`toast.failed` ("Request failed") — through `api.report`
([menu.js](source/js/menu.js)).

---

## Startup: applyAppPrefs and pruneStore

[app.js](source/js/app.js) calls `Settings.applyAppPrefs()`
([settings.js](source/js/settings.js)) before the dock
is drawn:

1. **`pruneStore()`** ([settings.js](source/js/settings.js))
   - `Store.prune(keep)` keeps a key when it is an item id in the model index
     (`index[id]`, built from `sections` and `subsections`,
     [settings.js](source/js/settings.js)), when it is in
     `KEEP_KEYS` = `keepaliveSelfService`,
     `tweaksAppType`, `appIdSelect`, `appOrder`, `ssapKey`, `ssapRoute`,
     `appsCache`
     ([settings.js](source/js/settings.js)), or when it starts with
     `appShow:`. Everything else — what older builds stored for rows that no
     longer exist — is deleted and flushed at once.
   - Why the exceptions: at startup the Applications section holds only its
     placeholder rows (`buildAppsItems(undefined)`,
     [settings.js](source/js/settings.js)), so the per-app switches
     are not in the index yet and are kept by prefix; `appIdSelect` exists only
     while the service has root, which is not known yet at startup
     ([settings.js](source/js/settings.js)). The other
     three `KEEP_KEYS` are item ids anyway (the Keep Alive subsection is
     indexed too), so listing them is belt and braces.
   - `Store.forget('webocu.settings.v1')` removes the localStorage entry of the
     settings panel this app grew out of
     ([settings.js](source/js/settings.js)).
2. `applyTheme()`, `applyAccent()`, `applyBg()`, `applyBgRail()`,
   `applyOpacity()`, `applyColumns()`, `applyRows()`, `applyOffsetX()`,
   `applyOffsetY()`, `applyQuick()`, `applyToast()` — each
   reads the store and sets the page.
3. `applyLanguage()` — `I18N.setLang(Store.get('appLanguage', 'en'))`; the TV
   locale is never read ([settings.js](source/js/settings.js)).

**Normalisation writes back.** `applyBg`, `applyBgRail`, `applyOpacity`
and `applyRows` snap the stored number to the
nearest step inside the range and store the snapped value when it differs
([settings.js](source/js/settings.js),
[settings.js](source/js/settings.js),
[settings.js](source/js/settings.js)). `applyOffsetX` and
`applyOffsetY` only clamp to the range (`inRange()`) and store nothing: a value
saved under an older step is used as it is until the slider writes a new one.
`applyColumns`,
`applyTheme`, `applyAccent` and `applyToast` fall back to a default for an
unknown value without storing anything.

---

## Preview params do not write the store

The URL debug params `?theme`, `?contrast`, `?accent`, `?bg`, `?bgRail`,
`?transparency`, `?cols`, `?rows`, `?dockX`, `?dockY`, `?home`,
`?hide`, `?toastAt` go through `Settings.preview*()`
([settings.js](source/js/settings.js),
[settings.js](source/js/settings.js)), which set the page
(or `dockNow`, or `hiddenPreview`) and never call `Store.set`. `?lang` calls
`I18N.setLang` directly ([app.js](source/js/app.js)).

So a screenshot of the row itself shows the **stored** value, not the
previewed one; to change a stored value from a URL, drive the row with
`?keys=`.

---

## Reset

General → Reset app settings (`appReset`, confirmed by `app.confirmReset`) →
`resetPrefs()` ([settings.js](source/js/settings.js)):
`Store.reset()` (empty object, flushed at once) → `applyAppPrefs()` →
`Menu.relabel()`, `Dock.relabel()`, re-render, toast `toast.reset`.

No luna call is made. The keepalive interval, the init script and the patched
window type therefore stay as they were on the TV, while the window goes back
to the defaults of the model (Webocu Service on,
Application type `popup`).

---

## Settings Inventory

Every row of [settings.js](source/js/settings.js). "Store key" is the item id
for every committed row; `—` means the row stores nothing.

### General (`common`)

| Item id | Type | Store key | Default | Applied by |
|---------|------|-----------|---------|------------|
| `appLanguage` | select (languages from `I18N.getAvailableLanguages()`) | `appLanguage` | `'en'` | `applyLanguage()` → `I18N.setLang`, `Menu.relabel()` |
| `appClock` | submenu → `clock` | — | — | `status` = `clockSummary()` |
| `appTimeFormat` (submenu `clock`) | select `off` (listed first, worded Empty) / `24h` / `24hn` (no zero before a single digit) / `12h` | `appTimeFormat` | `'24h'` | `applyClockLook()` → `data-clock`; text by `Settings.timeText()` in `dock.js` `paintClock()` |
| `appDateFormat` (submenu `clock`) | select `off` (first, worded Empty) / `wday` / `dmy` / `mdy` / `ymd` / `dmon` / `dmonwd` / `dm` / `wdaydm` / `wdaynum` / `dlong` | `appDateFormat` | `'dmonwd'` | `applyClockLook()` → `data-date`; text by `Settings.dateText()` |
| `appClockColour` (submenu `clock`) | toggle | `appClockColour` | `true` | `applyClockLook()` → `data-clock-accent` |
| `appDateColour` (submenu `clock`) | toggle | `appDateColour` | `true` | `applyClockLook()` → `data-date-accent` |
| `appClockSize`, `appDateSize` (submenu `clock`) | select `xs` / `s` / `m` / `l` / `xl` | `appClockSize`, `appDateSize` | `'m'` | `applyClockLook()` → `data-clock-size`, `data-date-size` (the CSS scales the type: 0.8 / 0.9 / 1 / 1.1 / 1.25) |
| `appClockBold` (submenu `clock`) | toggle | `appClockBold` | `true` | `applyClockLook()` → `data-clock-bold` (both bands) |
| `appOpenAtStart` | toggle | `appOpenAtStart` | `true` | no `apply`: `app.js` reads `Settings.openAtStart()` once, before the first showing of a start made with launch param `boot` (off → `Platform.quitApp()`: the app quits, the next launch is cold). Shown as "Autostart" |
| `appAutoHide` | select `'5'` / `'10'` / `'20'` / `'30'` / `'60'` (seconds) | `appAutoHide` | `'30'` | `applyAutoHide()` → `dockNow.idleSec` (`Settings.autoHideSeconds()`; `app.js` `armIdle()` runs the timer) |
| `appOpenFocus` | select `last` / `first` / `end` | `appOpenFocus` | `'last'` | `applyOpenFocus()` → `dockNow.openFocus` (`Settings.openFocus()`); `dock.js` `placeFocus()` runs it on every showing (`open()`, `reveal()`, and `finishLoad()` when the list arrives later): `last` keeps `focusId` as the memory of the app holds it (nothing is stored on disk), `first` / `end` set it to the first / last app of the list |
| `appReset` | action, `confirmKey` | — | — | `resetPrefs()` |

### Appearance (`look`)

| Item id | Type | Store key | Default | Applied by |
|---------|------|-----------|---------|------------|
| `lookTheme`, `lookBg`, `dockLayout`, `dockHints`, `dockQuick`, `lookToast` | submenu rows of Appearance (`look`), in this order; no store key | — | — | levels `theme`, `bg`, `dock`, `hints`, `quick`, `toasts` (each `parentId: 'look'`); the rows below keep their ids, whichever level they are on |
| `appDarkMode` | toggle | `appDarkMode` | `true` | `applyTheme()` → `data-theme` |
| `appContrast` | toggle | `appContrast` | `false` | `applyTheme()` → `data-contrast` |
| `appAccent` | select (28 `ACCENTS`) | `appAccent` | `'magenta'` | `applyAccent()` → `--accent` |
| `appBg` | slider 0–100, step 10 | `appBg` | `10` | `applyBg()` → `--bg-opacity`, `data-bg` |
| `appBgRail` | slider 0–100, step 10 | `appBgRail` | `10` | `applyBgRail()` → `--bg-opacity-rail`, `data-bg-rail` |
| `appTransparency` (level `bg`) | slider 0–70, step 5 | `appTransparency` | `0` | `applyTransparency()` → `--ui-opacity` = (100 − value) / 100. `migrate()` (before `pruneStore()`) turns a stored `appOpacity` into `100 − opacity` |
| `dockColumns` | select `'1'` … `'7'` | `dockColumns` | `'1'` | `applyColumns()` → `data-cols` |
| `dockRows` | slider 3–7, step 1 | `dockRows` | `6` | `applyRows()` → `dockNow.rows` (`Settings.rows()`) |
| `dockSide` | select `left` / `right` | `dockSide` | `'left'` | `applySide()` → `data-side` |
| `dockOffsetX` | slider 0–960, step 10 | `dockOffsetX` | `0` | `applyOffsetX()` → `--dock-x` |
| `dockOffsetY` | slider −540…540, step 10 | `dockOffsetY` | `0` | `applyOffsetY()` → `dockNow.offsetY` (`Settings.offsetY()`, clamped in `dock.js` `placePanel()`) |
| `dockEffect` (level `dock`) | select `edge` (the dock's own side) / `opposite` / `top` / `bottom` / `fade` / `pop` / `none` (a stored `left` / `right` of the earlier list is turned by `migrate()` into `edge` or `opposite`, by `dockSide`) | `dockEffect` | `'edge'` | `applyDockEffect()` → `data-dock-effect` on `<html>` (the CSS moves the panel from its start to its place); `dock.js` `placePanel()` writes `--panel-left/-right/-top/-bottom` (the panel's distance from each edge of the screen) that the four slides start from; `rest()` / `playIn()` replay it when the app is shown again |
| `dockQuick1` … `dockQuick3` | select: `off`, `home`, `syssettings`, `store`, `browser`, `media`, `homehub`, `poweroff`, `restart`, `screenoff`, `eco`, `sleep` | `dockQuick1` … `dockQuick3` | `'off'`, `'off'`, `'home'` | `applyQuick()` → `dockNow.quick` (`Settings.quickAt(slot)`); the rows live in the `quick` submenu of Appearance. An old `dockHome` key is not an item id, so `pruneStore()` removes it |
| `dockQuick4` | select: `settings`, `submenu` | `dockQuick4` | `'settings'` | `applyQuick4()` → `dockNow.quick4` (`Settings.quick4()` gives the command: the dock's Settings, or the `QUICK` submenu entry that `dock.js` opens like buttons 1…3). With `submenu` the Settings window opens only from an item of the submenu; nothing keeps that item there |
| `dockSub1` … `dockSub8` | select: `off`, every command of `QUICK` but `submenu`, and `settings` (the dock's own) | `dockSub1` … `dockSub8` | `'settings'`, `'syssettings'`, `'screenoff'`, then `'off'` ×5 (only a place nobody set reads them) | `applySub()` → `dockNow.sub` (`Settings.submenu()` gives the column; the dock's Settings is added when no place holds it); the rows live in the `quick` submenu of Appearance |
| `dockLabels` (level `hints`) | select `'0.5'`, `'1'`, `'3'`, `'5'` (seconds; no 0 — a stored 0, the old "never", turns the three switches off (`migrate()`) and the timing goes back to the default; an older stored value moves to the nearest stop) | `dockLabels` | `'0.5'` | `applyLabels()` → `dockNow.labelSec` (`Settings.labelSeconds()`, 0 while `dockNow.labelOn` is off; `dock.js` `paintLabel()` runs the timer; the name shows only after an arrow or the pointer moved the focus — `moved()`) |
| `dockLabelPlace` (level `hints`) | select `'tile'`, `'dock'` (against the icon, or beside the panel of the dock, on the other side of it when there is no room) | `dockLabelPlace` | `'dock'` | `applyLabelPlace()` → `dockNow.labelPlace` (`Settings.labelPlace()`; `dock.js` `paintLabel()` places the name) |
| `dockHintsApps`, `dockHintsQuick`, `dockHintsSub` (level `hints`) | toggle | the same | `false`, `false`, `true` (`DEF_HINTS_APPS`, `DEF_HINTS_QUICK`, `DEF_HINTS_SUB`: in a fresh install only the items of the submenu name themselves) | `applyHints()` → `dockNow.hintApps/hintQuick/hintSub` (`Settings.hintOn(kind)`; `dock.js` `paintLabel()` asks for the kind of the tile: app, quick button (Settings among them), submenu item). `migrate()` turns an old `dockHintsOn = false` or `dockLabels = 0` into all three off, and an `appOpacity` into `appTransparency` |
| `dockLabelStyle` (level `hints`) | select `pill` / `soft` / `solid` / `text` / `compact` | `dockLabelStyle` | `'pill'` | `applyHints()` → `data-hint-style` on `<html>` (the CSS paints the name; `solid` is filled with the accent and takes no colour switch) |
| `dockLabelEffect` (level `hints`) | select `slide` / `fade` / `pop` / `none` | `dockLabelEffect` | `'slide'` | `applyHints()` → `data-hint-effect` (the CSS variables `--hint-slide`, `--hint-pop`) |
| `dockLabelText`, `dockLabelBorder` (level `hints`) | toggle | `dockLabelText`, `dockLabelBorder` | `false`, `false` | `applyHints()` → `data-hint-text`, `data-hint-border` (the letters / the frame in the accent colour) |
| `appToastTop` | toggle | `appToastTop` | `true` | `applyToast()` → `data-toast-v`, plus a sample toast |
| `appToastAlign` | select left / center / right | `appToastAlign` | `'center'` | `applyToast()` → `data-toast-h`, plus a sample toast |

Ranges and defaults: [settings.js](source/js/settings.js);
rows: [settings.js](source/js/settings.js).

### Applications (`apps`)

| Item id | Type | Store key | Default | Applied by |
|---------|------|-----------|---------|------------|
| `appsHome` | action | — | — | `Luna.launch(Settings.HOME_APP)`; on success the window closes and the app is left (`app:exit`) |
| `appsRefresh` | action | — | — | `loadApps(cb, true)` → `Dock.load(done, true)`: reads the TV, replaces `appsCache` |
| `appsLoading` / `appsFailed` / `appsEmpty` | info | — | — | — |
| `appShow:<app-id>` (one per user app and per TV input, built from the list the dock read) | toggle | `appShow:<app-id>` | `true` for an app, `false` for a TV input | `write` → `Dock.relabel()`; the dock reads it through `Settings.isShown(id, !isInput)` = `Store.get('appShow:' + id, def) !== false` |

Code: [settings.js](source/js/settings.js). An app keeps
its switch across reinstalls because the key is its id; a key of an app that
was removed stays in the store (the prefix rule keeps every `appShow:` key).

### Tweaks (`tweaks`)

| Item id | Type | Store key | Default | Applied by |
|---------|------|-----------|---------|------------|
| `privGroup` | group | — | — | — |
| `requestPriv` | action | — | — | `Luna.elevate()`; the answer goes to `device.service` (memory, not the store) |
| `privInfo` | info | — | — | — |
| `appIdGroup` | group | — | — | — |
| `switchAppId` | submenu | — | — | opens the Switch app ID subsection |
| `lifecycleGroup` | group | — | — | — |
| `tweaksKeepAlive` | submenu; status text: `keepaliveSelfService` from the store, "Init" from the service's `root` | — | — | opens the Keep Alive subsection |
| `homeBound` (key only, no row) | boolean | `homeBound` | `false` | Whether HOME is bound to the dock by either method (`homeHook`, `homeSetting`): written by `writeHome()` and by `loadHome()` when the answer came from a root service, read once at start when it is missing (`Settings.refreshHomeBound()`); in `KEEP_KEYS`. `dock.js` `armPointer()` reads `Settings.homeBound()` at every showing: with it, a pointer that the TV shows by itself is put away (`Luna.hidePointer()` → service `pointerKey` → an arrow over the SSAP pointer socket); `data-cursor-hide` on `<html>` records the try. The always-on guard (`data-pointer`) keeps a pointer from moving the focus until it is moved. The old `appCursorFocus` row is gone (pruned) |
| `tweaksAppType` | select popup / overlay / card / minimal / home / system_ui | `tweaksAppType` | `'popup'` | hybrid: Store + `Luna.patchAppInfo` → `/patchAppInfo` |

### Switch app ID (subsection `switchAppId`, rebuilt from `device.service`)

| Item id | Type | Store key | Default | Applied by |
|---------|------|-----------|---------|------------|
| `switchIdWarning` | info (without root) | — | — | — |
| `appIdSelect` | select (with root) | `appIdSelect` | the current app id | `write` stores locally only |
| `appIdApply` | action (with root) | — | — | `Luna.checkAppExists` → confirmation → `Luna.switchAppId` → `/cloneAppId` |
| `switchTo_<id>_disabled` | info (without root), one per id | — | — | — |

Code: [settings.js](source/js/settings.js).

### Keep Alive (subsection `keepalive`)

| Item id | Type | Store key | Default | Applied by |
|---------|------|-----------|---------|------------|
| `keepaliveSelfService` | toggle | `keepaliveSelfService` | `true` | hybrid: Store + `/enableSelfKeepalive` / `/disableSelfKeepalive` |

Code: [settings.js](source/js/settings.js).

### About (`about`)

`aboutHead`, `aboutText` / `aboutLoading` / `aboutFailed` — info rows, nothing
stored. The text and the version are read from `about.html` and `appinfo.json`
on first open and kept in memory ([settings.js](source/js/settings.js)).

### Not in localStorage at all

- `device.service` — the last `/status` answer, in memory
  ([settings.js](source/js/settings.js)).
- `dockNow`, `hiddenPreview`, `themeNow` — the applied or previewed values, in
  memory ([settings.js](source/js/settings.js),
  [settings.js](source/js/settings.js)).
- The dock's `iconCache` — data URIs of icons the service read, for the life of
  the page ([dock.js](source/js/dock.js)).

---

## Known Gaps

Read from the code; see also START_FLOW.md → Known Gaps.

1. **A failed write keeps the new value.** `commit()` stores before `write()`
   ([settings.js](source/js/settings.js)); none of the three hybrid
   writes restores the old value on failure, and `tweaksAppType` stores it a
   second time before the call ([settings.js](source/js/settings.js)).
   The re-render after a failure ([menu.js](source/js/menu.js))
   therefore shows the value that was refused.
2. **The Keep Alive switch is never read from the service.** Its `read()`
   is defined but not called (a subsection without `load()`), so the window
   trusts the store.
3. **Fresh install vs. the service.** `keepaliveSelfService` defaults to `true`
   in the model while the service starts with no interval and nothing enables
   it at startup.
4. **The specific toast of a hybrid row is overwritten.** Each hybrid `write`
   shows its own toast and then answers `cb(true)` / `cb(true, info)` without
   `local: true`; `applyValue()` then calls `api.report(true)`, which shows
   `toast.applied` in the same tick ([menu.js](source/js/menu.js),
   [menu.js](source/js/menu.js)). "Restart the app" for
   Application type is therefore not seen. Derived from the code, not observed
   on a TV.

---

## File Reference

| File | Role in storage |
|------|-----------------|
| [source/js/store.js](source/js/store.js) | the localStorage wrapper |
| [source/js/settings.js](source/js/settings.js) | the model: items, `commit`, `refresh`, `apply*`, `preview*`, `pruneStore`, `resetPrefs` |
| [source/js/menu.js](source/js/menu.js) | `applyValue` → `commit`, reporting of the result |
| [source/js/dock.js](source/js/dock.js) | reads the dock values through `Settings` |
| [source/js/luna.js](source/js/luna.js) | the service calls of the hybrid items |
| [source/service/service.js](source/service/service.js) | where the hybrid items take effect |
| [source/js/app.js](source/js/app.js) | calls `applyAppPrefs()` at startup; applies the preview params |
