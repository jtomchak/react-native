#!/usr/bin/env python3
"""Record baseline setup/build observations; these are not benchmark samples."""
import datetime
import json
import os
import pathlib
import subprocess
import sys
import time

label, directory, *command = sys.argv[1:]
if not command:
    raise SystemExit('run-step.py LABEL ARTIFACT_DIRECTORY COMMAND [ARGS...]')
root = pathlib.Path(directory).resolve()
root.mkdir(parents=True, exist_ok=True)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
log = root / f'{stamp}-{label}.log'
started = time.monotonic()
with log.open('wb') as stream:
    result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT, check=False)
record = {
    'label': label, 'command': command, 'cwd': os.getcwd(),
    'startedAt': stamp, 'elapsedSeconds': time.monotonic() - started,
    'exitCode': result.returncode, 'log': str(log),
    'classification': 'setup-observation-not-performance-comparison',
    'concurrentWorkloadsNotControlled': True,
}
(root / f'{stamp}-{label}.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record, indent=2), flush=True)
if result.returncode:
    print(log.read_text(errors='replace')[-12000:], file=sys.stderr)
raise SystemExit(result.returncode)
