#!/bin/sh
# The version lives in source/version.txt and nowhere else: appinfo.json is a
# mirror of it. Bumping is explicit (make bump, make version-bump PART=...,
# make build PART=...): a plain build keeps the number, so rebuilding the same
# tree gives the same ipk. Bump when a new ipk must not be confused with the one
# already installed on the TV.
#
# Run: sh tools/version.sh [patch|minor|major|keep]   (make version-bump)
set -e

SRC=${SRC:-source}
FILE=$SRC/version.txt
INFO=$SRC/appinfo.json
PART=${1:-${PART:-patch}}

[ -f "$FILE" ] || printf '0.0.0\n' > "$FILE"
CUR=$(tr -d ' \t\r\n' < "$FILE")

case "$CUR" in
  *.*.*) ;;
  *) echo "version.txt must contain x.y.z, got: '$CUR'" >&2; exit 1 ;;
esac

MAJOR=${CUR%%.*}
REST=${CUR#*.}
MINOR=${REST%%.*}
PATCH=${REST#*.}

case "$PART" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  keep)  ;;
  *) echo "unknown part: $PART (patch|minor|major|keep)" >&2; exit 1 ;;
esac

NEW="$MAJOR.$MINOR.$PATCH"
printf '%s\n' "$NEW" > "$FILE"

# ares-package reads the version from the manifest, so keep both in step.
sed -i 's/\("version"[[:space:]]*:[[:space:]]*"\)[^"]*\("\)/\1'"$NEW"'\2/' "$INFO"

# The helper service travels inside the same package, so it carries the version too.
if [ -f "$SRC/service/package.json" ]; then
  sed -i 's/\("version"[[:space:]]*:[[:space:]]*"\)[^"]*\("\)/\1'"$NEW"'\2/' "$SRC/service/package.json"
fi

echo "  version $CUR -> $NEW"
