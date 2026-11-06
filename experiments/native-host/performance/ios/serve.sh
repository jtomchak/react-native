#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/environment.sh"
cd "$NH_REFERENCE/packages/rn-tester"
exec "$NH_REFERENCE/node_modules/.bin/react-native" start --host 127.0.0.1 --port "${NH_REFERENCE_METRO_PORT:-18793}" --no-interactive "$@"
