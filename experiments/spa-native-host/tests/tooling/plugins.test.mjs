import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, cp, writeFile, readFile, rm, stat, symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {loadSelectedPlugins, syncPlugins, pluginOutputs, assembleSDK} from '../../tooling/plugins.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'native-plugin-'));
  t.after(() => rm(temporary, {recursive: true, force: true}));
  await mkdir(path.join(temporary, 'node_modules/@nativehost'), {recursive: true});
  for (const name of ['auth', 'plugin-api']) await cp(path.join(root, 'packages', name), path.join(temporary, 'node_modules/@nativehost', name), {recursive: true, filter: source => !['node_modules', 'build', '.build', '.gradle', '.swiftpm'].some(part => source.split(path.sep).includes(part))});
  await writeFile(path.join(temporary, 'package.json'), JSON.stringify({name: 'host-fixture', dependencies: {'@nativehost/auth': '0.1.0', '@nativehost/plugin-api': '0.1.0'}}));
  const declaration = {schemaVersion: 1, plugins: [{package: '@nativehost/auth', configuration: {enabled: false, origin: null, providers: [], rpId: null}}]};
  const manifestFile = path.join(temporary, 'node_modules/@nativehost/auth/native-plugin.json');
  return {root: temporary, declaration, manifestFile};
}

test('one selection deterministically generates native, client and server registrations', async t => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'plugin-output-'));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const first = syncPlugins({outputRoot});
  assert.equal(first.plugins[0].id, 'auth');
  assert.match(first.outputs['ios-project.yml'], /NativeHostAuth/);
  assert.match(first.outputs['app.gradle'], /native-host-auth/);
  assert.match(first.outputs['server.mjs'], /@nativehost\/auth\/server/);
  assert.match(first.outputs['androidTest/dev/spahost/prototype/GeneratedPluginTestRegistry.kt'], /auth-live/);
  const before = (await stat(path.join(outputRoot, 'server.mjs'))).mtimeMs;
  syncPlugins({outputRoot});
  assert.equal((await stat(path.join(outputRoot, 'server.mjs'))).mtimeMs, before);
  assert.doesNotThrow(() => syncPlugins({outputRoot, check: true}));
  await writeFile(path.join(outputRoot, 'server.mjs'), 'stale');
  assert.throws(() => syncPlugins({outputRoot, check: true}), /stale/);
});

test('removing selection erases auth imports, native factories, callback module and server registration', async () => {
  const outputs = pluginOutputs({plugins: []});
  for (const value of Object.values(outputs)) assert.doesNotMatch(value, /NativeHostAuth|dev\.nativehost\.auth|native-host-auth|@nativehost\/auth|auth-live/);
  assert.match(outputs['ios-project.yml'], /NativeHostPluginAPI/);
  assert.doesNotMatch(await assembleSDK({plugins: []}), /auth\.signIn|auth\.changed/);
});

test('declarations reject duplicate, undeclared, incompatible and CocoaPods packages', async t => {
  const f = await fixture(t);
  assert.equal(loadSelectedPlugins(f).length, 1);
  assert.throws(() => loadSelectedPlugins({...f, declaration: {...f.declaration, plugins: [...f.declaration.plugins, ...f.declaration.plugins]}}), /unique/);
  assert.throws(() => loadSelectedPlugins({...f, declaration: {schemaVersion: 1, plugins: [{package: 'node:fs', configuration: {}}]}}), /runtime dependencies/);
  const original = JSON.parse(await readFile(f.manifestFile, 'utf8'));
  for (const change of [m => {m.hostApiVersion = 2;}, m => {m.id = 'storage';}, m => {m.cocoapods = 'Podfile';}, m => {m.client.entry = '../escape.js';}, m => {m.android.factory = 'Factory(); execute()';}, m => {m.android.project = 'native-host-plugin-api';}, m => {m.android.project = 'app';}, m => {m.ios.product = 'NativeHostPluginAPI';}, m => {m.actions.push(m.actions[0]);}, m => {m.events.push(m.events[0]);}, m => {m.actions[0].name = 'auth.' + 'x'.repeat(60);}, m => {m.actions = Array.from({length: 25}, (_, i) => ({name: `auth.action${i}`, timeoutMs: 1000}));}]) {
    const manifest = structuredClone(original); change(manifest); await writeFile(f.manifestFile, JSON.stringify(manifest));
    assert.throws(() => loadSelectedPlugins(f));
  }
  await writeFile(f.manifestFile, JSON.stringify(original));
  const pkgFile = path.join(f.root, 'node_modules/@nativehost/auth/package.json');
  const pkg = JSON.parse(await readFile(pkgFile)); pkg.peerDependencies['@nativehost/plugin-api'] = '9.0.0';
  await writeFile(pkgFile, JSON.stringify(pkg));
  assert.throws(() => loadSelectedPlugins(f), /peer/);
});

test('package path symlinks cannot escape into arbitrary application files', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'outside.mjs'); await writeFile(target, 'export function installAuth(){}');
  const linked = path.join(f.root, 'node_modules/@nativehost/auth/client/escape.mjs'); await symlink(target, linked);
  const manifest = JSON.parse(await readFile(f.manifestFile)); manifest.client.entry = 'client/escape.mjs'; await writeFile(f.manifestFile, JSON.stringify(manifest));
  assert.throws(() => loadSelectedPlugins(f), /escapes/);
});

test('browser factory assembly preserves literal replacement characters', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plugin-factory-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const clientFile = path.join(directory, 'client.mjs');
  await writeFile(clientFile, 'export function installAuth(){ return {namespace: {literal: "$&"}}; }');
  const [plugin] = loadSelectedPlugins();
  const source = await assembleSDK({plugins: [{...plugin, clientFile}]});
  assert.match(source, /literal: "\$&"/);
  assert.doesNotMatch(source, /NATIVE_HOST_PLUGIN_FACTORIES/);
});
