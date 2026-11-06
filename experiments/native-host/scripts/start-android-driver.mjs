import {readFile} from 'node:fs/promises';
import {spawn, spawnSync} from 'node:child_process';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (config.platform !== 'android' || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || !/^[a-zA-Z0-9_-]{32,}$/.test(config.token)) {
  throw new Error('Expected an Android driver config with port and an alphanumeric session token');
}
if (config.revision !== undefined && (typeof config.revision !== 'string' || !/^[0-9]+$/.test(config.revision))) throw new Error('Development revision must be a digit string');
const adb = process.env.ADB || 'adb';
const serial = process.env.NH_ANDROID_SERIAL || 'emulator-5580';
const forwarded = spawnSync(adb, ['-s', serial, 'forward', `tcp:${config.port}`, `tcp:${config.port}`], {stdio: 'inherit'});
if (forwarded.error) throw forwarded.error;
if (forwarded.status !== 0) throw new Error('Could not forward the native test-driver port');
const child = spawn(adb, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-e', 'mode', 'server', '-e', 'token', config.token, '-e', 'port', String(config.port), ...(config.revision ? ['-e', 'revision', config.revision] : []), 'dev.nativehost.experiment.test/dev.nativehost.HostInstrumentation'], {stdio: 'inherit'});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
