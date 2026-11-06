#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/environment.sh"
for executable in node bundle cmake xcodebuild; do command -v "$executable" >/dev/null; done
if [[ ! -d "$NH_REFERENCE/node_modules" || ! -d "$NH_REFERENCE/packages/react-native-codegen/lib" ]]; then
  echo 'Reference node_modules and built codegen are prerequisites; use the shared reference setup first.' >&2
  exit 1
fi
cd "$NH_REFERENCE/packages/rn-tester"
if [[ -f "$PERF_IOS_DIR/Gemfile.lock" ]]; then
  cp "$PERF_IOS_DIR/Gemfile.lock" Gemfile.lock
  export BUNDLE_FROZEN=true
fi
python3 "$PERF_IOS_DIR/run-step.py" bundle-install "$NH_IOS_ARTIFACTS" bundle install --jobs 4
if [[ ! -f "$PERF_IOS_DIR/Gemfile.lock" ]]; then cp Gemfile.lock "$PERF_IOS_DIR/Gemfile.lock"; fi
if [[ -f "$PERF_IOS_DIR/Podfile.lock" ]]; then cp "$PERF_IOS_DIR/Podfile.lock" Podfile.lock; fi
# This source commit declares Hermes .0.2 but ships an older .0.1 lock entry.
# Resolve only that declared pod; do not perform a general dependency update.
if python3 - <<'CHECK'
import pathlib, re, sys
version = re.search(r'HERMES_VERSION_NAME=(.+)', pathlib.Path('../react-native/sdks/hermes-engine/version.properties').read_text()).group(1).strip()
lock = pathlib.Path('Podfile.lock')
match = re.search(r'^  - hermes-engine \(([^)]+)\)', lock.read_text(), re.M) if lock.exists() else None
sys.exit(0 if match and match.group(1) != version else 1)
CHECK
then
  python3 "$PERF_IOS_DIR/run-step.py" pod-update-declared-hermes "$NH_IOS_ARTIFACTS" bundle exec pod update hermes-engine --no-repo-update
else
  python3 "$PERF_IOS_DIR/run-step.py" pod-install "$NH_IOS_ARTIFACTS" bundle exec pod install
fi
if [[ ! -f "$PERF_IOS_DIR/Podfile.lock" ]]; then cp Podfile.lock "$PERF_IOS_DIR/Podfile.lock"; fi
