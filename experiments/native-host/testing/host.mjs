import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {test as base, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export class Host {
  sequence = 0;
  pending = new Map();
  stderr = '';
  constructor({bundle = path.join(root, 'build/app.bundle.js')} = {}) {
    this.process = spawn(process.env.NH_HOST_BINARY || path.join(root, 'build/headless/native-host'), ['--bundle', bundle], {cwd: root});
    this.process.stderr.on('data', bytes => { this.stderr += bytes; });
    createInterface({input: this.process.stdout}).on('line', line => {
      let response;
      try { response = JSON.parse(line); } catch { this.fail(new Error(`Non-protocol stdout: ${line}`)); return; }
      const item = this.pending.get(response.id);
      if (!item) { this.fail(new Error(`Unexpected response: ${line}`)); return; }
      this.pending.delete(response.id);
      clearTimeout(item.timer);
      if (response.error) item.reject(new Error(JSON.stringify(response.error)));
      else if (Array.isArray(response.result?.errors) && response.result.errors.length) item.reject(new Error(`Asynchronous native host failure: ${response.result.errors.join('\n')}`));
      else item.resolve(response.result);
    });
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', (code, signal) => this.fail(new Error(`Native host exited ${code ?? signal}: ${this.stderr}`)));
  }
  fail(error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  call(method, params = {}) {
    if (this.process.exitCode !== null || this.process.killed) return Promise.reject(new Error(`Host not running: ${this.stderr}`));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out: ${method}\n${this.stderr}`)); }, 10000);
      this.pending.set(id, {resolve, reject, timer});
      this.process.stdin.write(`${JSON.stringify({id, method, params})}\n`);
    });
  }
  async wait(method, params, predicate) {
    let latest;
    await expect.poll(async () => {
      await this.call('runtime.pump');
      latest = await this.call(method, params);
      return predicate(latest);
    }, {timeout: 5000}).toBe(true);
    return latest;
  }
  async stop() {
    if (this.process.exitCode !== null) return;
    const exited = new Promise(resolve => this.process.once('exit', resolve));
    this.process.stdin.end();
    const timer = setTimeout(() => this.process.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(timer);
  }
}

export function nodeByID(tree, testID) {
  for (const node of tree.children || []) {
    if (node.props.testID === testID) return node;
    const found = nodeByID(node, testID);
    if (found) return found;
  }
  return null;
}
export function textOf(node) {
  if (!node) return '';
  return node.type === '#text' ? node.props.text : node.children.map(textOf).join('');
}
export const test = base.extend({
  host: async ({}, use, testInfo) => {
    const host = new Host();
    try {
      const identity = await host.call('session.describe');
      await testInfo.attach('runtime-identity', {body: JSON.stringify(identity, null, 2), contentType: 'application/json'});
      await use(host);
      await host.call('runtime.pump');
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('native-stderr', {body: host.stderr, contentType: 'text/plain'});
        try { await testInfo.attach('diagnostics', {body: JSON.stringify(await host.call('diagnostics.capture'), null, 2), contentType: 'application/json'}); } catch {}
      }
      await host.stop();
    }
  },
});
export {expect};
