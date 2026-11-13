# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.2] - 2026-11-13 - Initial public release

WebOCU Dock, an overlay app launcher for webOS TV. Also available from the Homebrew Channel catalog at
`https://webocu.github.io/`.

### Added

- The dock at the left or right edge of the picture with the icons of the installed user
  apps and the TV's inputs, driven by the remote and by the Magic Remote pointer.
- A grid of 1 to 7 columns and 3 to 7 rows, an offset from the edge, a vertical position and an
  entrance effect.
- Up to four quick buttons at the foot: webOS Home, webOS Settings, LG Store, Browser, Media
  Player, Home Dashboard, Eco mode, Sleep timer, Power Off, Restart, Screen Off, or a Submenu
  of up to eight items.
- Names of the icons as hints, in five styles and four effects.
- A clock and a date in the dock.
- Themes (dark, light, contrast), accent colours, background pictures and transparency.
- A Settings window: Applications, General, Appearance, Tweaks and About.
- Twelve languages.
- A helper service that lists and launches apps and reads icons, with a fallback chain for
  firmware where a Developer Mode app may not ask the application manager directly.
- Root features for rooted TVs: privileges for the helper service, keep-alive, switching the
  app ID, and the HOME button opening the dock.
- About: project address, the Homebrew Channel catalog, the related project (WebOCU Settings) and
  the credits with the addresses of the sources of the bundled third-party programs.
- Third-party notices with the origin, the SHA-256 and the corresponding source of the GPL-3.0
  library, and the MIT notice of Hearth, inside the package.

[Unreleased]: https://github.com/webocu/webocu-dock/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/webocu/webocu-dock/releases/tag/v0.3.2
