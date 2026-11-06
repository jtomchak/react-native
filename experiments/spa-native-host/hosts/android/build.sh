#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
runner="${SPA_GRADLE:-$PWD/gradlew}"
if [[ $# -eq 0 ]]; then set -- assembleDebug; fi
exec "$runner" --no-daemon --console=plain "$@"
