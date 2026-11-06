#!/usr/bin/env bash
set -euo pipefail
IOS_DIR="$(cd "$(dirname "$0")" && pwd)"
export NH_EXPERIMENT="$(cd "$IOS_DIR/../.." && pwd)"
export NH_REPO="$(cd "$NH_EXPERIMENT/../.." && pwd)"
export NH_HERMES="${NH_HERMES:-/Users/jesse/code/tapcart/tapcart-react-native/ios/Pods/hermes-engine/destroot}"
export NH_DRIVER_ENABLED=0 NH_DRIVER_TOKEN= NH_DRIVER_PORT=19842 NH_DRIVER_TIMEOUT=180
export NH_DRIVER_REVISION= NH_DRIVER_INJECT_FAULT=0
SIGNING_ARGS=(CODE_SIGNING_ALLOWED=NO)
if [[ -n "${NH_DEVICE_ID:-}" ]]; then
  : "${NH_DEVELOPMENT_TEAM:?Set an existing development team for physical device tests}"
  RUST_TARGET=aarch64-apple-ios; DESTINATION="platform=iOS,id=$NH_DEVICE_ID"; DERIVED_DATA="$IOS_DIR/build-device"; RESULT_PREFIX=device
  SIGNING_ARGS=(CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Automatic "DEVELOPMENT_TEAM=$NH_DEVELOPMENT_TEAM")
else
  SIMULATOR_ID="${NH_SIMULATOR_ID:?Set NH_SIMULATOR_ID to the dedicated simulator UUID}"
  RUST_TARGET=aarch64-apple-ios-sim; DESTINATION="platform=iOS Simulator,id=$SIMULATOR_ID"; DERIVED_DATA="$IOS_DIR/build"; RESULT_PREFIX=ui
fi
mkdir -p "$IOS_DIR/artifacts"
PROVISIONING_ARGS=()
if [[ "${NH_ALLOW_PROVISIONING_UPDATES:-0}" == 1 ]]; then
  : "${NH_DEVELOPMENT_TEAM:?Provisioning requires an explicitly selected existing team}"
  PROVISIONING_ARGS=(-allowProvisioningUpdates -allowProvisioningDeviceRegistration)
fi
cargo build --manifest-path "$NH_EXPERIMENT/core/Cargo.toml" --release --target "$RUST_TARGET" --features test-hooks
xcodegen generate --spec "$IOS_DIR/project.yml" --project "$IOS_DIR"
xcodebuild -project "$IOS_DIR/NativeHost.xcodeproj" -scheme NativeHost -configuration Debug -destination "$DESTINATION" -derivedDataPath "$DERIVED_DATA" -resultBundlePath "$IOS_DIR/artifacts/$RESULT_PREFIX-$(date +%Y%m%d-%H%M%S).xcresult" NH_EXPERIMENT="$NH_EXPERIMENT" NH_REPO="$NH_REPO" NH_HERMES="$NH_HERMES" "${SIGNING_ARGS[@]}" "${PROVISIONING_ARGS[@]}" test
