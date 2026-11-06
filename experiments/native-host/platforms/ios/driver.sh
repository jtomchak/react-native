#!/usr/bin/env bash
set -euo pipefail
IOS_DIR="$(cd "$(dirname "$0")" && pwd)"
export NH_EXPERIMENT="$(cd "$IOS_DIR/../.." && pwd)"
export NH_REPO="$(cd "$NH_EXPERIMENT/../.." && pwd)"
export NH_HERMES="${NH_HERMES:-/Users/jesse/code/tapcart/tapcart-react-native/ios/Pods/hermes-engine/destroot}"
export NH_DRIVER_TOKEN="${NH_DRIVER_TOKEN:?Set a fresh random driver token of at least 24 characters}"
export NH_DRIVER_PORT="${NH_DRIVER_PORT:-19842}"
export NH_DRIVER_TIMEOUT="${NH_DRIVER_TIMEOUT:-180}"
export NH_DRIVER_ENABLED=1
export NH_DRIVER_REVISION="${NH_DRIVER_REVISION:-}"
export NH_DRIVER_INJECT_FAULT="${NH_DRIVER_INJECT_FAULT:-0}"
SIMULATOR_ID="${NH_SIMULATOR_ID:?Set NH_SIMULATOR_ID to the dedicated simulator UUID}"
if [[ ${#NH_DRIVER_TOKEN} -lt 24 ]]; then
  echo 'Driver token must contain at least 24 characters' >&2
  exit 1
fi
mkdir -p "$IOS_DIR/artifacts"
ACTION=test
if [[ "${NH_DRIVER_NO_BUILD:-0}" == 1 ]]; then
  ACTION=test-without-building
else
  cargo build --manifest-path "$NH_EXPERIMENT/core/Cargo.toml" --release --target aarch64-apple-ios-sim --features test-hooks
fi
xcodegen generate --spec "$IOS_DIR/project.yml" --project "$IOS_DIR"
RESULT_PATH="$IOS_DIR/artifacts/driver-$(date +%Y%m%d-%H%M%S).xcresult"
xcodebuild -project "$IOS_DIR/NativeHost.xcodeproj" -scheme NativeHost -configuration Debug -destination "platform=iOS Simulator,id=$SIMULATOR_ID" -only-testing:NativeHostUITests/NativeDriverTests -derivedDataPath "$IOS_DIR/build" -resultBundlePath "$RESULT_PATH" NH_EXPERIMENT="$NH_EXPERIMENT" NH_REPO="$NH_REPO" NH_HERMES="$NH_HERMES" CODE_SIGNING_ALLOWED=NO "$ACTION"
python3 - "$RESULT_PATH" <<'PY'
import json, subprocess, sys
result = json.loads(subprocess.check_output(['xcrun','xcresulttool','get','test-results','summary','--path',sys.argv[1]]))
if result.get('totalTestCount') != 1 or result.get('passedTests') != 1:
    raise SystemExit('Driver did not execute and pass exactly one XCTest session')
PY
