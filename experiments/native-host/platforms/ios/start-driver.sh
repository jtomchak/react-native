#!/usr/bin/env bash
set -euo pipefail
IOS_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_PATH="${1:?Pass a private JSON driver config containing platform, port and token}"
python3 - "$CONFIG_PATH" "$IOS_DIR/driver.sh" <<'PY'
import json, os, sys
with open(sys.argv[1], encoding='utf-8') as handle:
    config = json.load(handle)
if config.get('platform') != 'ios':
    raise SystemExit('Driver configuration platform must be ios')
port = config.get('port', 19842)
token = config.get('token', '')
if not isinstance(port, int) or not 1024 <= port <= 65535:
    raise SystemExit('Driver port must be an integer from 1024 to 65535')
if not isinstance(token, str) or len(token) < 24:
    raise SystemExit('Driver token must contain at least 24 characters')
environment = dict(os.environ, NH_DRIVER_TOKEN=token, NH_DRIVER_PORT=str(port))
revision = config.get('revision', '')
if not isinstance(revision, str) or (revision and (not revision.isascii() or not revision.isdigit() or len(revision) > 64)):
    raise SystemExit('Driver revision must be an ASCII digit string up to 64 characters')
environment['NH_DRIVER_REVISION'] = revision
environment['NH_DRIVER_INJECT_FAULT'] = '1' if config.get('injectFault') is True else '0'
os.execve('/bin/bash', ['bash', sys.argv[2]], environment)
PY
