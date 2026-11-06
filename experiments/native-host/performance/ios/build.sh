#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/environment.sh"
CONFIGURATION="${1:-Debug}"
case "$CONFIGURATION" in Debug|Release) ;; *) echo 'Expected Debug or Release' >&2; exit 1 ;; esac
if [[ ! -d "$NH_REFERENCE/packages/rn-tester/Pods" ]]; then echo 'Run setup.sh first' >&2; exit 1; fi
DERIVED_DATA="${NH_REFERENCE_DERIVED_DATA:-$NH_EXPERIMENT/build/performance/rn-tester-$CONFIGURATION}"
cd "$NH_REFERENCE/packages/rn-tester"
python3 "$PERF_IOS_DIR/run-step.py" "build-$CONFIGURATION" "$NH_IOS_ARTIFACTS" \
  xcodebuild -workspace RNTesterPods.xcworkspace -scheme RNTester \
  -configuration "$CONFIGURATION" -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath "$DERIVED_DATA" \
  -jobs "${NH_BUILD_JOBS:-4}" ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build
