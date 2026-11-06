#!/usr/bin/env python3
"""Isolated embedded-Hermes ingress matrix; no device or canonical binary writes."""
import argparse
import json
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--seed-cache', type=pathlib.Path, required=True,
                    help='Existing matched-Hermes CMakeCache.txt (paths only)')
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[2]
cache = dict(line.split('=', 1) for line in args.seed_cache.read_text().splitlines()
             if '=' in line and not line.startswith(('#', '//')))
common = [f'-DHERMES_ROOT={cache["HERMES_ROOT:PATH"]}',
          f'-DHERMES_FRAMEWORK={cache["HERMES_FRAMEWORK:PATH"]}',
          f'-DNH_CORE_LIBRARY={root / "core/target/release/libnative_host_core.a"}',
          '-DCMAKE_BUILD_TYPE=Release']
report = {'matrix': [], 'productionRejection': False}
for dev in [0, 1]:
    for hooks in [0, 1]:
        output = root / f'build/dev-ingress-{dev}-{hooks}'
        output.mkdir(parents=True, exist_ok=True)
        log = output / 'matrix.log'
        commands = [
            ['cmake', '-S', str(root / 'runtime'), '-B', str(output), *common,
             f'-DNH_DEV_UPDATES={dev}', f'-DNH_TEST_HOOKS={hooks}',
             f'-DNH_PRODUCTION_ARTIFACT={int(not dev)}'],
            ['cmake', '--build', str(output), '-j', '4'],
            ['ctest', '--test-dir', str(output), '--output-on-failure', '--timeout', '20'],
        ]
        with log.open('w') as stream:
            for command in commands:
                stream.write(json.dumps(command) + '\n')
                stream.flush()
                result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT)
                if result.returncode:
                    raise RuntimeError(f'matrix {dev}/{hooks} failed; inspect {log}')
        archive = output / 'libnative_host_runtime.a'
        symbols = subprocess.check_output(['nm', '-g', str(archive)], text=True)
        names = ['_nh_host_dev_open', '_nh_host_dev_enqueue', '_nh_host_dev_drain', '_nh_host_dev_status']
        assert all((name in symbols) == bool(dev) for name in names)
        if not dev:
            strings = subprocess.check_output(['strings', str(archive)], text=True)
            assert 'native-host:dev/' not in strings
            assert 'DEV_RELOAD_REQUIRED' not in strings
            assert not (output / 'native-host-dev-driver').exists()
        report['matrix'].append({'devUpdates': bool(dev), 'testHooks': bool(hooks),
                                 'passed': True, 'symbolCheck': True, 'log': str(log)})
        print(f'dev={dev} testHooks={hooks}: tests and symbols passed', flush=True)
invalid = root / 'build/dev-ingress-forbidden'
result = subprocess.run(['cmake', '-S', str(root / 'runtime'), '-B', str(invalid),
                         *common, '-DNH_DEV_UPDATES=ON', '-DNH_PRODUCTION_ARTIFACT=ON'],
                        text=True, capture_output=True)
assert result.returncode and 'forbidden in production' in result.stderr
report['productionRejection'] = True
(root / 'build/dev-ingress-matrix.json').write_text(json.dumps(report, indent=2) + '\n')
print('production build rejection passed', flush=True)
