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
  assert.deepEqual(first.plugins.map(plugin => plugin.id), ['auth', 'storage']);
  assert.match(first.outputs['ios-project.yml'], /NativeHostAuth/);
  assert.match(first.outputs['app.gradle'], /native-host-auth/);
  assert.match(first.outputs['ios-project.yml'], /NativeHostStorage/);
  assert.match(first.outputs['app.gradle'], /native-host-storage/);
  assert.match(first.outputs['server.mjs'], /@nativehost\/auth\/server/);
  assert.doesNotMatch(first.outputs['server.mjs'], /@nativehost\/storage/);
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
  for (const value of Object.values(outputs)) assert.doesNotMatch(value, /NativeHostAuth|dev\.nativehost\.auth|native-host-auth|@nativehost\/auth|auth-live|NativeHostStorage|native-host-storage|@nativehost\/storage/);
  assert.match(outputs['ios-project.yml'], /NativeHostPluginAPI/);
  assert.doesNotMatch(await assembleSDK({plugins: []}), /auth\.signIn|auth\.changed|storage\.get|storage\.set|storage\.remove/);
});

test('removing only storage retains auth while a native-only selection has no server imports', async () => {
  const plugins = loadSelectedPlugins();
  const authOnly = plugins.filter(plugin => plugin.id !== 'storage');
  const outputs = pluginOutputs({plugins: authOnly});
  assert.match(outputs['GeneratedPluginRegistry.swift'], /NativeHostAuth\.AuthPlugin/);
  assert.match(outputs['server.mjs'], /@nativehost\/auth\/server/);
  for (const value of Object.values(outputs)) assert.doesNotMatch(value, /NativeHostStorage|native-host-storage|@nativehost\/storage|storage-host/);
  const sdk = await assembleSDK({plugins: authOnly});
  assert.match(sdk, /auth\.signIn/);
  assert.doesNotMatch(sdk, /storage\.get|storage\.set|storage\.remove/);
  const storage = plugins.find(plugin => plugin.id === 'storage');
  assert.equal(storage.serverFile, undefined);
  assert.deepEqual(storage.validateConfiguration({}), {});
  assert.throws(() => storage.validateConfiguration({path: '/page-supplied'}));
  assert.doesNotMatch(pluginOutputs({plugins: [storage]})['server.mjs'], /import |@nativehost/);
});

test('declarations reject duplicate, undeclared, incompatible and CocoaPods packages', async t => {
  const f = await fixture(t);
  assert.equal(loadSelectedPlugins(f).length, 1);
  assert.throws(() => loadSelectedPlugins({...f, declaration: {...f.declaration, plugins: [...f.declaration.plugins, ...f.declaration.plugins]}}), /unique/);
  assert.throws(() => loadSelectedPlugins({...f, declaration: {schemaVersion: 1, plugins: [{package: 'node:fs', configuration: {}}]}}), /runtime dependencies/);
  const original = JSON.parse(await readFile(f.manifestFile, 'utf8'));
  for (const change of [m => {m.hostApiVersion = 2;}, m => {m.id = 'camera';}, m => {m.cocoapods = 'Podfile';}, m => {m.client.entry = '../escape.js';}, m => {m.android.factory = 'Factory(); execute()';}, m => {m.android.project = 'native-host-plugin-api';}, m => {m.android.project = 'app';}, m => {m.ios.product = 'NativeHostPluginAPI';}, m => {m.actions.push(m.actions[0]);}, m => {m.events.push(m.events[0]);}, m => {m.actions[0].name = 'auth.' + 'x'.repeat(60);}, m => {m.actions = Array.from({length: 25}, (_, i) => ({name: `auth.action${i}`, timeoutMs: 1000}));}, m => {m.server = null;}, m => {m.react = '../react';}]) {
    const manifest = structuredClone(original); change(manifest); await writeFile(f.manifestFile, JSON.stringify(manifest));
    assert.throws(() => loadSelectedPlugins(f));
  }
  await writeFile(f.manifestFile, JSON.stringify(original));
  const pkgFile = path.join(f.root, 'node_modules/@nativehost/auth/package.json');
  const pkg = JSON.parse(await readFile(pkgFile)); pkg.peerDependencies['@nativehost/plugin-api'] = '9.0.0';
  await writeFile(pkgFile, JSON.stringify(pkg));
  assert.throws(() => loadSelectedPlugins(f), /peer/);
});

test('optional framework/server adapters resolve only when explicitly declared', async t => {
  const f = await fixture(t);
  const manifest = JSON.parse(await readFile(f.manifestFile));
  delete manifest.react; delete manifest.server;
  await writeFile(f.manifestFile, JSON.stringify(manifest));
  const selected = loadSelectedPlugins(f);
  assert.equal(selected[0].serverFile, undefined);
  assert.doesNotMatch(pluginOutputs({...f, plugins: selected})['server.mjs'], /@nativehost\/auth\/server/);
  manifest.server = './server';
  await writeFile(f.manifestFile, JSON.stringify(manifest));
  const target = path.join(f.root, 'outside-server.mjs'); await writeFile(target, 'export function handleRequest() {}');
  const exported = path.join(f.root, 'node_modules/@nativehost/auth/server/index.mjs');
  await rm(exported); await symlink(target, exported);
  assert.throws(() => loadSelectedPlugins(f), /server export escapes/);
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
