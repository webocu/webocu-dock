#!/bin/sh
# WebOCU Dock key engine: starts the key hook that lets the remote's HOME button open the dock.
# Written to the TV by the helper service (never copied by hand); runs as root through the Homebrew Channel.
#
# Adapted from Hearth (MIT, https://github.com/rudra-avatar/Hearth); the dock credits it in About. It injects the
# bundled library libinputhookpp.so (Input Hook's, GPL-3.0) into the TV's input processes with the bundled injector
# `ezinject`, exactly as the Input Hook app does: same processes, same logs /tmp/lginput-hook-*.log, the same marker
# /tmp/inputhook, the same settings file /home/root/.config/lginputhook/keybinds.json. Because the marker is shared,
# this does nothing when the Input Hook app has already started the hook this boot, and the two never inject twice.
# The injection lives in memory only; a restart removes it. The "boot" link starts it again at every start while the
# HOME button is mapped. Nothing on the TV's flash changes except the settings file and the link.
#
# Failsafe: if the dock is no longer installed, the start-up link (which outlives an uninstall) cleans up instead of
# starting the hook: the dock's own button entry is taken out of the settings file, its link and files are removed, and
# when the Input Hook app is not installed either, what is left of it is removed too. A separately installed Input Hook
# app and the buttons set in it are never touched. The dock writes/removes the button entry itself; this script only
# injects, cleans up and (dis)connects the boot link.
#
# Each app ID has its own copy of this engine, in its own data folder (shared with its other files on the TV, such as
# the keepalive daemon): /media/developer/apps/var/lib/webocu/<app-id>/homehook.sh. There is one link and one button
# entry per TV, though -- the key can open one app only: /var/lib/webosbrew/init.d/00_webocu_dock_homekey, not moved
# by Switch app ID. Where that link points is who owns the key: `enable` points it at this copy, and the boot link
# therefore runs the owner's copy, which serves that app -- its files, its "is it installed" check, its button entry.
# The owner is read from the copy's folder name, so no other record is kept. `disable` and `cleanup` take the link
# away only when it points at this copy; another app's link is left alone.
#
# Usage: sh homehook.sh status | start | boot | bootjob | cleanup | enable | disable
#   LAUNCHER_ID is read from the environment (the service passes the current app id); without it the owner, the
#   folder this copy lives in, is used, and webocu.dock when that is no app id.

# The real file, through the boot link too: its folder is the owner's data folder.
SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
ENGINE_DIR="${ENGINE_DIR:-$(cd "$(dirname "$SELF")" && pwd)}"
SELF="$ENGINE_DIR/homehook.sh"
OWNER="$(basename "$ENGINE_DIR")"
# Run straight from the package (<app>/homehook/homehook.sh) the folder above is the app.
[ "$OWNER" = homehook ] && OWNER="$(basename "$(dirname "$ENGINE_DIR")")"
case "$OWNER" in ""|webocu|*[!A-Za-z0-9._-]*) OWNER=webocu.dock ;; esac
LAUNCHER_ID="${LAUNCHER_ID:-$OWNER}"
APPS="${APPS:-/media/developer/apps/usr/palm/applications}"
LAUNCHER="${LAUNCHER:-$APPS/$LAUNCHER_ID}"
DIR="$LAUNCHER/homehook"
MARK="${MARK:-/tmp/inputhook}"
LINK="${LINK:-/var/lib/webosbrew/init.d/00_webocu_dock_homekey}"
TARGETS="RELEASE lginput2 micomservice tvservice testapp"
HOOK_APP="${HOOK_APP:-$APPS/org.webosbrew.inputhook}"
KEYS="${KEYS:-/home/root/.config/lginputhook/keybinds.json}"
HOOK_LINK="${HOOK_LINK:-/var/lib/webosbrew/init.d/inputhook}"
LOGF="${LOGF:-/tmp/webocu-homehook.log}"

have_files () { [ -f "$DIR/ezinject" ] && [ -f "$DIR/libinputhookpp.so" ]; }

# Does the boot link point at this copy? Both sides resolved, so a path written through a symlinked mount still matches.
link_ours () { [ -L "$LINK" ] && [ "$(readlink -f "$LINK" 2>/dev/null)" = "$(readlink -f "$SELF" 2>/dev/null)" ]; }
ready_count () { n=0; for f in /tmp/lginput-hook-*.log; do [ -f "$f" ] && grep -q 'InputHook initialized' "$f" 2>/dev/null && n=$((n+1)); done; echo $n; }

find_pids () {   # prints "comm pid" for each running target
    grep -sE "^($(echo $TARGETS | tr ' ' '|'))\$" /proc/[0-9]*/comm 2>/dev/null | sed -n 's#^/proc/\([0-9]*\)/comm:\(.*\)$#\2 \1#p'
}

do_status () {
    [ -f "$MARK" ] && echo injected=1 || echo injected=0
    have_files && echo files=1 || echo files=0
    echo ready=$(ready_count)
    # link=1 only when the key is this app's; linkowner names the app it is pointed at (another one, or none).
    link_ours && echo link=1 || echo link=0
    echo "linkowner=$([ -L "$LINK" ] && basename "$(dirname "$(readlink "$LINK")")")"
    [ -d "$HOOK_APP" ] && echo hookapp=1 || echo hookapp=0
}

do_start () {
    if [ -f "$MARK" ]; then
        if [ "$(ready_count)" -gt 0 ]; then echo result=already; return 0; fi
        rm -f "$MARK"
    fi
    if ! have_files; then echo result=nofiles; return 0; fi
    mkdir -p "$(dirname "$KEYS")" 2>/dev/null
    [ -f "$KEYS" ] || echo '{}' > "$KEYS"
    chmod 755 "$DIR/ezinject" "$DIR/libinputhookpp.so" 2>/dev/null
    pids="$(find_pids)"
    if [ -z "$pids" ]; then echo result=notarget; return 0; fi
    echo "$pids" | while read -r name pid; do
        : > "/tmp/lginput-hook-$name.log"
        "$DIR/ezinject" -l "/tmp/lginput-hook-$name.log" "$pid" "$DIR/libinputhookpp.so" > "/tmp/ezinject-$name.log" 2>&1 < /dev/null &
    done
    sleep 4
    c="$(ready_count)"
    if [ "$c" -gt 0 ]; then : > "$MARK"; echo "ready=$c"; echo result=started; else echo result=failed; fi
}

log () { echo "$(date +%H:%M:%S) up=$(cut -d. -f1 /proc/uptime 2>/dev/null)s $*" >> "$LOGF" 2>/dev/null; }

# The dock is gone only when the apps folder is there and our appinfo.json is not (checked twice).
launcher_gone () {
    [ -d "$APPS" ] || return 1
    [ -f "$LAUNCHER/appinfo.json" ] && return 1
    sleep "${GONE_WAIT:-15}"
    [ -d "$APPS" ] && [ ! -f "$LAUNCHER/appinfo.json" ]
}

drop_entries () {   # takes every "launch the dock" entry out of the settings file
    [ -f "$KEYS" ] || return 0
    if command -v node >/dev/null 2>&1; then
        node -e 'var fs=require("fs"),f=process.argv[1],o;try{o=JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){process.exit(3)}Object.keys(o).forEach(function(k){var b=o[k];if(b&&b.action==="launch"&&b.id==="'"$LAUNCHER_ID"'")delete o[k]});fs.writeFileSync(f,JSON.stringify(o))' "$KEYS" 2>/dev/null && return 0
    fi
    sed -i -e 's/"[0-9]*":{"action":"launch","id":"'"$LAUNCHER_ID"'"},\{0,1\}//g' -e 's/,}/}/g' "$KEYS" 2>/dev/null
}

cleanup () {
    log "the dock is not installed: cleaning up"
    drop_entries
    if [ ! -d "$HOOK_APP" ]; then
        rm -f "$KEYS" "$HOOK_LINK"
        log "Input Hook is not installed either: its settings file and start-up script were removed"
    fi
    # The link only if it is ours; of the data folder only this engine: the folder may still hold the app's other
    # files, and goes (with the parent) only once it is empty.
    link_ours && rm -f "$LINK"
    rm -f "$ENGINE_DIR/homehook.sh" "$ENGINE_DIR/homehook.sh.new"
    rmdir "$ENGINE_DIR" 2>/dev/null
    [ "$(basename "$(dirname "$ENGINE_DIR")")" = webocu ] && rmdir "$(dirname "$ENGINE_DIR")" 2>/dev/null
    return 0
}

inject_one () {   # name pid
    : > "/tmp/lginput-hook-$1.log"
    "$DIR/ezinject" -l "/tmp/lginput-hook-$1.log" "$2" "$DIR/libinputhookpp.so" > "/tmp/ezinject-$1.log" 2>&1 < /dev/null &
}

JOBPID="${JOBPID:-/tmp/webocu-hook-job.pid}"

boot_job () {
    other="$(cat "$JOBPID" 2>/dev/null)"
    if [ -n "$other" ] && [ "$other" != "$$" ] && kill -0 "$other" 2>/dev/null; then log "boot: a job is already running ($other)"; return 0; fi
    echo $$ > "$JOBPID"
    log "boot: key engine start-up began"
    if launcher_gone; then cleanup; return 0; fi
    if [ -f "$MARK" ] && [ "$(ready_count)" -gt 0 ]; then log "boot: a hook is already running"; return 0; fi
    if ! have_files; then log "boot: files missing in $DIR"; return 0; fi
    mkdir -p "$(dirname "$KEYS")" 2>/dev/null
    [ -f "$KEYS" ] || echo '{}' > "$KEYS"
    chmod 755 "$DIR/ezinject" "$DIR/libinputhookpp.so" 2>/dev/null
    if sleep 0.01 2>/dev/null; then fast=0.25; else fast=1; fi
    log "boot: poll step ${fast}s"
    rounds=0
    while [ $rounds -lt 150 ]; do
        find_pids > /tmp/webocu-hook-pids
        now="$(date +%s)"
        while read -r name pid; do
            [ -n "$pid" ] || continue
            f="/tmp/webocu-hooked-$name-$pid"
            if [ -f "$f" ]; then
                if [ ! -f "$f.retry" ] && [ $((now - $(cat "$f" 2>/dev/null || echo "$now"))) -gt 10 ] && ! grep -q 'InputHook initialized' "/tmp/lginput-hook-$name.log" 2>/dev/null; then
                    : > "$f.retry"; inject_one "$name" "$pid"; log "boot: $name did not start, trying again"
                fi
                continue
            fi
            log "boot: saw $name ($pid)"
            inject_one "$name" "$pid"
            echo "$now" > "$f"
            log "boot: injecting into $name ($pid)"
        done < /tmp/webocu-hook-pids
        if [ ! -f "$MARK" ] && [ "$(ready_count)" -gt 0 ]; then : > "$MARK"; log "boot: hook ready ($(ready_count) process(es))"; fi
        rounds=$((rounds+1))
        if [ $rounds -lt 40 ]; then sleep "$fast"; elif [ $rounds -lt 90 ]; then sleep 1; else sleep 4; fi
    done
    log "boot: finished watching; ready=$(ready_count)"
}

do_boot () { ( nohup sh "$0" bootjob >/dev/null 2>&1 </dev/null & ); }

case "${1:-boot}" in
    status) do_status ;;
    start) do_start ;;
    boot) do_boot ;;
    bootjob) boot_job ;;
    cleanup) if launcher_gone; then cleanup; echo result=cleaned; else echo result=kept; fi ;;
    # Pointing the link at this copy is what makes this app the owner.
    enable) mkdir -p "$(dirname "$LINK")" && ln -sf "$SELF" "$LINK" && echo result=enabled || echo result=failed ;;
    disable)
        # Only the app the hook belongs to may take it away: the link is shared, and the owner's entry stays mapped.
        if [ -L "$LINK" ] && ! link_ours; then echo result=kept
        else rm -f "$LINK"; echo result=disabled; fi ;;
    *) echo "usage: sh homehook.sh status|start|boot|enable|disable"; exit 2 ;;
esac
