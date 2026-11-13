#!/bin/sh
# The round progress spinner over a launching app is drawn by the system, not by
# the app: SAM keeps a per-app "spinnerOnLaunch" flag (default true for anything
# installed) and the manifest is the only place to turn it off. The window type
# decides the rest of the launch presentation; this script switches
# defaultWindowType in place so the types can be compared on a live TV without
# editing the manifest by hand between deploys.
#
# Types worth trying:
#   popup      a panel over the picture, media keeps playing (what this project ships)
#   overlay    media keeps playing under the panel
#   minimal    a lighter panel surface
#   system_ui  often refused for ordinary web packages; may fall back to card
#
# Run: sh tools/window.sh [overlay|minimal|popup|system_ui]   (make window TYPE=)
set -e

SRC=${SRC:-source}
INFO=$SRC/appinfo.json
TYPE=${1:-${TYPE:-popup}}

case "$TYPE" in
  overlay)   NOTE="media keeps playing under the panel" ;;
  minimal)   NOTE="lighter panel surface" ;;
  popup)     NOTE="panel over the picture; media keeps playing" ;;
  system_ui) NOTE="often refused for web packages; may fall back to card" ;;
  *) echo "unknown window type: $TYPE (overlay|minimal|popup|system_ui)" >&2; exit 1 ;;
esac

CUR=$(sed -n 's/.*"defaultWindowType"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INFO")
[ -n "$CUR" ] || { echo "no defaultWindowType in $INFO" >&2; exit 1; }

sed -i 's/\("defaultWindowType"[[:space:]]*:[[:space:]]*"\)[^"]*\("\)/\1'"$TYPE"'\2/' "$INFO"

echo "  defaultWindowType $CUR -> $TYPE"
echo "  note: $NOTE"
echo "  next: make deploy, then watch whether the video keeps playing under it"
