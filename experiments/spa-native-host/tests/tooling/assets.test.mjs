import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assetPath} from '../../tooling/paths.mjs';
import {manifest} from '../../tooling/sync.mjs';
import {createAssetServer} from '../../tooling/serve.mjs';

test('asset resolver rejects traversal and accepts root, query-free Next assets', () => {
  assert.equal(assetPath('/tmp/web', '/'), '/tmp/web/index.html');
  assert.equal(assetPath('/tmp/web', '/compose/'), '/tmp/web/compose/index.html');
  assert.equal(assetPath('/tmp/web', '/_next/static/chunk.js'), '/tmp/web/_next/static/chunk.js');
  for (const input of ['/../secret', '/%2e%2e/secret', '/x/./file', '/x\\file', '/%00', '/%zz', 'relative']) assert.equal(assetPath('/tmp/web', input), null);
});

test('manifest hashes bytes, is deterministic and refuses symlinks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spa-assets-'));
  try {
    await writeFile(path.join(root, 'index.html'), 'hello');
    const a = await manifest(root); const b = await manifest(root);
    assert.deepEqual(a, b);
    assert.equal(a.assets['/index.html'].bytes, 5);
    assert.equal(a.assets['/index.html'].sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    await symlink('index.html', path.join(root, 'alias'));
    await assert.rejects(manifest(root), /Symlink refused/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('packaged asset server serves direct routes and fails missing paths closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spa-http-'));
  await mkdir(path.join(root, 'compose'));
  await writeFile(path.join(root, 'compose/index.html'), '<h1>Compose</h1>');
  const server = createAssetServer(root);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const route = await fetch(`${origin}/compose/?draft=1`);
    assert.equal(route.status, 200); assert.equal(await route.text(), '<h1>Compose</h1>');
    assert.equal((await fetch(`${origin}/unknown/`)).status, 404);
    assert.equal((await fetch(`${origin}/compose/`, {method: 'POST'})).status, 405);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, {recursive: true, force: true});
  }
});
