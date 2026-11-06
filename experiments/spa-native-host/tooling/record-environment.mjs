import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import path from 'node:path';
import {root} from './paths.mjs';

const exec = promisify(execFile);
async function command(binary, args) {
  try {
    const {stdout, stderr} = await exec(binary, args, {timeout: 20000, maxBuffer: 256 * 1024});
    return {ok: true, output: `${stdout}${stderr}`.trim()};
  } catch (error) { return {ok: false, error: error.message}; }
}

const [xcode, java, android, simulator] = await Promise.all([
  command('xcodebuild', ['-version']), command('java', ['-version']),
  command('adb', ['devices', '-l']), command('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']),
]);
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const result = {recordedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
  dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, xcode, java, android, simulator};
await mkdir(path.join(root, 'evidence'), {recursive: true});
await writeFile(path.join(root, 'evidence/environment.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log('Recorded local toolchain environment in evidence/environment.json');
