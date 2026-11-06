#!/usr/bin/env bash
set -euo pipefail
OBSERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$OBSERVER_DIR/../environment.sh"
: "${NH_SIMULATOR_ID:?Select the dedicated simulator UUID}"
: "${NH_OBSERVER_TOKEN:?Provide a private observer token}"
export NH_OBSERVER_ENABLED=1 NH_OBSERVER_TOKEN
export NH_OBSERVER_PORT="${NH_OBSERVER_PORT:-19846}"
export NH_OBSERVER_TIMEOUT="${NH_OBSERVER_TIMEOUT:-1800}"
xcodegen generate --spec "$OBSERVER_DIR/project.yml" --project "$OBSERVER_DIR"
mkdir -p "$NH_IOS_ARTIFACTS"
RESULT="$NH_IOS_ARTIFACTS/observer-$(date +%Y%m%d-%H%M%S).xcresult"
ACTION=test
if [[ "${NH_OBSERVER_NO_BUILD:-0}" == 1 ]]; then ACTION=test-without-building; fi
xcodebuild -project "$OBSERVER_DIR/PerformanceObserver.xcodeproj" -scheme PerformanceObserver \
  -configuration Debug -destination "platform=iOS Simulator,id=$NH_SIMULATOR_ID" \
  -derivedDataPath "$NH_EXPERIMENT/build/performance/ios-observer" -resultBundlePath "$RESULT" \
  -only-testing:ObserverTests/ObserverTests CODE_SIGNING_ALLOWED=NO "$ACTION"
python3 - "$RESULT" <<'PY'
import json, subprocess, sys
summary = json.loads(subprocess.check_output(['xcrun', 'xcresulttool', 'get', 'test-results', 'summary', '--path', sys.argv[1]]))
if summary.get('totalTestCount') != 1 or summary.get('passedTests') != 1:
    raise SystemExit('Independent observer did not execute and close successfully')
PY
