import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {root} from './paths.mjs';
import {loadSelectedPlugins, pluginOutputs} from './plugins.mjs';
const run = promisify(execFile);
const output = path.join(root, 'build/plugin-pack');
await mkdir(output, {recursive: true});
await rm(path.join(output, 'report.json'), {force: true});
const sourceSelection = loadSelectedPlugins();
const require = createRequire(path.join(root, 'package.json'));
const apiRoot = path.dirname(require.resolve('@nativehost/plugin-api/package.json'));
const packages = [];
for (const directory of [apiRoot, ...sourceSelection.map(plugin => plugin.root)]) {
  const result = await run('npm', ['pack', directory, '--pack-destination', output, '--json'], {cwd: root});
  const [packed] = JSON.parse(result.stdout);
  const forbidden = packed.files.filter(file => /(^|\/)(node_modules|build|\.build|\.gradle|evidence)(\/|$)|\.(sqlite|png|p12|mobileprovision)$/.test(file.path));
  if (forbidden.length) throw new Error('Package contains build/private artifacts');
  packages.push({name: packed.name, file: path.join(output, packed.filename), integrity: packed.integrity, files: packed.files.length});
}
const temporary = await mkdtemp(path.join(os.tmpdir(), 'nativehost-consumer-'));
try {
  await writeFile(path.join(temporary, 'package.json'), JSON.stringify({name: 'nativehost-consumer-smoke', version: '0.0.0', private: true, type: 'module'}));
  await run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', ...packages.map(pkg => pkg.file)], {cwd: temporary});
  const declaration = {schemaVersion: 1, plugins: sourceSelection.map(plugin => ({package: plugin.package, configuration: plugin.configuration}))};
  const selected = loadSelectedPlugins({root: temporary, declaration});
  const outputs = pluginOutputs({root: temporary, plugins: selected});
  for (const plugin of selected) {
    if (!outputs['ios-project.yml'].includes(plugin.ios.product) || !outputs['settings.gradle'].includes(plugin.android.project)) throw new Error('Installed native package did not resolve');
  }
  const script = `
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    const require = createRequire(import.meta.url);
    class PlatformError extends Error {constructor(code,message){super(message);this.code=code;}}
    const namespaces = {};
    const values = new Map();
    for (const selection of ${JSON.stringify(selected.map(({package: name, client, react, server, actions}) => ({name, client, react, server, actions})))}) {
      assert.ok(require.resolve(selection.name + '/manifest').endsWith('native-plugin.json'));
      if (selection.react) assert.ok(require.resolve(selection.name + '/react'));
      if (selection.server) assert.equal(typeof (await import(selection.name + '/server')).handleRequest, 'function');
      const client = await import(selection.name + '/client');
      const installed = client[selection.client.factory]({PlatformError, call: async (action, args) => {
        assert.ok(selection.actions.some(item => item.name === action));
        if (action === 'storage.get') return values.get(args.key) ?? null;
        if (action === 'storage.set') {values.set(args.key, args.value); return null;}
        if (action === 'storage.remove') {values.delete(args.key); return null;}
        return {authenticated:false,configured:false};
      }});
      assert.equal(typeof installed.namespace, 'object');
      namespaces[selection.name] = installed.namespace;
    }
    if (namespaces['@nativehost/auth']) {
      assert.deepEqual(await namespaces['@nativehost/auth'].status(), {authenticated:false,configured:false});
      const server = await import('@nativehost/auth/server');
      assert.equal(typeof server.AuthService, 'function');
      assert.equal(await server.authService(), null);
    }
    if (namespaces['@nativehost/storage']) {
      const storage = namespaces['@nativehost/storage'];
      assert.equal(await storage.set('packed', 'scalar value'), null);
      assert.equal(await storage.get('packed'), 'scalar value');
      assert.equal(await storage.remove('packed'), null);
      assert.equal(await storage.get('packed'), null);
      assert.throws(() => require.resolve('@nativehost/storage/server'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
      assert.throws(() => require.resolve('@nativehost/storage/react'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
    }
    console.log('client/server/react/native exports resolved outside source checkout');
  `;
  await writeFile(path.join(temporary, 'smoke.mjs'), script);
  const environment = {...process.env}; delete environment.SPA_AUTH_CONFIG_FILE;
  const result = await run(process.execPath, ['smoke.mjs'], {cwd: temporary, env: environment});
  for (const plugin of selected) await run('/usr/bin/xcrun', ['swift', 'package', '--package-path', path.join(plugin.root, plugin.ios.path), 'dump-package'], {env: {...process.env, DEVELOPER_DIR: '/Applications/Xcode.RC.app/Contents/Developer'}});
  const receipt = {schemaVersion: 1, packages: packages.map(({file, ...pkg}) => pkg), consumer: 'isolated npm tarball installation', result: 'passed', checks: ['artifact allowlist', 'offline peer/dependency resolution', 'client/server execution', 'React/manifest exports', 'SwiftPM manifest and peer path', 'Gradle source resolution']};
  await writeFile(path.join(output, 'report.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(result.stdout.trim()); console.log('Package installation smoke test passed. Receipt: build/plugin-pack/report.json');
} finally { await rm(temporary, {recursive: true, force: true}); }
