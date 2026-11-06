import net from 'node:net';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NativeApp, NativeDriver} from './native-driver.mjs';

test('transport preserves a Unicode code point split across TCP chunks', async () => {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let input = '';
    socket.on('data', data => {
      input += data;
      for (let end; (end = input.indexOf('\n')) >= 0;) {
        const request = JSON.parse(input.slice(0, end));
        input = input.slice(end + 1);
        if (request.method === 'session.authenticate') socket.write(JSON.stringify({id: request.id, result: {authenticated: true}}) + '\n');
        else {
          const response = Buffer.from(JSON.stringify({id: request.id, result: {text: 'Native 🦀 ✓'}}) + '\n');
          const split = response.indexOf(Buffer.from('🦀')) + 2;
          socket.write(response.subarray(0, split));
          setTimeout(() => socket.write(response.subarray(split)), 10);
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let driver;
  try {
    driver = await NativeDriver.connect({port: server.address().port, token: 'test-only-token'.repeat(3)});
    assert.equal((await driver.call('ui.text')).text, 'Native 🦀 ✓');
  } finally {
    driver?.socket.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

test('native tap requires a performed action and health requires an explicit pass', async () => {
  const app = new NativeApp({call: async () => ({delivered: true})});
  await assert.rejects(app.getByTestId('button').tap(), /Tap not performed/);
  await assert.rejects(app.health(), /Native runtime unhealthy/);
  const good = new NativeApp({call: async () => ({performed: true, healthy: true})});
  await good.getByTestId('button').tap();
  await good.health();
});
