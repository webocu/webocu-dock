#!/bin/sh
# Put the .ipk on the TV. Two routes, picked from the registered device itself:
#
#   Developer Mode  -> ares-install, the way the webOS CLI is meant to be used.
#   rooted (webosbrew, a password in the profile) -> ssh, one command per
#     connection.
#
# The second route exists because ares-install does not work against the sshd a
# rooted TV runs. That sshd is the dropbear the Homebrew Channel ships, and it
# refuses the exec channel ares-install opens right after the sftp upload
# ("ares-install ERR! Error: Unable to exec", reproducible on every attempt):
# the CLI keeps one connection and asks for several channels on it. So the ssh
# route makes a fresh connection per step instead — upload, install, clean up —
# and none of them needs a second channel.
#
# Run: make install (or make deploy)
set -e

IPK=$1
[ -n "$IPK" ] || { echo "Usage: sh tools/install.sh <ipk>"; exit 1; }
[ -f "$IPK" ] || { echo "No such package: $IPK"; exit 1; }

APP_ID=${APP_ID:-webocu.dock}

# If DEVICE not provided, read the default device from the profile. Devices are
# stored in /root/.webos/<profile>/novacom-devices.json where profile is typically
# 'tv' or 'ose'. All devices (emulator, registered TVs) live in the same file.
DEVICES_DIR=/root/.webos
if [ -z "$DEVICE" ]; then
  for file in "$DEVICES_DIR"/*/novacom-devices.json; do
    [ -f "$file" ] || continue
    DEVICE=$(node -e '
      var fs = require("fs"), file = process.argv[1];
      if (!fs.existsSync(file)) process.exit(0);
      var list = JSON.parse(fs.readFileSync(file, "utf8"));
      var def = list.filter(function (d) { return d.default === "true" || d.default === true; })[0];
      if (def) console.log(def.name);
    ' "$file" 2>/dev/null || true)
    [ -n "$DEVICE" ] && break
  done
  DEVICE=${DEVICE:-emulator}
fi

# Now find which profile file contains this device and extract its password if any.
# Nothing is printed for a device without a password: that is the Developer Mode
# case and the empty output is what selects the ares-install route.
PROFILE=
for file in "$DEVICES_DIR"/*/novacom-devices.json; do
  [ -f "$file" ] || continue
  PROFILE=$(node -e '
    var fs = require("fs"), file = process.argv[1], name = process.argv[2];
    if (!fs.existsSync(file)) process.exit(0);
    var list = JSON.parse(fs.readFileSync(file, "utf8"));
    var dev = list.filter(function (d) { return d.name === name; })[0];
    if (!dev || !dev.password) process.exit(0);
    console.log([dev.host, dev.port || 22, dev.username || "root", dev.password].join(" "));
  ' "$file" "$DEVICE" 2>/dev/null || true)
  [ -n "$PROFILE" ] && break
done

if [ -z "$PROFILE" ]; then
  echo "== $DEVICE: Developer Mode profile, installing with ares-install =="
  exec ares-install --device "$DEVICE" "$IPK"
fi

# shellcheck disable=SC2086
set -- $PROFILE
HOST=$1
PORT=$2
USER=$3
PASS=$4

echo "== $DEVICE: rooted profile ($USER@$HOST:$PORT), installing over ssh =="

# The password comes from the profile, so no key and no agent: sshpass feeds it
# through the environment, which keeps it off the command line. The TV's host key
# changes with every reflash and there is nothing to gain by remembering it.
export SSHPASS=$PASS
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
TV_TMP=/media/developer/temp
REMOTE=$TV_TMP/$(basename "$IPK")

# Two ways in, and the difference matters. `tv` is a plain session: it is what the
# upload goes through, because a terminal would translate the newlines in the
# package. `tvt` asks for one (-tt), because luna-send on this firmware writes
# nothing at all into a pipe -- the call comes back with status 0 and no reply,
# and an install done that way silently leaves the old version in place. The
# terminal costs a carriage return at the end of every line, which is what the
# tr below takes off again.
tv() {
  # shellcheck disable=SC2086
  sshpass -e ssh $SSH_OPTS -p "$PORT" "$USER@$HOST" "$@"
}

tvt() {
  # shellcheck disable=SC2086
  sshpass -e ssh -tt $SSH_OPTS -p "$PORT" "$USER@$HOST" "$@" | tr -d '\r'
}

tv "mkdir -p $TV_TMP && chmod 777 $TV_TMP"

# Piped through the shell rather than scp'd: sftp is the half of ares-install
# this route exists to avoid, and a plain redirect needs nothing but the session
# that is already open.
echo "  upload $(basename "$IPK") -> $REMOTE"
tv "cat > $REMOTE" < "$IPK"

# dev/install is the endpoint the Developer Mode installer uses as well; on a
# rooted TV it is simply reachable from a root shell. The reply says the install
# was accepted and nothing about how it ended, so the check below is the installed
# manifest itself.
echo "  install"
tvt "luna-send -n 1 -f luna://com.webos.appInstallService/dev/install \
    '{\"id\":\"testApp\",\"ipkUrl\":\"$REMOTE\",\"subscribe\":false}'" >/dev/null

WANT=$(tr -d ' \t\r\n' < source/version.txt)
APP_DIR=/media/developer/apps/usr/palm/applications/$APP_ID
i=0
while [ "$i" -lt 30 ]; do
  GOT=$(tvt "sed -n 's/.*\"version\" *: *\"\\([^\"]*\\)\".*/\\1/p' $APP_DIR/appinfo.json 2>/dev/null" || true)
  GOT=$(echo "$GOT" | tr -d ' \t\r\n')
  if [ "$GOT" = "$WANT" ]; then
    tv "rm -f $REMOTE" || true
    echo "  $APP_ID $WANT is on the TV"
    echo "Success"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "The install did not finish: $APP_DIR/appinfo.json reports '$GOT', not $WANT" >&2
exit 1
