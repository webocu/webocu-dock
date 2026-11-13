#!/bin/sh
# Start-up check for "HOME opens the dock (system setting)". Written to the TV by the helper service (rooted TVs only);
# never copied by hand. Adapted from Hearth (MIT, https://github.com/rudra-avatar/Hearth).
#
# That method writes the dock's id into the TV's own Home app setting (general.defaultApps.home). If the dock is then
# uninstalled without switching it off, the HOME button would name an app that is gone. At the next start this script
# sees that, puts back the app that was the Home app before (kept in $DIR/previous), and deletes itself and that file.
# While the dock is installed it does nothing.
#
# It lives in the data folder of the app that turned the method on, /media/developer/apps/var/lib/webocu/<app-id>/,
# next to that app's other files on the TV (the keepalive daemon, the key engine), so it removes only its own two
# files there, and the folders once empty. The link is one per TV; it is removed only when it points at this copy.
# The app it guards is the folder's name: the link runs it with no environment.
#
# Usage: sh guard.sh [check]

SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
DIR="${DIR:-$(cd "$(dirname "$SELF")" && pwd)}"
LINK="${LINK:-/var/lib/webosbrew/init.d/46-webocu-homeapp}"
LAUNCHER_ID="${LAUNCHER_ID:-$(basename "$DIR")}"
case "$LAUNCHER_ID" in ""|webocu|homeapp|*[!A-Za-z0-9._-]*) LAUNCHER_ID=webocu.dock ;; esac
LAUNCHER="${LAUNCHER:-/media/developer/apps/usr/palm/applications/$LAUNCHER_ID}"
LUNA="${LUNA_SEND:-luna-send}"
NAP="${NAP:-sleep}"
TRIES="${TRIES:-24}"
LOG="${LOG:-/tmp/webocu-homeapp.log}"
SETTINGS=luna://com.webos.settingsservice

log () { echo "$(date '+%H:%M:%S') homeapp: $*" >> "$LOG"; }

check () {
    [ -f "$LAUNCHER/appinfo.json" ] && { echo installed; return 0; }
    n=0
    while :; do
        reply=$("$LUNA" -n 1 "$SETTINGS/getSystemSettings" '{"category":"general","keys":["defaultApps"]}' 2>/dev/null | tr -d '\n ')
        case "$reply" in *'"returnValue":true'*) break ;; esac
        n=$((n + 1))
        [ "$n" -ge "$TRIES" ] && { log "the settings service did not answer: trying again at the next start"; echo waiting; return 1; }
        $NAP 5
    done
    case "$reply" in
        *"\"home\":\"$LAUNCHER_ID\""*)
            previous=$(cat "$DIR/previous" 2>/dev/null)
            case "$previous" in ""|"$LAUNCHER_ID"|*[!A-Za-z0-9._-]*) previous=com.webos.app.home ;; esac
            "$LUNA" -n 1 "$SETTINGS/setSystemSettings" "{\"category\":\"general\",\"settings\":{\"defaultApps\":{\"home\":\"$previous\"}}}" >/dev/null 2>&1
            log "the dock is not installed: the HOME button opens $previous again"
            echo "restored $previous"
            ;;
        *) echo "left alone" ;;
    esac
    if [ -L "$LINK" ] && [ "$(readlink -f "$LINK" 2>/dev/null)" = "$(readlink -f "$DIR/guard.sh" 2>/dev/null)" ]; then
        rm -f "$LINK"
    fi
    rm -f "$DIR/guard.sh" "$DIR/guard.sh.new" "$DIR/previous"
    rmdir "$DIR" 2>/dev/null
    [ "$(basename "$(dirname "$DIR")")" = webocu ] && rmdir "$(dirname "$DIR")" 2>/dev/null
    return 0
}

case "${1:-boot}" in
    check) check ;;
    boot) ( check >/dev/null 2>&1 & ) ;;
    *) echo "usage: guard.sh [check]"; exit 1 ;;
esac
