#!/bin/sh

set -e

CURRENT_ID="$1"
NEW_ID="$2"
OUTPUT_IPK="$3" # "/tmp/${NEW_ID}.ipk"

if [ "$#" -ne 3 ] || [ -z "$1" ] || [ -z "$2" ] || [ -z "$3" ]; then
    echo "Usage: $0 <current-app-id> <new-app-id> <output-ipk>" >&2
    exit 1
fi

SRC_BASE="/media/developer/apps/usr/palm"
SRC_APP="$SRC_BASE/applications/$CURRENT_ID"
SRC_PKG="$SRC_BASE/packages/$CURRENT_ID"
SRC_SVC="$SRC_BASE/services/$CURRENT_ID.service"

WORK="/tmp/zygote-$$"
ROOT="$WORK/root"
CONTROL="$WORK/control"

cleanup()
{
  # find "$WORK" -type f -exec wc -c {} \;
  rm -rf "$WORK"
}

trap cleanup EXIT INT TERM
rm -f "$OUTPUT_IPK"
mkdir -p "$ROOT/usr/palm/applications/$NEW_ID" "$CONTROL"

echo "Zygote: $CURRENT_ID -> $NEW_ID"
echo "Work:   $WORK"
echo "Output: $OUTPUT_IPK"

echo "[1/8] Copying application..."
# cp -R "$SRC_APP"/. "$ROOT/usr/palm/applications/$NEW_ID/"
tar -cf - -C "$SRC_APP" . | tar -xf - -C "$ROOT/usr/palm/applications/$NEW_ID"

echo "[2/8] Copying package..."
mkdir -p "$ROOT/usr/palm/packages/$NEW_ID"
# cp -R "$SRC_PKG"/. "$ROOT/usr/palm/packages/$NEW_ID/"
tar -cf - -C "$SRC_PKG" . | tar -xf - -C "$ROOT/usr/palm/packages/$NEW_ID"

echo "[3/8] Copying service..."
mkdir -p "$ROOT/usr/palm/services/$NEW_ID.service"
# cp -R "$SRC_SVC"/. "$ROOT/usr/palm/services/$NEW_ID.service/"
tar -cf - -C "$SRC_SVC" . | tar -xf - -C "$ROOT/usr/palm/services/$NEW_ID.service"

echo "[4/8] Updating metadata..."
APPINFO="$ROOT/usr/palm/applications/$NEW_ID/appinfo.json"
PKGINFO="$ROOT/usr/palm/packages/$NEW_ID/packageinfo.json"
SERVICE_PACKAGE="$ROOT/usr/palm/services/$NEW_ID.service/package.json"
SERVICES_JSON="$ROOT/usr/palm/services/$NEW_ID.service/services.json"
SERVICE_JS="$ROOT/usr/palm/services/$NEW_ID.service/service.js"
sed -i "s/\"id\"[[:space:]]*:[[:space:]]*\"$CURRENT_ID\"/\"id\": \"$NEW_ID\"/" "$APPINFO"
sed -i "s/\"id\"[[:space:]]*:[[:space:]]*\"$CURRENT_ID\"/\"id\": \"$NEW_ID\"/g" "$PKGINFO"
sed -i "s/\"app\"[[:space:]]*:[[:space:]]*\"$CURRENT_ID\"/\"app\": \"$NEW_ID\"/g" "$PKGINFO"
sed -i "s/\"$CURRENT_ID\.service\"/\"$NEW_ID.service\"/g" "$PKGINFO"
sed -i "s/\"name\"[[:space:]]*:[[:space:]]*\"$CURRENT_ID\.service\"/\"name\": \"$NEW_ID.service\"/g" "$SERVICE_PACKAGE"
sed -i "s/\"id\"[[:space:]]*:[[:space:]]*\"$CURRENT_ID\.service\"/\"id\": \"$NEW_ID.service\"/g" "$SERVICES_JSON"
sed -i "s/\"name\"[[:space:]]*:[[:space:]]*\"$CURRENT_ID\.service\"/\"name\": \"$NEW_ID.service\"/g" "$SERVICES_JSON"
sed -i "s/\(SERVICE_ID[[:space:]]*=[[:space:]]*\)[\"']$CURRENT_ID\.service[\"']/\1\"$NEW_ID.service\"/" "$SERVICE_JS"
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APPINFO" | head -n 1)
[ -n "$VERSION" ] || ( VERSION="1.0.0" && echo "Version: $VERSION" )

echo "[5/8] Creating control archive..."
printf '2.0\n' > "$WORK/debian-binary"
INSTALLED_SIZE=$(find "$ROOT/usr" -type f -exec wc -c {} \; | awk '{s+=$1} END {print s}')
cat > "$CONTROL/control" <<EOF
Package: $NEW_ID
Version: $VERSION
Section: misc
Priority: optional
Architecture: all
Installed-Size: $INSTALLED_SIZE
Maintainer: WebOCU Dock
Description: WebOCU Dock cloned as $NEW_ID
webOS-Package-Format-Version: 2
webOS-Packager-Version: x.y.x
EOF
tar -czpf "$WORK/control.tar.gz" -C "$CONTROL" control

echo "[6/8] Creating data archive..."
tar -czpf "$WORK/data.tar.gz" -C "$ROOT" usr

echo "[7/8] Creating IPK..."
append_ar_member()
{
  member_path="$1"
  member_name="${member_path##*/}"
  member_size=$(wc -c < "$member_path" | tr -d '[:space:]')

  printf '%-16s%-12s%-6s%-6s%-8s%-10s`\n' \
    "$member_name/" "$(date +%s)" 0 0 100644 "$member_size" \
    >> "$OUTPUT_IPK"

  cat "$member_path" >> "$OUTPUT_IPK"

  if [ $((member_size % 2)) -ne 0 ]; then
    printf '\n' >> "$OUTPUT_IPK"
  fi
}
printf '!<arch>\n' > "$OUTPUT_IPK"
append_ar_member "$WORK/debian-binary"
append_ar_member "$WORK/control.tar.gz"
append_ar_member "$WORK/data.tar.gz"
SIZE=$(ls -lh "$OUTPUT_IPK" | awk '{print $5}')
echo "IPK size: $SIZE"

echo "[8/8] Installing application..."
luna-send -n 1 -f luna://com.webos.appInstallService/dev/install \
  "{\"id\":\"$NEW_ID\",\"ipkUrl\":\"$OUTPUT_IPK\",\"subscribe\":true}"
sleep 10
luna-send -n 1 -f luna://com.webos.service.applicationmanager/listApps '{}' 2>&1 \
  | grep \"id\" | grep \"$NEW_ID\" || exit 1 && echo "SUCCESS"
