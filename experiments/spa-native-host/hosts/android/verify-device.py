#!/usr/bin/env python3
"""Run the real packaged host and a second-process durable-storage check."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
parser.add_argument('--install', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parent
directory = root / 'evidence' / str(time.time_ns())
directory.mkdir(parents=True)
report = {'status': 'running', 'serial': args.serial, 'steps': [], 'limits': ['No physical camera capture or perceived haptic sensation asserted', 'No Release execution or benchmark asserted']}

def run(arguments, timeout=90):
    completed = subprocess.run(['adb', '-s', args.serial, *arguments], capture_output=True, text=True, timeout=timeout)
    if completed.returncode:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
    return completed.stdout

def instrument(extra, name):
    output = run(['shell', 'am', 'instrument', '-w', *extra, 'dev.spahost.prototype.test/dev.spahost.prototype.HostInstrumentation'], 120)
    (directory / f'{name}.log').write_text(output)
    print(output, flush=True)
    if 'INSTRUMENTATION_CODE: -1' not in output:
        raise RuntimeError(f'{name} instrumentation failed')
    fields = dict(re.findall(r'^INSTRUMENTATION_RESULT: ([^=]+)=(.*)$', output, re.MULTILINE))
    report['steps'].append({'name': name, 'result': fields})
    return fields

try:
    report['androidApi'] = run(['shell', 'getprop', 'ro.build.version.sdk']).strip()
    report['webView'] = run(['shell', 'dumpsys', 'webviewupdate'])
    for kind, relative in [('app', 'app/build/outputs/apk/debug/app-debug.apk'), ('test', 'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')]:
        apk = root / relative
        report[f'{kind}ApkSha256'] = hashlib.sha256(apk.read_bytes()).hexdigest()
        if args.install:
            print(run(['install', '-r', str(apk)]), flush=True)
    baseline = instrument([], 'packaged')
    run(['shell', 'am', 'force-stop', 'dev.spahost.prototype'])
    restored = instrument(['-e', 'mode', 'verify-persistence', '-e', 'expected', baseline['persistenceToken']], 'process-restart')
    if baseline['pid'] == restored['pid']:
        raise RuntimeError('Persistence test did not enter a new process')
    report['status'] = 'passed'
except Exception as error:
    report['status'] = 'failed'
    report['error'] = str(error)
finally:
    (directory / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(f'Evidence: {directory / "report.json"}', flush=True)
if report['status'] != 'passed':
    raise SystemExit(1)
