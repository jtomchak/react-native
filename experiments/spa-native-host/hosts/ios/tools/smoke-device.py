#!/usr/bin/env python3
"""Run fixed Debug-only in-app probes; no XCTest identity or remote eval API."""
import argparse
import json
from pathlib import Path
import subprocess
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--device', required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
token = uuid.uuid4().hex
bundle = 'dev.spahost.prototype'

def invoke(parts, *, check=True):
    result = subprocess.run(['xcrun', 'devicectl', *parts], capture_output=True, text=True, timeout=25)
    if check and result.returncode:
        raise RuntimeError(result.stderr or result.stdout)
    return result

def probe(phase):
    launch_file = args.output / f'{phase}-launch.json'
    invoke(['device', 'process', 'launch', '--device', args.device, '--terminate-existing', '--json-output', str(launch_file), bundle, '--spa-smoke', phase, '--spa-smoke-token', token])
    report_file = args.output / f'{phase}-report.json'
    end = time.monotonic() + 50
    while time.monotonic() < end:
        copied = invoke(['device', 'copy', 'from', '--device', args.device, '--domain-type', 'appDataContainer', '--domain-identifier', bundle, '--source', f'Documents/spa-smoke-{phase}.json', '--destination', str(report_file)], check=False)
        if copied.returncode == 0 and report_file.exists():
            report = json.loads(report_file.read_text())
            if report.get('token') == token and report.get('phase') == phase:
                if not report.get('passed'):
                    raise RuntimeError(f'{phase} probe failed: {report}')
                print(f'{phase}: {len(report["checks"])} checks passed, PID {report["pid"]}', flush=True)
                return report
        time.sleep(0.5)
    raise RuntimeError(f'Timed out waiting for fresh {phase} probe report')

write = probe('write')
invoke(['device', 'process', 'terminate', '--device', args.device, '--pid', str(write['pid']), '--kill', '--json-output', str(args.output / 'terminate.json')])
read = probe('read')
if read['pid'] == write['pid']:
    raise RuntimeError('Process identity did not change')
summary = {'passed': True, 'token': token, 'writePID': write['pid'], 'readPID': read['pid'], 'writeChecks': len(write['checks']), 'readChecks': len(read['checks']), 'evidence': 'Fixed in-app WK/native probes, not independent OS touch or perceived haptic/camera evidence'}
(args.output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary), flush=True)
