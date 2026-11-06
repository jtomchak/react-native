#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mode="${1:-build}"
configuration="${CONFIGURATION:-Debug}"
destination="${SPA_IOS_DESTINATION:-platform=iOS Simulator,id=D942F30F-EB29-4921-892E-5F3160A038A3}"
[[ -f "$here/../../build/web/index.html" ]] || { echo 'Stage the exported SPA using tooling/sync.mjs first.' >&2; exit 1; }
cd "$here"
node "$here/../../tooling/plugins.mjs" sync
xcodegen generate
case "$mode" in
  build|test) ;;
  *) echo 'Usage: build.sh [build|test]' >&2; exit 1;;
esac
args=("$mode" -project SPAHost.xcodeproj -scheme SPAHost -configuration "$configuration" -destination "$destination" -derivedDataPath "$here/build/DerivedData")
if [[ "$mode" == test ]]; then
  args+=(-test-timeouts-enabled YES -default-test-execution-time-allowance 45 -maximum-test-execution-time-allowance 60)
fi
if [[ "$destination" == *'iOS Simulator'* ]]; then
  # Simulator Keychain access requires an ad-hoc signed app on current iOS.
  # This uses no development identity, provisioning profile, or Apple account.
  args+=(CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-)
else
  [[ "$mode" == build ]] || { echo 'Physical tests require separately authorized test identifiers.' >&2; exit 1; }
  [[ "${SPA_ALLOW_PROVISIONING:-0}" == 1 && "${SPA_DEVELOPMENT_TEAM:-}" == NSLC4354J7 ]] || { echo 'Physical build requires explicit SPA_ALLOW_PROVISIONING=1 and authorized individual team SPA_DEVELOPMENT_TEAM=NSLC4354J7.' >&2; exit 1; }
  # User authorized only this app ID/profile using the existing individual certificate.
  security find-identity -v -p codesigning | rg -q '32ABABC99A946F8387A717249FE79FBAA3F23D96' || { echo 'Authorized existing development identity is unavailable.' >&2; exit 1; }
  args+=(DEVELOPMENT_TEAM=NSLC4354J7 'CODE_SIGN_IDENTITY=Apple Development' -allowProvisioningUpdates)
fi
if [[ "${SPA_ENABLE_PUSH:-0}" == 1 || "${SPA_ENABLE_ASSOCIATED_DOMAINS:-0}" == 1 || "${SPA_ENABLE_PASSKEYS:-0}" == 1 ]]; then
  mkdir -p "$here/build/signing"
  python3 - "$here" <<'PYCODE'
import json, os, plistlib, re, sys
from pathlib import Path
from urllib.parse import urlsplit
here = Path(sys.argv[1]); result = {}
if os.environ.get('SPA_ENABLE_PUSH') == '1':
    environment = os.environ.get('SPA_APNS_ENVIRONMENT', 'development')
    if environment not in ('development', 'production'): raise SystemExit('Invalid APNs environment')
    result['aps-environment'] = environment
if os.environ.get('SPA_ENABLE_ASSOCIATED_DOMAINS') == '1':
    domain = os.environ.get('SPA_ASSOCIATED_DOMAIN', '')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]{0,251}[a-zA-Z0-9]', domain): raise SystemExit('Explicit associated domain is required')
    config = json.loads((here / '../../build/web/host-config.json').read_text())
    origin = urlsplit(config['content'].get('origin') or '')
    if origin.scheme != 'https' or origin.hostname != domain.lower() or origin.port not in (None,443): raise SystemExit('Associated domain must match the configured HTTPS origin')
    result['com.apple.developer.associated-domains'] = ['applinks:' + domain.lower()]
if os.environ.get('SPA_ENABLE_PASSKEYS') == '1':
    config = json.loads((here / '../../build/web/host-config.json').read_text())
    auth = config.get('plugins', {}).get('auth', {})
    domain = auth.get('rpId') or ''
    origin = urlsplit(auth.get('origin') or '')
    if not auth.get('enabled') or not re.fullmatch(r'[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]', domain): raise SystemExit('Passkeys require enabled auth and a configured relying-party domain')
    if origin.scheme != 'https' or not (origin.hostname == domain or (origin.hostname or '').endswith('.' + domain)): raise SystemExit('Passkey domain must match the configured HTTPS auth origin')
    result.setdefault('com.apple.developer.associated-domains', []).append('webcredentials:' + domain)
(here / 'build/signing/host-capabilities.entitlements').write_bytes(plistlib.dumps(result))
PYCODE
  args+=(CODE_SIGN_ENTITLEMENTS="$here/build/signing/host-capabilities.entitlements")
fi
if [[ "${SPA_ENABLE_PUSH:-0}" == 1 || "${SPA_ENABLE_PASSKEYS:-0}" == 1 ]]; then
  conditions=''
  [[ "$configuration" != Debug ]] || conditions='DEBUG'
  [[ "${SPA_ENABLE_PUSH:-0}" != 1 ]] || conditions="$conditions SPA_PUSH_ENABLED"
  [[ "${SPA_ENABLE_PASSKEYS:-0}" != 1 ]] || conditions="$conditions SPA_PASSKEYS_ENABLED"
  args+=("SPA_APNS_ENVIRONMENT=${SPA_APNS_ENVIRONMENT:-development}" "SWIFT_ACTIVE_COMPILATION_CONDITIONS=$conditions")
fi
xcodebuild "${args[@]}"

if [[ "$destination" != *'iOS Simulator'* ]]; then
  app="$here/build/DerivedData/Build/Products/$configuration-iphoneos/SPAHost.app"
  mkdir -p "$here/build/signing"
  codesign -d --extract-certificates="$here/build/signing/leaf-" "$app"
  actual="$(openssl x509 -inform DER -in "$here/build/signing/leaf-0" -noout -fingerprint -sha1 | tr -d ':' | cut -d= -f2)"
  [[ "$actual" == 32ABABC99A946F8387A717249FE79FBAA3F23D96 ]] || { echo 'Build did not use the authorized existing certificate; do not install.' >&2; exit 1; }
fi
