#!/bin/sh
# Runtime appinfo.json modifier for lockable and defaultWindowType fields.
# This allows testing different window behaviors without redeployment.
#
# Usage: sh patch_appinfo.sh <app-id> [windowType=popup|overlay|card|minimal|system_ui]

set -e

# Arguments
APP_ID="$1"
WINDOW_TYPE_ARG="$2"

# Validate app ID
if [ -z "$APP_ID" ]; then
    echo "Error: app-id is required" >&2
    exit 1
fi

# Construct appinfo.json path
APPINFO="/media/developer/apps/usr/palm/applications/$APP_ID/appinfo.json"

if [ ! -f "$APPINFO" ]; then
    echo "Error: appinfo.json not found at $APPINFO" >&2
    exit 1
fi

# Track if any changes were made
CHANGED=0

# Process windowType argument
if [ -n "$WINDOW_TYPE_ARG" ]; then
    # Extract window type value (handle windowType=value format)
    WINDOW_TYPE=$(echo "$WINDOW_TYPE_ARG" | sed 's/^windowType=//')

    case "$WINDOW_TYPE" in
        popup|overlay|card|minimal|home|system_ui)
            # Get current value
            CURRENT_TYPE=$(sed -n 's/.*"defaultWindowType"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APPINFO")
            if [ "$CURRENT_TYPE" != "$WINDOW_TYPE" ]; then
                sed -i 's/\("defaultWindowType"[[:space:]]*:[[:space:]]*"\)[^"]*\("\)/\1'"$WINDOW_TYPE"'\2/' "$APPINFO"
                echo "defaultWindowType: $CURRENT_TYPE -> $WINDOW_TYPE"
                CHANGED=1
            else
                echo "defaultWindowType: already $WINDOW_TYPE"
            fi
            ;;
        "")
            # Empty - skip windowType
            ;;
        *)
            echo "Error: defaultWindowType must be popup|overlay|card|minimal|home|system_ui, got: $WINDOW_TYPE" >&2
            exit 1
            ;;
    esac
fi

if [ "$CHANGED" -eq 0 ]; then
    echo "No changes made"
fi

echo "SUCCESS"
exit 0
