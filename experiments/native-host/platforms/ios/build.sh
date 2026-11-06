#!/usr/bin/env bash
set -euo pipefail
IOS_DIR="$(cd "$(dirname "$0")" && pwd)"
export NH_EXPERIMENT="$(cd "$IOS_DIR/../.." && pwd)"
export NH_REPO="$(cd "$NH_EXPERIMENT/../.." && pwd)"
export NH_HERMES="${NH_HERMES:-/Users/jesse/code/tapcart/tapcart-react-native/ios/Pods/hermes-engine/destroot}"
export NH_DRIVER_ENABLED=0 NH_DRIVER_TOKEN= NH_DRIVER_PORT=19842 NH_DRIVER_TIMEOUT=180
export NH_DRIVER_REVISION= NH_DRIVER_INJECT_FAULT=0
CONFIGURATION="${NH_CONFIGURATION:-Debug}"
FEATURE_ARGS=()
CPP_ARGS=()
case "$CONFIGURATION" in
  Debug)
    BUNDLE_NAME=app.bundle.js
    case "${NH_TEST_HOOKS:-1}" in
      1) FEATURE_ARGS=(--features test-hooks) ;;
      0) CPP_ARGS=('GCC_PREPROCESSOR_DEFINITIONS=DEBUG=1 NH_DEV_UPDATES=1') ;;
      *) echo 'NH_TEST_HOOKS must be 0 or 1' >&2; exit 1 ;;
    esac
    ;;
  Release) BUNDLE_NAME=app.release.bundle.js ;;
  *) echo 'NH_CONFIGURATION must be Debug or Release' >&2; exit 1 ;;
esac
if [[ ! -f "$NH_EXPERIMENT/build/$BUNDLE_NAME" ]]; then
  echo "Missing build/$BUNDLE_NAME; run the matching bundle command." >&2
  exit 1
fi
SDK="${NH_SDK:-iphonesimulator}"
SIGNING_ARGS=(CODE_SIGNING_ALLOWED=NO)
case "$SDK" in
  iphonesimulator) RUST_TARGET=aarch64-apple-ios-sim; DESTINATION='generic/platform=iOS Simulator'; DERIVED_DATA="$IOS_DIR/build" ;;
  iphoneos)
    RUST_TARGET=aarch64-apple-ios; DESTINATION='generic/platform=iOS'; DERIVED_DATA="$IOS_DIR/build-device"
    if [[ -n "${NH_DEVICE_ID:-}" ]]; then DESTINATION="platform=iOS,id=$NH_DEVICE_ID"; fi
    if [[ -n "${NH_DEVELOPMENT_TEAM:-}" ]]; then
      SIGNING_ARGS=(CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Automatic "DEVELOPMENT_TEAM=$NH_DEVELOPMENT_TEAM")
    fi
    ;;
  *) echo 'NH_SDK must be iphonesimulator or iphoneos' >&2; exit 1 ;;
esac
DERIVED_DATA="${NH_DERIVED_DATA:-$DERIVED_DATA}"
PROVISIONING_ARGS=()
if [[ "${NH_ALLOW_PROVISIONING_UPDATES:-0}" == 1 ]]; then
  : "${NH_DEVELOPMENT_TEAM:?Provisioning requires an explicitly selected existing team}"
  PROVISIONING_ARGS=(-allowProvisioningUpdates -allowProvisioningDeviceRegistration)
fi
cargo build --manifest-path "$NH_EXPERIMENT/core/Cargo.toml" --release --target "$RUST_TARGET" "${FEATURE_ARGS[@]}"
xcodegen generate --spec "$IOS_DIR/project.yml" --project "$IOS_DIR"
xcodebuild -project "$IOS_DIR/NativeHost.xcodeproj" -scheme NativeHost -configuration "$CONFIGURATION" -sdk "$SDK" -destination "$DESTINATION" -derivedDataPath "$DERIVED_DATA" NH_EXPERIMENT="$NH_EXPERIMENT" NH_REPO="$NH_REPO" NH_HERMES="$NH_HERMES" "${SIGNING_ARGS[@]}" "${PROVISIONING_ARGS[@]}" "${CPP_ARGS[@]}" build
