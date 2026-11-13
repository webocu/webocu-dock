# Contributing to WebOCU Dock

Thanks for taking the time. Bug reports, translations and pull requests are welcome.

## Before you start

- Search the [issues](https://github.com/webocu/webocu-dock/issues) first.
- For a bigger change, open an issue to talk it through before writing the code.
- Report security problems privately, see [SECURITY.md](SECURITY.md).
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

[Docker](https://docs.docker.com/get-docker/) (Desktop, or engine + Compose v2) is the only
requirement. There is no local Node.js and no webOS CLI to install: everything runs in
containers through `tools/docker-compose.yml`, driven by `make`.

```sh
make            # list all targets
make dev        # the app in a browser: http://localhost:8080  (make dev-stop)
make lint       # JS syntax, manifests, version, i18n, guard checks
make smoke      # headless Chromium DOM / focus / console test
make shots      # 1920x1080 screenshots into test/shots/
make check      # lint + smoke + package: the full check
```

There is no per-test runner: `lint` and `smoke` are single scripts
(`tools/lint.sh`, `tools/smoke.sh`). `tools/smoke.sh` accepts `CHROME=` and `BASE=`, so it also
runs against `make dev` with a Chromium outside the container.

Run `make lint` (and, for a UI change, `make smoke`) before you open a pull request.

## Trying a change without a TV

Every behaviour of the app can be reached from a URL query string, so the dock is developed
and checked in a browser. In a desktop browser the list of apps is a mock list and a launch
is never sent. The authoritative list of parameters is the comment block at the end of
[`source/js/app.js`](source/js/app.js), for example:

```
http://localhost:8080/?cols=3&rows=5&apps=30&keys=down,right
http://localhost:8080/?section=look&theme=light
```

`preview*` parameters do not write the stored settings; `?keys=` is applied last, through the
same router as the remote.

When a change alters what an existing screenshot shows, update the comment above its
`$(SHOT)` line in the `Makefile`: those comments explain why each screenshot exists.

## Code conventions

- **ES5 throughout**, in the browser and in the helper service: `var`, no arrow functions, no
  template literals, no modules. Node on the TV is old. Each script publishes one global
  (`window.X = (function () { ... })()`) and scripts load in a fixed order from
  `source/index.html`.
- **No build step, no framework, no npm dependencies.**
- **Comments explain why**, not what: non-obvious firmware behaviour, layout decisions,
  why a check exists. Code and comments are in English.
- **Adding an option** touches `source/js/settings.js` (the declarative model of the Settings
  window) and the locale files in `source/locales/`, and nothing else: not `menu.js`, not
  the CSS. A key stored under a name of its own goes into `KEEP_KEYS` in `settings.js`.
- **Translations:** one file per language in `source/locales/`. `en.js` is required and is
  the reference: every key must exist in every language, and no language may hold a key
  that `en` lacks. `make lint` checks this.
- **The helper service** answers even before root is granted, with `returnValue: false` and
  an `errorText`. Its `/icon` method serves image files from the app directories only; keep
  that check when touching it.
- `build/` and `test/` are generated (`make clean`); never edit `build/` by hand.

`make lint` enforces the invariants that keep the app's window from stopping video playback
or drawing a splash over the picture (`source/appinfo.json`), the version in one place
(`source/version.txt`), the service id in every file that names it, the i18n rules and the
guard around `Luna.reboot()` / `Luna.powerOff()`. Read `tools/lint.sh` before changing any of
these.

## Versions

`source/version.txt` is the single source of truth; `appinfo.json` and the service
`package.json` mirror it.

```sh
make build                  # build the .ipk, no version change
make build PART=patch       # bump the patch version, then build
make version-bump PART=minor
```

Describe user-visible changes in [CHANGELOG.md](CHANGELOG.md) under *Unreleased*.

## Pull requests

- One topic per pull request, a short description of what changes and why.
- Keep the diff focused: no drive-by reformatting.
- `make lint` passes; screenshots of UI changes are welcome.

## Installing on a TV

Developer Mode:

```sh
make tv-add TV=192.168.1.50 NAME=tv     # Developer Mode must be on
make tv-key NAME=tv                     # asks for the passphrase from the Developer Mode app
make tv-use-tv                          # make it the default device
make build
make deploy                             # install + launch
```

Rooted with webosbrew (a real sshd on port 22, root / alpine) — no key to fetch:

```sh
make tv-add-root TV=192.168.1.51 NAME=tv2
make tv-use-tv2
make build
make deploy
```

`make install` picks the route from the registered device: `ares-install` for a Developer Mode
profile, plain ssh for a rooted one (`ares-install` cannot talk to the sshd a rooted TV runs,
see the comment at the top of `tools/install.sh`).

`make deploy`, `launch`, `close`, `uninstall` and `inspect` use the device marked as default
in the profile; override it with `DEVICE=<name>`.

### Device profiles

Registered TV profiles are kept in the Docker volume `webocu-dock_ares-config` (mounted at
`/root/.webos` in the container, file `/root/.webos/tv/novacom-devices.json`). The volume is
named after the compose project, so it survives container restarts. To start over:

```sh
make tv-reset                                          # forget all devices, keep the volume
docker compose -f tools/docker-compose.yml down        # or delete the volume completely:
docker volume rm webocu-dock_ares-config
```

## `make` reference

| Target | What it does |
| --- | --- |
| `make dev` / `make dev-stop` | static server on http://localhost:8080 |
| `make lint` / `make smoke` / `make check` | the checks above |
| `make shots` | UI screenshots into `test/shots/` |
| `make build [PART=patch\|minor\|major\|keep]` | build `dist/webocu.dock_<version>_all.ipk` |
| `make bump` / `make version-bump PART=…` | bump the version |
| `make icons` | regenerate `source/icons/*.png` (overwrites the shipped icons) |
| `make tv-add`, `tv-add-root`, `tv-key`, `tv-list`, `tv-remove`, `tv-reset` | device profiles |
| `make tv-use-<name>` | make a registered device the default |
| `make install`, `launch`, `close`, `deploy`, `uninstall` | work on the TV |
| `make inspect` | Chrome DevTools for the app on the TV |
| `make window TYPE=overlay\|minimal\|popup\|system_ui` | set the window type in `appinfo.json` for comparison on a TV |
| `make clean` / `make distclean` | remove `build/` and `test/` / also `dist/` and the Docker images |

Variables: `TV=<ip>`, `NAME=<device name>`, `DEVICE=<name>`, `APP_ID=<id>`, `PART=…`, `TYPE=…`.

## License

By contributing you agree that your contribution is released under the [MIT License](LICENSE).
