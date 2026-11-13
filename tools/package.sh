#!/bin/sh
# Build the .ipk from a clean stage under build/: only what belongs to the app
# and to the helper service is copied out of source/.
#
# Run: make package
set -e

SRC=source
STAGE=build/webocu.dock
OUT=dist
APP_ID=webocu.dock
SERVICE_SRC=$SRC/service
SERVICE_STAGE=build/services/$APP_ID.service

# Version bumping is now explicit (via make version-bump or make deploy).
# Package target is idempotent by default: use PART=patch to bump during packaging.
sh tools/version.sh "${PART:-keep}"

rm -rf "$STAGE" build/services
mkdir -p "$STAGE" "$OUT" "$SERVICE_STAGE"

# Copy everything from source/ except service/ (service is packaged separately).
cp -R "$SRC"/* "$STAGE/"
rm -rf "$STAGE/service"

# Remove build inputs: version marker and documentation.
rm -f "$STAGE/version.txt"
find "$STAGE" -name '*.md' -delete

echo "  + source/* (excluding service/)"

# Copy and rename service to the correct ID
if [ -d "$SERVICE_SRC" ]; then
  cp -R "$SERVICE_SRC"/* "$SERVICE_STAGE/"
  echo "  + service/ → services/$APP_ID.service/ (service)"
fi

# shellcheck disable=SC2086
ares-package -o "$OUT" "$STAGE" "$SERVICE_STAGE"

ls -la "$OUT"
