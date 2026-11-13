# Third-party notices

The code of WebOCU Dock is released under the [MIT License](LICENSE). The package it builds
also carries components written by others, under their own licenses. They are used only by
the HOME-button feature (Settings → Tweaks), which needs a rooted TV; the dock itself does
not load any of them.

| Component | Where it is | License | Text of the license |
| --- | --- | --- | --- |
| **libinputhookpp.so**: [inputhookpp](https://github.com/sundermann/inputhookpp) by Sundermann, as built in [Input Hook](https://github.com/Simon34545/lginputhook) by Simon34545 | `source/homehook/libinputhookpp.so` (binary, unmodified) | GPL-3.0 | [`source/licenses/inputhookpp-GPL-3.0.txt`](source/licenses/inputhookpp-GPL-3.0.txt) |
| **ezinject**, a process injector, © 2021 Stefano Moioli ([smx-smx/ezinject](https://github.com/smx-smx/ezinject)) | `source/homehook/ezinject` (binary, unmodified) | zlib-style permissive license | [`source/licenses/ezinject-COPYING.txt`](source/licenses/ezinject-COPYING.txt) |
| **Input Hook**'s own code, © 2023 simon_34545 ([Simon34545/lginputhook](https://github.com/Simon34545/lginputhook)) | the library above is built from it; license notice shipped with it | BSD-3-Clause | [`source/licenses/lginputhook-BSD-3-Clause.txt`](source/licenses/lginputhook-BSD-3-Clause.txt) |
| **Hearth**, © 2026 webos-launcher contributors and rudra-avatar ([rudra-avatar/Hearth](https://github.com/rudra-avatar/Hearth)) | adapted into the key engine [`source/homehook/homehook.sh`](source/homehook/homehook.sh), the start-up check [`source/homeapp/guard.sh`](source/homeapp/guard.sh) and the parts of [`source/service/service.js`](source/service/service.js) and [`source/js/luna.js`](source/js/luna.js) that say so in their comments | MIT | [`source/licenses/hearth-LICENSE.txt`](source/licenses/hearth-LICENSE.txt) |
| **Lucide** icon `leaf`, © Lucide Contributors, portions © Cole Bemis | [`source/img/icon-eco.svg`](source/img/icon-eco.svg), the Eco mode button (shipped in the package) | ISC | [`source/licenses/lucide-LICENSE.txt`](source/licenses/lucide-LICENSE.txt) |
| **Lucide** and **Feather** icons in the icon library page | [`misc/icons.html`](misc/icons.html) (a development page, not in the package) | ISC (Lucide), MIT (Feather, © Cole Bemis) | [`source/licenses/lucide-LICENSE.txt`](source/licenses/lucide-LICENSE.txt), [`misc/feather-LICENSE.txt`](misc/feather-LICENSE.txt) |

The two binaries are the files that Hearth ships, taken unmodified from the Input Hook app
(`org.webosbrew.inputhook`, its `main` branch of October 2026). Their SHA-256:

| File | SHA-256 |
| --- | --- |
| `source/homehook/libinputhookpp.so` | `de2c155a598827e7b31b2fa2cfe80e1cc7ad9347ccdd16f1c2aeb9bc0db1b49d` |
| `source/homehook/ezinject` | `d2def5b3f68a415cf5a4a747ab70115e70a82f721bafbcc0d9c5a7bd5c161160` |

## How the components are used

`homehook.sh` is written to the TV by the helper service and runs as root through the
Homebrew Channel. It injects the bundled `libinputhookpp.so` into the TV's input processes
with the bundled `ezinject`, in the way the Input Hook app does, and shares that app's marker
file and settings file, so the two never inject twice. The injection lives in memory only; a
restart removes it. Nothing on the TV's flash changes except the settings file and the start-up
link. The details are in the header of [`homehook.sh`](source/homehook/homehook.sh).

## The GPL-3.0 library

`libinputhookpp.so` is distributed in binary form, together with the text of the GPL-3.0.
It is a separate file: the MIT-licensed code only starts the injector that loads it into the
TV's input processes, and the rest of WebOCU Dock does not link against it.

**Corresponding source.** The source of the library is the [inputhookpp](https://github.com/sundermann/inputhookpp)
project (GPL-3.0) by Sundermann and, with the changes made for the Input Hook app, the
[lginputhook](https://github.com/Simon34545/lginputhook) project by Simon34545 (the app's own code
BSD-3-Clause). The binary also contains code of libraries that inputhookpp builds in (it carries
strings of glib, Capstone, libdwarf and Frida Gum); their licenses are those of the projects
named above. The same addresses are written next to the binary, in
[`source/homehook/SOURCE.txt`](source/homehook/SOURCE.txt), which travels inside the package.

**Written offer.** If you received WebOCU Dock and cannot get the corresponding source from those
addresses, open an issue at <https://github.com/webocu/webocu-dock/issues> and a copy of the
source of `libinputhookpp.so` will be provided to you at no charge beyond the cost of the medium.
The offer is valid for three years from the release that carries the file, and for as long as
the file is distributed.

If you redistribute a package that contains the library, you take on the obligations of the
GPL-3.0 for that file.

## Icons

The line icons in [`source/img/`](source/img) are drawn in one style (24×24, stroke 1.7). They
were compared, path by path, with the packages `lucide-static` (versions 0.292 to 1.72) and
`feather-icons` 4.29.2:

- `icon-eco.svg` has the same geometry as Lucide's `leaf` (only the stroke width differs) and is
  credited above. No other file in `source/img/` equals an icon of either set. A few share
  primitive shapes only: the Timer icon has the same circle and two short straight strokes as
  Lucide's alarm clock, the Settings and Submenu icons a circle or a straight stroke.
- [`misc/icons.html`](misc/icons.html) (the icon library page used while designing) holds 500
  icons. 125 of them have exactly the geometry of a Lucide or a Feather icon (73 Lucide, 38
  Feather, 14 both) and about 100 more share a longer path with one of them. The page is not
  part of the package. Treat the icons on it as Lucide (ISC) and Feather (MIT) artwork unless
  you drew them yourself.

## Notices of the other licenses

- The zlib-style notice of ezinject and the BSD-3-Clause notice of lginputhook are kept
  unaltered in `source/licenses/` and are shipped inside the `.ipk`.
- The MIT notice of Hearth is kept unaltered in `source/licenses/` and shipped inside the `.ipk`; Hearth is also credited in the Settings → About text and in the headers of the files that were adapted from it.
- The ISC notice of Lucide is kept unaltered in `source/licenses/` and shipped inside the `.ipk`;
  the Feather MIT notice is kept in `misc/`.
