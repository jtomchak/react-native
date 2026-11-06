#!/usr/bin/env python3
"""Real XCTest input regression; requires an already-running shared workload."""
import argparse
import json
from pathlib import Path
import socket

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('config', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--package', default='dev.nativehost.prototype', choices=[
    'dev.nativehost.prototype', 'com.meta.RNTester.localDevelopment'])
args = parser.parse_args()
config = json.loads(args.config.read_text())
records = []
with socket.create_connection(('127.0.0.1', config['port']), timeout=60) as connection:
    stream = connection.makefile('rwb')

    def call(method, params, *, record=True):
        stream.write((json.dumps({'id': len(records), 'method': method, 'params': params}) + '\n').encode())
        stream.flush()
        line = stream.readline()
        if not line:
            raise RuntimeError('Observer disconnected')
        response = json.loads(line)
        if record:
            records.append({'method': method, 'params': params, 'response': response})
        if 'error' in response:
            raise RuntimeError(response['error'])
        return response['result']

    def ui(method, test_id=None, **params):
        params['package'] = args.package
        if test_id:
            params['selector'] = {'testID': test_id}
        return call(method, params)

    call('session.authenticate', {'token': config['token']}, record=False)
    try:
        ui('ui.waitFor', 'perf-input', timeoutMs=10000)
        # No per-character or inter-action delay: exercise ordinary XCTest typing.
        for value in ['native comparison', 'rapid testing 123', 'native comparison',
                      'abcdef 987654321', 'short', 'native comparison']:
            ui('ui.type', 'perf-input', text=value)
            native = ui('ui.text', 'perf-input')['text']
            echo = ui('ui.text', 'perf-input-value')['text']
            if native != value or echo != 'Input: ' + value:
                raise AssertionError({'expected': value, 'native': native, 'echo': echo})
        ui('ui.dismissKeyboard')
        print('PASS six real keyboard replacements and matching React echoes')
    finally:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(records, indent=2) + '\n')
