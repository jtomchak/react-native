#!/usr/bin/env python3
"""Build full source RNTester and retain raw setup durations; never install or clean."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

EXPERIMENT = Path(__file__).resolve().parents[2]
REFERENCE = EXPERIMENT / 'build/reference'


def version(command):
    result = subprocess.run(command, capture_output=True, text=True)
    return (result.stdout + result.stderr).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--variant', choices=['debug', 'release'], required=True)
    parser.add_argument('--label', required=True, help='Evidence label, not an automatic claim of cache/cold state')
    parser.add_argument('--max-workers', type=int, default=4)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', args.label) or not 1 <= args.max_workers <= 16:
        raise RuntimeError('Invalid label or worker count')
    setup = json.loads((REFERENCE / 'performance-android-setup.json').read_text())
    head = version(['git', '-C', str(REFERENCE), 'rev-parse', 'HEAD'])
    if head != setup['sourceCommit']:
        raise RuntimeError('Reference HEAD changed after setup')
    stamp = str(time.time_ns() // 1_000_000)
    output = EXPERIMENT / 'build/performance/android' / f'{stamp}-{args.variant}-{args.label}'
    output.mkdir(parents=True)
    env = dict(os.environ)
    env['JAVA_HOME'] = env.get('NH_JAVA_HOME', '/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home')
    env['ANDROID_HOME'] = setup['sdk']
    env['JAVA_TOOL_OPTIONS'] = f'-XX:ActiveProcessorCount={args.max_workers}'
    task = ':packages:rn-tester:android:app:assemble' + args.variant.title()
    command = ['./gradlew', task, '--console=plain', f'--max-workers={args.max_workers}',
               '-PreactNativeArchitectures=arm64-v8a', '-PnewArchEnabled=true',
               '-PreactNativeDevServerPort=18791']
    started = time.time_ns()
    with (output / 'gradle.log').open('w') as log:
        result = subprocess.run(command, cwd=REFERENCE, env=env, stdout=log, stderr=subprocess.STDOUT)
    duration_ms = (time.time_ns() - started) / 1_000_000
    artifacts = []
    for path in sorted((REFERENCE / 'packages/rn-tester/android/app/build/outputs/apk' / args.variant).glob('*.apk')):
        data = path.read_bytes()
        artifacts.append({'path': str(path), 'byteLength': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    evidence = {'schemaVersion': 1, 'label': args.label, 'variant': args.variant, 'sourceCommit': head,
                'command': command, 'cwd': str(REFERENCE), 'exitCode': result.returncode,
                'durationMs': duration_ms, 'startedAtUnixMs': started // 1_000_000,
                'timingClassification': 'raw setup/build duration; concurrent machine load and cache state uncontrolled; not publishable comparative performance',
                'cleanPerformed': False, 'sourceGraph': 'full RNTester and source ReactAndroid',
                'nativeParallelism': 'Stock AGP/Ninja default; max-workers limits Gradle, not necessarily clang fanout',
                'applicationId': setup['applicationId'], 'react': setup['react'], 'hermesCompiler': setup['hermesCompiler'],
                'nodeVersion': version(['node', '--version']), 'javaVersion': version([env['JAVA_HOME'] + '/bin/java', '-version']),
                'gradleWrapper': (REFERENCE / 'gradle/wrapper/gradle-wrapper.properties').read_text(),
                'nativeVersions': (REFERENCE / 'packages/react-native/gradle/libs.versions.toml').read_text().split('[libraries]')[0],
                'sourceStatus': version(['git', '-C', str(REFERENCE), 'status', '--short']),
                'artifactsValidatedByThisBuild': result.returncode == 0, 'artifacts': artifacts}
    (output / 'result.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps({'result': str(output / 'result.json'), 'exitCode': result.returncode,
                      'rawDurationMs': duration_ms, 'artifacts': artifacts}))
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
