#!/usr/bin/env bash
set -euo pipefail
REVISION_DIR="${1:?Pass an immutable build/revisions/<digits> directory}"
SIMULATOR_ID="${NH_SIMULATOR_ID:?Set the dedicated simulator UUID}"
APP_ID=dev.nativehost.prototype
REVISION="$(basename "$REVISION_DIR")"
if [[ ! "$REVISION" =~ ^[0-9]+$ ]] || [[ ${#REVISION} -gt 64 ]]; then
  echo 'Revision directory name must be an ASCII digit string up to 64 characters' >&2
  exit 1
fi
CONTAINER="$(xcrun simctl get_app_container "$SIMULATOR_ID" "$APP_ID" data)"
python3 - "$REVISION_DIR" "$CONTAINER" "$REVISION" <<'PY'
import hashlib, json, os, pathlib, shutil, sys, tempfile
source, container, revision = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
manifest = json.loads((source / 'manifest.json').read_text())
if not (manifest.get('schemaVersion') == 1 and manifest.get('revision') == revision and manifest.get('mode') == 'development' and manifest.get('reload') == 'full'):
    raise SystemExit('Invalid development revision manifest')
data = {}
for name, record in [('app.bundle.js', manifest), ('app.bundle.js.map', manifest.get('sourceMap', {}))]:
    if name.endswith('.map') and record.get('file') != name:
        raise SystemExit('Invalid source-map manifest')
    payload = (source / name).read_bytes()
    if len(payload) > 8 * 1024 * 1024 or len(payload) != record.get('byteLength') or hashlib.sha256(payload).hexdigest() != record.get('sha256'):
        raise SystemExit('Revision digest or length mismatch: ' + name)
    data[name] = payload
data['manifest.json'] = json.dumps(manifest, sort_keys=True).encode()
root = container / 'dev-revisions'
root.mkdir(mode=0o700, exist_ok=True)
destination = root / revision
if destination.exists():
    if any((destination / name).read_bytes() != payload for name, payload in data.items()):
        raise SystemExit('Refusing to overwrite an existing different revision')
else:
    temporary = pathlib.Path(tempfile.mkdtemp(prefix='.stage-', dir=root))
    try:
        for name, payload in data.items():
            (temporary / name).write_bytes(payload)
        os.rename(temporary, destination)
    finally:
        if temporary.exists(): shutil.rmtree(temporary)
print('Staged verified development revision ' + revision)
PY
if [[ "${NH_STAGE_ONLY:-0}" != 1 ]]; then
  xcrun simctl launch --terminate-running-process "$SIMULATOR_ID" "$APP_ID" --native-host-revision "$REVISION"
fi
