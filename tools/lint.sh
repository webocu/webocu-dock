#!/bin/sh
# Project checks without installing anything: JS syntax plus manifest sanity.
# Run: make lint
set -e

# Everything checked here is app content, so the checks run inside source/ and
# all the paths below read the way they are written in index.html. The project
# root is kept: the Tweaks test lives in tools/, next to this file.
ROOT=$(pwd)
cd "${SRC:-source}"

fail=0

echo "== node --check =="
for f in js/*.js service/*.js; do
  if node --check "$f"; then
    echo "  ok   $f"
  else
    echo "  FAIL $f"
    fail=1
  fi
done

echo "== helper service manifests =="
# The service id must match in three places, otherwise luna-service2 refuses to
# register it and the privileged path silently falls back to plain endpoints.
node -e '
  var fs = require("fs");
  var dir = "service";
  if (!fs.existsSync(dir)) { console.log("  ok   no service"); process.exit(0); }
  var app = JSON.parse(fs.readFileSync("appinfo.json", "utf8"));
  var expectedId = app.id + ".service";
  var pkg = JSON.parse(fs.readFileSync(dir + "/package.json", "utf8"));
  var svc = JSON.parse(fs.readFileSync(dir + "/services.json", "utf8"));
  if (pkg.name !== expectedId) { console.error("  FAIL package.json name " + pkg.name + " != " + expectedId); process.exit(1); }
  if (svc.id !== expectedId) { console.error("  FAIL services.json id " + svc.id + " != " + expectedId); process.exit(1); }
  if (!fs.existsSync(dir + "/" + pkg.main)) { console.error("  FAIL missing " + pkg.main); process.exit(1); }
  var names = (svc.services || []).map(function (s) { return s.name; });
  if (names.indexOf(expectedId) < 0) { console.error("  FAIL services[].name must contain " + expectedId); process.exit(1); }
  console.log("  ok   " + expectedId + " -> " + pkg.main);
'

echo "== app talks to the helper service =="
# js/luna.js must try the service first, so elevating it actually changes anything,
# and it must ask it for the two things the dock is made of: the list and a launch.
node -e '
  var fs = require("fs");
  var code = fs.readFileSync("js/luna.js", "utf8");
  var svc = JSON.parse(fs.readFileSync("service/services.json", "utf8"));
  // The URI is built from the id, so the id itself is what has to match.
  if (code.indexOf("\x27" + svc.id + "\x27") < 0) {
    console.error("  FAIL js/luna.js does not mention " + svc.id);
    process.exit(1);
  }
  var need = ["/status", "/listApps", "/launch"];
  var missing = need.filter(function (m) { return code.indexOf(m) < 0; });
  if (missing.length) {
    console.error("  FAIL js/luna.js must call the service " + need.join(", ") + " methods (missing " + missing.join(", ") + ")");
    process.exit(1);
  }
  console.log("  ok   luna.js uses luna://" + svc.id);
'

echo "== version =="
# version.txt is the source of truth, appinfo.json and the services mirror it.
node -e '
  var fs = require("fs");
  var txt = fs.readFileSync("version.txt", "utf8").trim();
  var a = JSON.parse(fs.readFileSync("appinfo.json", "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(txt)) { console.error("  FAIL version.txt must contain x.y.z"); process.exit(1); }
  if (a.version !== txt) {
    console.error("  FAIL appinfo.json " + a.version + " != version.txt " + txt + " (run make version-bump)");
    process.exit(1);
  }
  if (fs.existsSync("service/package.json")) {
    var pkg = JSON.parse(fs.readFileSync("service/package.json", "utf8"));
    if (pkg.version !== txt) {
      console.error("  FAIL service/package.json " + pkg.version + " != version.txt " + txt + " (run make version-bump)");
      process.exit(1);
    }
  }
  console.log("  ok   version.txt " + txt + " matches the manifest and the services");
'

echo "== appinfo.json =="
node -e '
  var fs = require("fs");
  var a = JSON.parse(fs.readFileSync("appinfo.json", "utf8"));
  var need = ["id", "version", "vendor", "type", "main", "title", "icon", "largeIcon"];
  var miss = need.filter(function (k) { return !a[k]; });
  if (miss.length) { console.error("  FAIL missing fields: " + miss.join(", ")); process.exit(1); }
  if (!/^\d+\.\d+\.\d+$/.test(a.version)) { console.error("  FAIL version must be x.y.z"); process.exit(1); }
  if (a.type !== "web") { console.error("  FAIL type must be web"); process.exit(1); }
  if (a.disableBackHistoryAPI !== true) { console.error("  FAIL disableBackHistoryAPI must be true (Back = 461)"); process.exit(1); }
  // Without these the window is a normal card: launching it stops playback.
  // popup is what the project ships; the others are the types the system
  // panels use and `make window TYPE=...` sets them for a launch test, so they
  // pass the check with a warning instead of failing the build.
  var types = ["overlay", "minimal", "popup", "system_ui"];
  if (types.indexOf(a.defaultWindowType) < 0) {
    console.error("  FAIL defaultWindowType must be one of: " + types.join(", "));
    process.exit(1);
  }
  if (a.defaultWindowType !== "popup") {
    console.log("  warn defaultWindowType is " + a.defaultWindowType + ", not popup (make window TYPE=popup to go back)");
  }
  if (a.transparent !== true) { console.error("  FAIL transparent must be true for the panel"); process.exit(1); }
  if (a.bgColor) { console.error("  FAIL bgColor paints over the video, drop it"); process.exit(1); }
  // SAM draws the round launch spinner over the app unless this is false: the
  // system panels that come up clean (tvhotkey, booteffect, care365) all set it.
  if (a.spinnerOnLaunch !== false) { console.error("  FAIL spinnerOnLaunch must be false (the round spinner on launch)"); process.exit(1); }
  if (a.networkStableTimeout !== 0) { console.error("  FAIL networkStableTimeout must be 0 (do not wait for the network before showing)"); process.exit(1); }
  ["icon", "largeIcon", "main"].forEach(function (k) {
    if (!fs.existsSync(a[k])) { console.error("  FAIL missing file: " + a[k]); process.exit(1); }
  });
  console.log("  ok   " + a.id + " " + a.version + " (" + a.title + ")");
'

echo "== index.html references =="
node -e '
  var fs = require("fs");
  var html = fs.readFileSync("index.html", "utf8");
  var bad = [];
  var re = /(?:src|href)="([^"http][^"]*)"/g, m;
  while ((m = re.exec(html))) { if (!fs.existsSync(m[1])) bad.push(m[1]); }
  if (bad.length) { console.error("  FAIL not found: " + bad.join(", ")); process.exit(1); }
  console.log("  ok   all local assets exist");
'

echo "== home-button engine =="
# The HOME-remap "hook" method ships the Input Hook binaries and its boot script,
# and must carry the licences they are under (GPL-3.0 for the library, zlib for
# the injector, MIT for what is adapted from Hearth) and where the source of the
# GPL library is. The method quietly does nothing if these go missing, so only
# this check would notice.
node -e '
  var fs = require("fs");
  var need = [
    "homehook/homehook.sh", "homehook/ezinject", "homehook/libinputhookpp.so",
    "homeapp/guard.sh",
    "homehook/SOURCE.txt",
    "licenses/inputhookpp-GPL-3.0.txt", "licenses/ezinject-COPYING.txt", "licenses/hearth-LICENSE.txt"
  ];
  var bad = need.filter(function (f) { return !fs.existsSync(f); });
  if (bad.length) { console.error("  FAIL missing: " + bad.join(", ")); process.exit(1); }
  console.log("  ok   input-hook files and their licences are there");
'

echo "== about page =="
# The About section reads this file at runtime, so it is never referenced from
# index.html: nothing else would notice it going missing.
node -e '
  var fs = require("fs");
  var path = "about.html";
  if (!fs.existsSync(path)) {
    console.error("  FAIL missing " + path + " (Settings -> About reads it)");
    process.exit(1);
  }
  if (!fs.readFileSync(path, "utf8").trim()) {
    console.error("  FAIL " + path + " is empty");
    process.exit(1);
  }
  console.log("  ok   " + path + " is there");
'

echo "== panel backgrounds =="
# The four images Settings -> Appearance -> Background image paints the dock and
# the window from. They are named in css/app.css and nowhere else, so nothing but
# this check would notice one going missing: the setting would simply paint nothing. Nothing
# generates them any more either -- they are art, put there by hand -- so the
# sizes are left alone and only the layer they are painted on is checked.
node -e '
  var fs = require("fs");
  var css = fs.readFileSync("css/app.css", "utf8");
  var bad = [];
  ["rail", "pane"].forEach(function (part) {
    ["dark", "light"].forEach(function (theme) {
      var file = "img/" + part + "-" + theme + ".png";
      if (!fs.existsSync(file)) bad.push(file + " is missing");
      else if (css.indexOf("../" + file) < 0) bad.push(file + " (not used by the stylesheet)");
    });
  });

  /* Scaled to the box and nothing else: a leftover border-image would draw part
     of a picture at its own size and stretch the rest, which is the distortion
     this scheme replaced. */
  if (css.indexOf("background-size: 100% 100%") < 0) {
    bad.push("no background-size: 100% 100% on the picture layer");
  }
  /* A declaration, not the word: the comment above the layer explains what this
     scheme replaced, and saying so must not fail the check. */
  if (/border-image[a-z-]*\s*:/.test(css)) {
    bad.push("css/app.css still slices a background with border-image");
  }

  if (bad.length) { console.error("  FAIL " + bad.join("; ")); process.exit(1); }
  console.log("  ok   four backgrounds, one per column per theme, scaled to the box");
'

echo "== i18n keys =="
# Every key used in code must exist in every language, and no language may carry a
# key English does not have. The dictionaries are read from locales/*.js files.
# Languages are discovered automatically from available files.
node -e '
  var fs = require("fs");
  var path = require("path");

  // Discover all locale files
  var localesDir = "locales";
  var files = fs.readdirSync(localesDir).filter(function (f) { return f.endsWith(".js"); });
  var names = files.map(function (f) { return f.replace(".js", ""); });

  if (names.indexOf("en") < 0) {
    console.error("  FAIL no locale file for en (locales/en.js)");
    process.exit(1);
  }

  // Load each locale file and extract keys
  var blocks = {};
  names.forEach(function (lang) {
    var src = fs.readFileSync(path.join(localesDir, lang + ".js"), "utf8");
    blocks[lang] = src;
  });

  function keysOf(text) {
    var out = {}, re = /\x27([a-zA-Z0-9._]+)\x27\s*:/g, m;
    while ((m = re.exec(text))) out[m[1]] = true;
    return out;
  }

  var en = keysOf(blocks.en);
  var bad = false;

  names.forEach(function (lang) {
    if (lang === "en") return;
    var other = keysOf(blocks[lang]);
    var missing = Object.keys(en).filter(function (k) { return !other[k]; });
    var extra = Object.keys(other).filter(function (k) { return !en[k]; });
    if (missing.length) {
      console.error("  FAIL missing in " + lang + ": " + missing.join(", "));
      bad = true;
    }
    if (extra.length) {
      console.error("  FAIL not in en: " + extra.join(", ") + " (from " + lang + ")");
      bad = true;
    }
  });

  if (bad) process.exit(1);

  // Keys referenced from other modules must be defined.
  var used = {};
  ["js/settings.js", "js/menu.js", "js/dialog.js", "js/dock.js", "js/app.js"].forEach(function (f) {
    var code = fs.readFileSync(f, "utf8"), re = /\x27([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)\x27/g, m;
    while ((m = re.exec(code))) {
      var key = m[1];
      if (/^(luna|com|window|document)\./.test(key)) continue;
      // Our own app and service id (Tweaks names it as the default choice).
      if (/^webocu\./.test(key)) continue;
      // App IDs that can be switched to are data, not translation keys.
      if (/^yota\.play$/.test(key)) continue;
      if (/\.(js|json|css|html|png|mp4|m3u8)$/.test(key)) continue;   // a file name, not a key
      used[key] = f;
    }
  });

  var undef = Object.keys(used).filter(function (k) { return !en[k]; });
  if (undef.length) {
    console.error("  FAIL keys used but not translated: " + undef.join(", "));
    process.exit(1);
  }

  console.log("  ok   " + Object.keys(en).length + " keys, " + names.length +
              " languages in sync (" + names.join(" ") + ")");
'

echo "== destructive actions are confirmed =="
# reboot() and powerOff() must not be reachable unless the user has said so: from
# a Settings row (the item literal carries confirmKey) or from the dock's foot
# button (the call sits in the callback of Dialog.show, the countdown window).
node -e '
  var fs = require("fs");
  var bad = [];
  [["js/settings.js", "confirmKey"], ["js/dock.js", "Dialog.show("]].forEach(function (file) {
    var code = fs.readFileSync(file[0], "utf8");
    ["reboot", "powerOff"].forEach(function (call) {
      var idx = code.indexOf("Luna." + call + "(");
      while (idx >= 0) {
        // settings.js: the item literal around the call; dock.js: the window above it.
        var start = file[1] === "confirmKey" ? code.lastIndexOf("        {", idx) : idx - 1500;
        var chunk = code.slice(start < 0 ? 0 : start, idx);
        if (chunk.indexOf(file[1]) < 0) bad.push(file[0] + " " + call);
        idx = code.indexOf("Luna." + call + "(", idx + 1);
      }
    });
  });
  if (bad.length) {
    console.error("  FAIL no confirmation guarding: " + bad.join(", "));
    process.exit(1);
  }
  console.log("  ok   reboot / powerOff require confirmation");
'

if [ "$fail" -ne 0 ]; then
  echo "LINT: FAILED"
  exit 1
fi
echo "LINT: OK"
