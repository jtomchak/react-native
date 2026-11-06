import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';

const driver = process.argv[2];
if (!driver) throw new Error('usage: node runtime/dev/integrity.test.mjs /absolute/native-host-dev-driver');
const directory = await mkdtemp(path.join(tmpdir(), 'nh-integrity-'));
const bundle = path.join(directory, 'initial.js');
await writeFile(bundle, 'globalThis.__nhDispatch = (method, params) => params.text;');
const child = spawn(driver, ['--bundle', bundle], {stdio: ['pipe', 'pipe', 'inherit']});
const responses = createInterface({input: child.stdout})[Symbol.asyncIterator]();
const exited = new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`driver exit ${code}/${signal}`)));
});
const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
let count = 0;
try {
  const request = async value => {
    child.stdin.write(`${JSON.stringify(value)}\n`);
    const response = await responses.next();
    assert.equal(response.done, false);
    return JSON.parse(response.value);
  };
  assert.equal((await request({id: 1, method: 'app.event', params: {text: 'dev.foo', method: 'dev.status'}})).result, 'dev.foo');
  const description = await request({method: 'session.describe'});
  const evaluated = await request({method: 'runtime.eval', params: {source: '"dev.foo"'}});
  if (description.result.testHooks) assert.equal(evaluated.result, 'dev.foo');
  else assert.match(evaluated.error.message, /test build/);
  for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 1024, 65537, 4 * 1024 * 1024]) {
    const bytes = Buffer.alloc(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 131 + 37) & 255;
    child.stdin.write(`${JSON.stringify({method: 'dev.hash', payloadHex: bytes.toString('hex')})}\n`);
    const {value, done} = await responses.next();
    assert.equal(done, false);
    assert.equal(JSON.parse(value).result.sha256, createHash('sha256').update(bytes).digest('hex'));
    count++;
  }
  child.stdin.end();
  await exited;
  console.log(`SHA-256 Node crosscheck passed: ${count} binary vectors, including padding/block boundaries and 4 MiB limit`);
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null) child.kill('SIGTERM');
  await rm(directory, {recursive: true, force: true});
}
