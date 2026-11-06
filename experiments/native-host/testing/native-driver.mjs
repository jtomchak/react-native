import net from 'node:net';
import {expect} from '@playwright/test';

// A native automation transport, not a Playwright browser/Page wrapper.
export class NativeDriver {
  pending = new Map();
  sequence = 0;
  buffer = '';
  trace = [];
  failure = null;
  record(event) {
    this.trace.push({...event, at: Date.now()});
    if (this.trace.length > 256) this.trace.shift();
  }
  static async connect({port, token}) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof token !== 'string' || token.length < 32) throw new Error('Invalid local test-driver configuration');
    const driver = new NativeDriver();
    driver.socket = net.createConnection({host: '127.0.0.1', port});
    driver.socket.setNoDelay(true);
    driver.socket.setEncoding('utf8');
    await new Promise((resolve, reject) => {
      driver.socket.once('connect', resolve);
      driver.socket.once('error', reject);
    });
    driver.socket.on('data', data => driver.receive(data));
    driver.socket.on('error', error => driver.fail(error));
    driver.socket.on('close', () => driver.fail(new Error('Native driver disconnected')));
    try { await driver.call('session.authenticate', {token}); }
    catch (error) { driver.socket.destroy(); throw error; }
    return driver;
  }
  fail(error) {
    this.failure ??= error;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  receive(data) {
    this.buffer += data;
    if (this.buffer.length > 8 * 1024 * 1024) { this.fail(new Error('Oversized native driver response')); this.socket.destroy(); return; }
    for (let end; (end = this.buffer.indexOf('\n')) >= 0;) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { this.fail(new Error('Invalid native driver JSON')); this.socket.destroy(); return; }
      const item = this.pending.get(message.id);
      if (!item) { this.fail(new Error('Unexpected native driver response ID')); this.socket.destroy(); return; }
      this.pending.delete(message.id);
      clearTimeout(item.timer);
      this.record({id: message.id, method: item.method, outcome: message.error ? 'error' : 'response'});
      if (message.error) item.reject(new Error(typeof message.error === 'string' ? message.error : JSON.stringify(message.error)));
      else item.resolve(message.result);
    }
  }
  call(method, params = {}) {
    if (this.socket.destroyed) return Promise.reject(this.failure || new Error('Native driver is closed'));
    const id = ++this.sequence;
    this.record({id, method, outcome: 'request'});
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Native driver timed out: ${method}`);
        this.record({id, method, outcome: 'timeout'});
        reject(error);
        this.fail(error);
        this.socket.destroy();
      }, 20000);
      this.pending.set(id, {resolve, reject, timer, method});
      this.socket.write(`${JSON.stringify({id, method, params})}\n`);
    });
  }
  async close() {
    if (this.socket.destroyed) return;
    try { await this.call('session.close'); } finally { this.socket.destroy(); }
  }
}

export class NativeApp {
  constructor(driver) { this.driver = driver; }
  describe() { return this.driver.call('session.describe'); }
  async health() {
    const result = await this.driver.call('session.health');
    if (result.healthy !== true) throw new Error(`Native runtime unhealthy: ${JSON.stringify(result)}`);
    return result;
  }
  snapshot() { return this.driver.call('ui.snapshot'); }
  dismissKeyboard() { return this.driver.call('ui.dismissKeyboard'); }
  getByTestId(testID) {
    const driver = this.driver;
    if (typeof testID !== 'string' || !testID) throw new Error('A nonempty testID is required');
    return {
      async tap() {
        // The backend re-resolves the native target immediately before input.
        const result = await driver.call('ui.tap', {testID});
        if (!result.performed) throw new Error(`Tap not performed: ${testID}`);
        return result;
      },
      fill: text => driver.call('ui.type', {testID, text, clear: true}),
      textContent: async () => (await driver.call('ui.text', {testID})).text,
      async waitFor({state = 'visible'} = {}) {
        if (state !== 'visible') throw new Error(`Unsupported native wait state: ${state}`);
        await expect.poll(async () => {
          const target = await driver.call('ui.find', {testID});
          return target.exists !== false && (target.visible ?? target.hittable ?? false);
        }).toBe(true);
      },
    };
  }
  webView(testID) {
    const driver = this.driver;
    return {
      async attach() {
        const target = await driver.call('ui.find', {testID});
        if (target.exists === false) throw new Error(`WebView missing: ${testID}`);
        return {
          // Native points for a controlled fixture. DOM selectors are a separate,
          // capability-negotiated adapter; no silent HTMLElement.click fallback.
          tapAt: ({x, y}) => driver.call('webview.tap', {testID, x, y}),
          evaluate: source => driver.call('webview.evaluate', {testID, source}),
        };
      },
    };
  }
}
