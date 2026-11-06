#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/environment.sh"
CONFIGURATION="${1:-Release}"
SIMULATOR_ID="${NH_SIMULATOR_ID:?Set a dedicated simulator UUID explicitly}"
case "$CONFIGURATION" in Debug|Release) ;; *) echo 'Expected Debug or Release' >&2; exit 1 ;; esac
DERIVED_DATA="${NH_REFERENCE_DERIVED_DATA:-$NH_EXPERIMENT/build/performance/rn-tester-$CONFIGURATION}"
APP="$DERIVED_DATA/Build/Products/$CONFIGURATION-iphonesimulator/RNTester.app"
APP_ID=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$APP/Info.plist")
xcrun simctl install "$SIMULATOR_ID" "$APP"
ARGS=(-route NativeHostPerformance)
if [[ "$CONFIGURATION" == Debug ]]; then ARGS+=(-RCT_jsLocation "127.0.0.1:${NH_REFERENCE_METRO_PORT:-18793}"); fi
xcrun simctl launch --terminate-running-process "$SIMULATOR_ID" "$APP_ID" "${ARGS[@]}"
