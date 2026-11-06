import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {root} from './paths.mjs';
import {loadSelectedPlugins, pluginOutputs} from './plugins.mjs';
const run = promisify(execFile);
const output = path.join(root, 'build/plugin-pack');
await mkdir(output, {recursive: true});
const packages = [];
for (const name of ['plugin-api', 'auth']) {
  const result = await run('npm', ['pack', `./packages/${name}`, '--pack-destination', output, '--json'], {cwd: root});
  const [packed] = JSON.parse(result.stdout);
  const forbidden = packed.files.filter(file => /(^|\/)(node_modules|build|\.build|\.gradle|evidence)(\/|$)|\.(sqlite|png|p12|mobileprovision)$/.test(file.path));
  if (forbidden.length) throw new Error('Package contains build/private artifacts');
  packages.push({name: packed.name, file: path.join(output, packed.filename), integrity: packed.integrity, files: packed.files.length});
}
const temporary = await mkdtemp(path.join(os.tmpdir(), 'nativehost-consumer-'));
try {
  await writeFile(path.join(temporary, 'package.json'), JSON.stringify({name: 'nativehost-consumer-smoke', version: '0.0.0', private: true, type: 'module'}));
  await run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', ...packages.map(pkg => pkg.file)], {cwd: temporary});
  const declaration = {schemaVersion: 1, plugins: [{package: '@nativehost/auth', configuration: {enabled: false, origin: null, providers: [], rpId: null}}]};
  const selected = loadSelectedPlugins({root: temporary, declaration});
  const outputs = pluginOutputs({root: temporary, plugins: selected});
  if (!outputs['ios-project.yml'].includes('NativeHostAuth') || !outputs['settings.gradle'].includes('native-host-auth')) throw new Error('Installed native package did not resolve');
  const script = `
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    import {installAuth} from '@nativehost/auth/client';
    import {AuthService, authService} from '@nativehost/auth/server';
    const require = createRequire(import.meta.url);
    assert.ok(require.resolve('@nativehost/auth/react').endsWith('react/index.jsx'));
    assert.ok(require.resolve('@nativehost/auth/manifest').endsWith('native-plugin.json'));
    class PlatformError extends Error {constructor(code,message){super(message);this.code=code;}}
    const plugin = installAuth({PlatformError, call: async () => ({authenticated:false,configured:false})});
    assert.deepEqual(await plugin.namespace.status(), {authenticated:false,configured:false});
    assert.equal(typeof AuthService, 'function');
    assert.equal(await authService(), null);
    console.log('client/server/react/native exports resolved outside source checkout');
  `;
  await writeFile(path.join(temporary, 'smoke.mjs'), script);
  const environment = {...process.env}; delete environment.SPA_AUTH_CONFIG_FILE;
  const result = await run(process.execPath, ['smoke.mjs'], {cwd: temporary, env: environment});
  const auth = selected[0];
  await run('/usr/bin/xcrun', ['swift', 'package', '--package-path', path.join(auth.root, auth.ios.path), 'dump-package'], {env: {...process.env, DEVELOPER_DIR: '/Applications/Xcode.RC.app/Contents/Developer'}});
  const receipt = {schemaVersion: 1, packages: packages.map(({file, ...pkg}) => pkg), consumer: 'isolated npm tarball installation', result: 'passed', checks: ['artifact allowlist', 'offline peer/dependency resolution', 'client/server execution', 'React/manifest exports', 'SwiftPM manifest and peer path', 'Gradle source resolution']};
  await writeFile(path.join(output, 'report.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(result.stdout.trim()); console.log('Package installation smoke test passed. Receipt: build/plugin-pack/report.json');
} finally { await rm(temporary, {recursive: true, force: true}); }
