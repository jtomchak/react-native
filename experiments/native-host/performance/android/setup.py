#!/usr/bin/env python3
"""Apply the isolated Android app identity to the pinned, full RNTester checkout."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

PIN = 'fe398e511d7b4cfa22baf5b449e256ff9b7d66c4'
EXPERIMENT = Path(__file__).resolve().parents[2]
DEFAULT_REFERENCE = EXPERIMENT / 'build/reference'
APP_ID = 'dev.nativehost.reference'


def replace_exact(path, before, after):
    text = path.read_text()
    if after in text:
        return
    if text.count(before) != 1:
        raise RuntimeError(f'Expected exactly one pinned-source match in {path}')
    path.write_text(text.replace(before, after))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, default=DEFAULT_REFERENCE)
    parser.add_argument('--sdk', type=Path, default=Path(os.environ.get('ANDROID_HOME', str(Path.home() / 'Library/Android/sdk'))))
    args = parser.parse_args()
    reference = args.reference.resolve()
    if reference != DEFAULT_REFERENCE.resolve():
        raise RuntimeError('This setup only modifies the task-owned build/reference checkout')
    head = subprocess.check_output(['git', '-C', str(reference), 'rev-parse', 'HEAD'], text=True).strip()
    branch = subprocess.run(['git', '-C', str(reference), 'symbolic-ref', '-q', 'HEAD'], capture_output=True)
    if head != PIN or branch.returncode == 0:
        raise RuntimeError('Expected the pinned detached reference checkout')
    if not (reference / 'node_modules/react/package.json').is_file():
        raise RuntimeError('Install the pinned reference workspace dependencies before setup')
    app = reference / 'packages/rn-tester/android/app'
    replace_exact(app / 'build.gradle.kts', 'applicationId = "com.facebook.react.uiapp"', f'applicationId = "{APP_ID}"')
    replace_exact(app / 'src/main/res/values/strings.xml', '>com.facebook.react.uiapp.blobs<', f'>{APP_ID}.blobs<')
    properties = reference / 'local.properties'
    lines = properties.read_text().splitlines() if properties.exists() else []
    lines = [line for line in lines if not line.startswith('sdk.dir=')]
    lines.append('sdk.dir=' + str(args.sdk.resolve()).replace('\\', '\\\\'))
    properties.write_text('\n'.join(lines) + '\n')
    native = json.loads((reference / 'packages/react-native/package.json').read_text())
    result = {'schemaVersion': 1, 'sourceCommit': head, 'applicationId': APP_ID,
              'scope': 'Full RNTester application and source ReactAndroid; no graph pruning',
              'react': json.loads((reference / 'node_modules/react/package.json').read_text())['version'],
              'hermesCompiler': native['dependencies']['hermes-compiler'],
              'sdk': str(args.sdk.resolve()), 'setupCompletedAtUnixMs': time.time_ns() // 1_000_000,
              'sourceOverrides': ['packages/rn-tester/android/app/build.gradle.kts: applicationId only',
                                  'packages/rn-tester/android/app/src/main/res/values/strings.xml: blob authority only',
                                  'local.properties: SDK location']}
    (reference / 'performance-android-setup.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
