#!/usr/bin/env python3
"""Launch an already-installed external observer with a private session config."""
import argparse
import json
from pathlib import Path
import re
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path, help='Private JSON {port,token}; never committed')
    parser.add_argument('--serial', required=True)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    port = config.get('port')
    token = config.get('token', '')
    if type(port) is not int or not 1024 <= port <= 65535 or not isinstance(token, str) or not re.fullmatch('[A-Za-z0-9_-]{32,}', token):
        raise RuntimeError('Invalid private observer configuration')
    adb = ['adb', '-s', args.serial]
    subprocess.run(adb + ['forward', f'tcp:{port}', f'tcp:{port}'], check=True)
    try:
        child = subprocess.Popen(adb + ['shell', 'am', 'instrument', '-w', '-e', 'port', str(port), '-e', 'token', token,
                                       'dev.nativehost.observer.test/dev.nativehost.observer.ObserverInstrumentation'])
        try:
            code = child.wait()
        except KeyboardInterrupt:
            subprocess.run(adb + ['shell', 'am', 'force-stop', 'dev.nativehost.observer'], check=False)
            child.terminate()
            child.wait()
            code = 130
    finally:
        subprocess.run(adb + ['forward', '--remove', f'tcp:{port}'], check=False, stdout=subprocess.DEVNULL)
    raise SystemExit(code)


if __name__ == '__main__':
    main()
