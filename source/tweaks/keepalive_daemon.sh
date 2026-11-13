#!/bin/sh
# Keepalive daemon for WebOCU Dock (and any app ID it was cloned to)
# Prevents the app from being closed by the system due to inactivity.
# This script runs in background and calls /keepalive endpoint every 30 seconds.
# It also opens the app once when it starts (see below), which is the app's autostart.
#
# Written to the TV by the helper service, which keeps a copy of this file outside
# the app's folder, in the app's own data folder (shared with the app's other files
# kept on the TV: the home-key engine, the home-setting guard):
#   /media/developer/apps/var/lib/webocu/<app-id>/keepalive_daemon.sh
# and links it into the Homebrew Channel's init.d. The copy is what lets the daemon
# outlive an uninstall of the app and tidy up after it: the link and this file are
# removed as soon as the app is found to be gone (see launcher_gone below).
# Environment (all optional; the overrides exist for tests):
#   KEEPALIVE_NO_LAUNCH=1  do not open the app (the service sets it when it starts
#                          the daemon itself, so only a real TV start opens it)
#   GONE_WAIT=<seconds>    pause before the "app is gone" verdict is confirmed
#   KEEPALIVE_PERIOD=<s>   seconds between two keepalive calls (30)

set -e

APPS="${APPS:-/media/developer/apps/usr/palm/applications}"
INIT_D_DIR="${INIT_D_DIR:-/var/lib/webosbrew/init.d}"
DATA_DIR="${DATA_DIR:-/media/developer/apps/var/lib/webocu}"

# Determine the app ID from where the script really lives:
#   /media/developer/apps/var/lib/webocu/<app-id>/keepalive_daemon.sh   (the copy)
#   /media/developer/apps/usr/palm/applications/<app-id>/tweaks/keepalive_daemon.sh
# At boot it is started through the init.d symlink, so the link is resolved
# first -- otherwise the directory names are those of init.d, not of the script.
# An explicit first argument wins over both.
SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || echo "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
case "$(basename "$SCRIPT_DIR")" in
    tweaks) DETECTED_ID="$(basename "$(dirname "$SCRIPT_DIR")")" ;;
    *)      DETECTED_ID="$(basename "$SCRIPT_DIR")" ;;
esac
APP_ID="${1:-$DETECTED_ID}"

# Fallback to default if detection fails
case "$APP_ID" in
    ""|.|/|applications|tweaks|webocu)
        APP_ID="webocu.dock"
        ;;
esac

# The link carries the app ID with every character but [A-Za-z0-9_] replaced by
# '_' -- the hyphen too -- the same name the service writes (initDLink in
# service.js); the two must not drift apart. Earlier rules kept the dots, or the
# hyphen: those names are removed together with this one.
LINK_NAME="00_$(printf '%s' "$APP_ID" | tr -c 'A-Za-z0-9_' '_')_keepalive"
LINK_DASH="00_$(printf '%s' "$APP_ID" | tr -c 'A-Za-z0-9_-' '_')_keepalive"

# The app is gone only when the apps folder is there and the app's appinfo.json is
# not, confirmed twice: an update replaces the folder for a moment, and a TV that
# has not mounted its storage yet shows no apps folder at all, which is no verdict.
launcher_gone () {
    [ -d "$APPS" ] || return 1
    [ -f "$APPS/$APP_ID/appinfo.json" ] && return 1
    sleep "${GONE_WAIT:-15}"
    [ -d "$APPS" ] && [ ! -f "$APPS/$APP_ID/appinfo.json" ]
}

# What an uninstall leaves behind: the init.d link (which would otherwise dangle
# for good) and this copy. Only this file: the folder is the app's and may still
# hold its other parts; it goes, and the parent too, once nothing is left in it.
cleanup () {
    echo "[keepalive-daemon] $APP_ID is not installed: removing the link and the copy"
    rm -f "$INIT_D_DIR/$LINK_NAME" "$INIT_D_DIR/$LINK_DASH" "$INIT_D_DIR/00_${APP_ID}_keepalive"
    rm -f "$DATA_DIR/$APP_ID/keepalive_daemon.sh" "$DATA_DIR/$APP_ID/keepalive_daemon.sh.new"
    rmdir "$DATA_DIR/$APP_ID" 2>/dev/null || true
    rmdir "$DATA_DIR" 2>/dev/null || true
    exit 0
}

# Homebrew Channel starts init.d with a plain run-parts, which waits for every
# script before the next one -- an endless loop here would hold up all the
# scripts after it. So the first run only starts a detached copy of the real
# file and returns. That copy runs as `sh <path>/keepalive_daemon.sh <app-id>`,
# the command line the service matches with pkill/pgrep -f; one already running
# for this ID is left alone instead of being doubled.
if [ -z "$KEEPALIVE_DETACHED" ]; then
    # Own PID excluded: started by hand as `sh keepalive_daemon.sh <id>`,
    # this very shell would match the pattern.
    if pgrep -f "keepalive_daemon.sh ${APP_ID}\$" 2>/dev/null | grep -qvx "$$"; then
        echo "[keepalive-daemon] Already running for $APP_ID"
        exit 0
    fi
    KEEPALIVE_DETACHED=1 nohup sh "$SCRIPT_PATH" "$APP_ID" > /dev/null 2>&1 &
    exit 0
fi

SERVICE_URI="luna://${APP_ID}.service/keepalive"

echo "[keepalive-daemon] Starting for $SERVICE_URI"
echo "[keepalive-daemon] PID: $$"

# A start after an uninstall (the link outlives the app) ends here, before the
# app is opened or anything else is done.
if launcher_gone; then cleanup; fi

# Open the dock once per daemon start, i.e. after the TV boots (and when the init
# script is installed by hand). Runs in the background so the first keepalive is
# not held up. The app list is not read here at all: the dock keeps its own
# cache of it. The launch reply is the readiness check -- the application manager
# may still be starting this early, so a failed call is retried for about a
# minute. `params.boot` lets the app tell this start from one made by the user
# from the launcher (Settings -> General -> Open at start only governs the former).
# Not done when the service started this daemon itself (the app is running then).
if [ -z "$KEEPALIVE_NO_LAUNCH" ]; then
    (
        tries=0
        while [ "$tries" -lt 10 ]; do
            if luna-send -n 1 -f "luna://com.webos.service.applicationmanager/launch" \
                "{\"id\":\"${APP_ID}\",\"params\":{\"boot\":true}}" 2>/dev/null \
                | grep -q '"returnValue": *true'; then
                break
            fi
            tries=$((tries + 1))
            sleep 5
        done
    ) > /dev/null 2>&1 &
fi

# Infinite loop - calls keepalive every 30 seconds
while true; do
    # luna-send -n 1 = one-shot call, -f = print formatted JSON
    luna-send -n 1 -f "$SERVICE_URI" '{}' > /dev/null 2>&1 || true

    # Sleep for 30 seconds between calls
    sleep "${KEEPALIVE_PERIOD:-30}"

    # An uninstall while the daemon runs: the check is one file test, the slow
    # confirmation happens only when that file is missing.
    if [ ! -f "$APPS/$APP_ID/appinfo.json" ] && launcher_gone; then cleanup; fi
done
