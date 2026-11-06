#!/usr/bin/env bash
set -euo pipefail
OBSERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
python3 - "${1:?Pass private observer JSON config}" "$OBSERVER_DIR/run.sh" <<'PY'
import json, os, sys
config = json.load(open(sys.argv[1], encoding='utf-8'))
if config.get('platform') != 'ios': raise SystemExit('Expected platform ios')
token = config.get('token', '')
port = config.get('port', 19846)
timeout = config.get('timeoutSeconds', 1800)
if not isinstance(token, str) or len(token) < 24: raise SystemExit('Token must contain at least 24 characters')
if not isinstance(port, int) or not 1024 <= port <= 65535: raise SystemExit('Invalid loopback port')
if not isinstance(timeout, int) or not 30 <= timeout <= 7200: raise SystemExit('Invalid observer lifetime')
env = dict(os.environ, NH_OBSERVER_TOKEN=token, NH_OBSERVER_PORT=str(port), NH_OBSERVER_TIMEOUT=str(timeout))
os.execve('/bin/bash', ['bash', sys.argv[2]], env)
PY
