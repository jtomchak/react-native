import {readFileSync, realpathSync, statSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {root as defaultRoot} from './paths.mjs';

const reserved = new Set(['constructor', 'prototype', 'platform', 'protocolVersion', 'ready', 'call', 'on', 'dispose', 'PlatformError', 'navigation', 'chrome', 'notifications', 'links', 'share', 'biometrics', 'haptics', 'camera', 'files', 'toolbar', 'analytics']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = message => { throw new Error(`Plug-in configuration: ${message}`); };
function exact(value, allowed, label) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid(`invalid ${label}`); }
function localFile(directory, relative, {directoryOnly = false} = {}) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').includes('..')) invalid('package path must be relative and contained');
  const candidate = realpathSync(path.resolve(directory, relative));
  if (!candidate.startsWith(realpathSync(directory) + path.sep) || !(directoryOnly ? statSync(candidate).isDirectory() : statSync(candidate).isFile())) invalid('package path escapes its package or has the wrong type');
  return candidate;
}
function json(file) {
  const data = readFileSync(file); if (data.length > 65536) invalid('manifest exceeds 64 KiB');
  return JSON.parse(data.toString('utf8'));
}
function packageRoot(require, name) {
  if (typeof name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) invalid('expected an installed npm package name');
  return path.dirname(realpathSync(require.resolve(`${name}/package.json`)));
}

export function loadSelectedPlugins({root = defaultRoot, declarationFile = process.env.SPA_PLUGIN_DECLARATION_FILE ?? path.join(root, 'configuration/plugins.json'), declaration} = {}) {
  const require = createRequire(path.join(root, 'package.json'));
  const app = json(path.join(root, 'package.json'));
  const apiRoot = packageRoot(require, '@nativehost/plugin-api'), api = json(path.join(apiRoot, 'package.json'));
  if (api.name !== '@nativehost/plugin-api' || api.version !== '0.1.0') invalid('this host requires @nativehost/plugin-api 0.1.0');
  const selected = declaration ?? json(declarationFile);
  exact(selected, ['schemaVersion', 'plugins'], 'declaration');
  if (selected.schemaVersion !== 1 || !Array.isArray(selected.plugins) || selected.plugins.length > 16) invalid('unsupported declaration version or plug-in count');
  const ids = new Set(), packages = new Set(), actions = new Set(), events = new Set(), products = new Set(['nativehostpluginapi', 'spahost', 'spahosttests']), projects = new Set(['native-host-plugin-api', 'app']);
  const result = selected.plugins.map(entry => {
    exact(entry, ['package', 'configuration'], 'selected package');
    if (!Object.hasOwn(app.dependencies ?? {}, entry.package) || packages.has(entry.package)) invalid('plug-ins must be unique direct runtime dependencies');
    packages.add(entry.package);
    const directory = packageRoot(require, entry.package), pkg = json(path.join(directory, 'package.json'));
    if (pkg.name !== entry.package || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version)) invalid('package identity/version mismatch');
    const manifestFile = localFile(directory, 'native-plugin.json'), manifest = json(manifestFile);
    exact(manifest, ['schemaVersion', 'id', 'hostApiVersion', 'peer', 'client', 'react', 'server', 'configuration', 'actions', 'events', 'ios', 'android'], 'manifest');
    if (manifest.schemaVersion !== 1 || manifest.hostApiVersion !== 1 || typeof manifest.id !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(manifest.id) || reserved.has(manifest.id) || ids.has(manifest.id)) invalid('unsupported, reserved or duplicate plug-in identity');
    ids.add(manifest.id);
    if (manifest.peer !== '@nativehost/plugin-api' || pkg.peerDependencies?.[manifest.peer] !== api.version) invalid('plug-in API peer must match the installed exact version');
    if (realpathSync(path.resolve(directory, '../plugin-api')) !== apiRoot) invalid('this version requires flat sibling plug-in/API package installation (npm or Yarn Classic)');
    exact(manifest.client, ['entry', 'factory'], 'client');
    if (typeof manifest.client.factory !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(manifest.client.factory)) invalid('invalid client factory');
    const clientFile = localFile(directory, manifest.client.entry);
    if (!Array.isArray(manifest.actions) || manifest.actions.length < 1 || manifest.actions.length > 32 || !Array.isArray(manifest.events) || manifest.events.length > 16) invalid('invalid actions/events');
    for (const action of manifest.actions) {
      exact(action, ['name', 'timeoutMs'], 'action');
      if (typeof action.name !== 'string' || !action.name.startsWith(`${manifest.id}.`) || !/^[a-z][A-Za-z0-9_.]{1,63}$/.test(action.name) || actions.has(action.name) || !Number.isInteger(action.timeoutMs) || action.timeoutMs < 1 || action.timeoutMs > 120000) invalid('duplicate/invalid action or timeout');
      actions.add(action.name);
    }
    for (const event of manifest.events) {
      if (typeof event !== 'string' || !event.startsWith(`${manifest.id}.`) || !/^[a-z][A-Za-z0-9_.]{1,63}$/.test(event) || events.has(event)) invalid('duplicate/invalid event');
      events.add(event);
    }
    exact(manifest.ios, ['path', 'product', 'factory', 'testPath'], 'Swift package');
    exact(manifest.android, ['path', 'project', 'factory', 'testPath', 'testEntrypoints'], 'Android module');
    const iosRoot = localFile(directory, manifest.ios.path, {directoryOnly: true}); localFile(iosRoot, 'Package.swift');
    const androidRoot = localFile(directory, manifest.android.path, {directoryOnly: true}); localFile(androidRoot, 'build.gradle.kts');
    for (const native of [manifest.ios, manifest.android]) if (native.testPath !== undefined) localFile(directory, native.testPath, {directoryOnly: true});
    if (!/^[A-Z][A-Za-z0-9]*$/.test(manifest.ios.product) || !/^[A-Z][A-Za-z0-9]*$/.test(manifest.ios.factory) || products.has(manifest.ios.product.toLowerCase()) || path.basename(iosRoot) !== manifest.ios.product) invalid('Swift package root must uniquely match its product name');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(manifest.android.project) || !/^[a-z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(manifest.android.factory) || projects.has(manifest.android.project)) invalid('invalid/duplicate Gradle project or factory');
    products.add(manifest.ios.product.toLowerCase()); projects.add(manifest.android.project);
    if (manifest.android.testEntrypoints !== undefined) {
      if (!object(manifest.android.testEntrypoints) || !manifest.android.testPath) invalid('test entrypoints require a test source directory');
      for (const [mode, name] of Object.entries(manifest.android.testEntrypoints)) if (!(mode === manifest.id || mode.startsWith(`${manifest.id}-`)) || !/^[a-z][a-z0-9-]{0,63}$/.test(mode) || typeof name !== 'string' || !/^[a-z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(name)) invalid('invalid test mode or class');
    }
    // No alternate package-manager field or Podfile is accepted by this schema.
    for (const nativeRoot of [iosRoot, androidRoot]) if (existsSync(path.join(nativeRoot, 'Podfile'))) invalid('CocoaPods is not supported');
    // Framework/server adapters are optional. A native-only package must not
    // manufacture server routes or depend on React just to register natively.
    let serverFile;
    for (const name of ['react', 'server']) {
      if (manifest[name] === undefined) continue;
      if (manifest[name] !== `./${name}`) invalid(`expected explicit ${name} export`);
      const exported = realpathSync(require.resolve(`${entry.package}/${name}`));
      if (!exported.startsWith(directory + path.sep) || !statSync(exported).isFile()) invalid(`${name} export escapes package or is not a file`);
      if (name === 'server') serverFile = exported;
    }
    exact(manifest.configuration, ['validator'], 'configuration validator');
    if (manifest.configuration.validator !== './configuration') invalid('configuration validator must use the public export');
    const validator = require(`${entry.package}/configuration`).validateConfiguration;
    if (typeof validator !== 'function' || !object(entry.configuration)) invalid('configuration export/object required');
    const configuration = validator(entry.configuration);
    return {...manifest, package: pkg.name, version: pkg.version, root: directory, apiRoot, clientFile, serverFile, configuration, validateConfiguration: validator, manifestSha256: createHash('sha256').update(readFileSync(manifestFile)).digest('hex')};
  });
  // API v1 reserves room for host primitives in the 64-capability handshake and
  // the 32-subscription limit. Fail at selection, not on a device's first hello.
  if (actions.size > 24 || events.size > 24) invalid('API v1 supports at most 24 plug-in actions and 24 events in one host');
  return result;
}
export function publicPluginConfiguration(plugins = loadSelectedPlugins(), host = {}) {
  return Object.fromEntries(plugins.map(plugin => [plugin.id, plugin.validateConfiguration(plugin.configuration, host)]));
}
export function assembleSDKSync({root = defaultRoot, plugins = loadSelectedPlugins({root})} = {}) {
  let base = readFileSync(path.join(root, 'packages/platform-sdk/bridge.js'), 'utf8');
  const factories = plugins.map(plugin => {
    const source = readFileSync(plugin.clientFile, 'utf8');
    const prefix = `export function ${plugin.client.factory}(`;
    if (!source.startsWith(prefix) && !source.includes(`\n${prefix}`)) invalid('client export must be one standalone factory');
    // Client factories are import-free modules. Only the one leading export is
    // removed; no general-purpose transformation or package code evaluation.
    const expression = source.replace(prefix, `function ${plugin.client.factory}(`).trim();
    if (/^\s*(?:import|export)\s/m.test(expression)) invalid('browser factory must not import server/framework code');
    return `(${expression})`;
  });
  const descriptors = plugins.map(({id, actions, events}) => ({id, actions, events}));
  for (const marker of ['/* NATIVE_HOST_PLUGIN_FACTORIES */', '/* NATIVE_HOST_PLUGIN_DESCRIPTORS */']) if (base.split(marker).length !== 2) invalid('SDK assembly marker missing or duplicated');
  base = base.replace('/* NATIVE_HOST_PLUGIN_FACTORIES */', () => factories.join(',\n')).replace('/* NATIVE_HOST_PLUGIN_DESCRIPTORS */', () => descriptors.map(value => JSON.stringify(value)).join(',\n'));
  return base;
}
export async function assembleSDK(options = {}) { return assembleSDKSync(options); }
const slash = value => value.split(path.sep).join('/');
const quoted = value => JSON.stringify(slash(value));

export function pluginOutputs({root = defaultRoot, outputRoot = path.join(root, 'build/plugins'), plugins = loadSelectedPlugins({root})} = {}) {
  const require = createRequire(path.join(root, 'package.json'));
  const apiRoot = packageRoot(require, '@nativehost/plugin-api');
  const relative = target => slash(path.relative(outputRoot, target));
  const packages = {NativeHostPluginAPI: {path: relative(path.join(apiRoot, 'ios/NativeHostPluginAPI'))}};
  const dependencies = [{package: 'NativeHostPluginAPI'}];
  const testDependencies = [{package: 'NativeHostPluginAPI'}], testSources = [];
  for (const plugin of plugins) {
    packages[plugin.ios.product] = {path: relative(path.join(plugin.root, plugin.ios.path))};
    dependencies.push({package: plugin.ios.product}); testDependencies.push({package: plugin.ios.product});
    if (plugin.ios.testPath && existsSync(path.join(plugin.root, plugin.ios.testPath))) testSources.push({path: relative(localFile(plugin.root, plugin.ios.testPath, {directoryOnly: true}))});
  }
  const project = {packages, targets: {SPAHost: {dependencies, sources: [{path: 'GeneratedPluginRegistry.swift'}]}, SPAHostTests: {dependencies: testDependencies, sources: testSources}}};
  const swiftImports = ['import NativeHostPluginAPI', ...plugins.map(p => `import ${p.ios.product}`)].join('\n');
  const swiftFactories = plugins.map(p => `try ${p.ios.product}.${p.ios.factory}(environment: environment)`).join(', ');
  const expectedSwift = plugins.map(p => `${JSON.stringify(p.id)}: [${p.actions.map(a => JSON.stringify(a.name)).join(', ')}]`).join(', ');
  const swiftEvents = plugins.map(p => `${JSON.stringify(p.id)}: [${p.events.map(e => JSON.stringify(e)).join(', ')}]`).join(', ');
  const swift = `${swiftImports}\n\nenum GeneratedPluginRegistry {\n    static func make(environment: PluginEnvironment) throws -> [NativePlugin] {\n        let plugins: [NativePlugin] = [${swiftFactories}]\n        let actions: [String: Set<String>] = [${expectedSwift || ':'}]\n        let events: [String: Set<String>] = [${swiftEvents || ':'}]\n        for plugin in plugins {\n            guard Set(plugin.actions.map(\\.name)) == actions[plugin.id], Set(plugin.events) == events[plugin.id] else { throw PluginFailure("INVALID_REQUEST", "Plug-in manifest/runtime mismatch") }\n        }\n        return plugins\n    }\n}\n`;
  const androidRoot = path.join(root, 'hosts/android');
  const settings = [`// Generated. Change configuration/plugins.json, then run plugins:sync.`, `include ':native-host-plugin-api'`, `project(':native-host-plugin-api').projectDir = new File(rootDir, ${quoted(path.relative(androidRoot, path.join(apiRoot, 'android')))})`, ...plugins.flatMap(p => [`include ':${p.android.project}'`, `project(':${p.android.project}').projectDir = new File(rootDir, ${quoted(path.relative(androidRoot, path.join(p.root, p.android.path)))})`])].join('\n') + '\n';
  const app = [`// Generated dependencies and sources.`, `dependencies {`, `    implementation project(':native-host-plugin-api')`, ...plugins.map(p => `    implementation project(':${p.android.project}')`), `}`, `android.sourceSets.main.java.srcDir(new File(rootProject.projectDir, ${quoted(path.relative(androidRoot, path.join(outputRoot, 'android')))}))`, `android.sourceSets.androidTest.java.srcDir(new File(rootProject.projectDir, ${quoted(path.relative(androidRoot, path.join(outputRoot, 'androidTest')))}))`, ...plugins.filter(p => p.android.testPath && existsSync(path.join(p.root, p.android.testPath))).map(p => `android.sourceSets.androidTest.java.srcDir(new File(rootProject.projectDir, ${quoted(path.relative(androidRoot, localFile(p.root, p.android.testPath, {directoryOnly: true})))}))`)].join('\n') + '\n';
  const expectedKotlin = plugins.map(p => `${JSON.stringify(p.id)} to setOf(${p.actions.map(a => JSON.stringify(a.name)).join(', ')})`).join(', ');
  const eventsKotlin = plugins.map(p => `${JSON.stringify(p.id)} to setOf(${p.events.map(e => JSON.stringify(e)).join(', ')})`).join(', ');
  const kotlin = `package dev.spahost.prototype\n\nimport dev.nativehost.pluginapi.NativePlugin\nimport dev.nativehost.pluginapi.PluginEnvironment\nimport dev.nativehost.pluginapi.PluginFailure\n\ninternal object GeneratedPluginRegistry {\n    fun make(environment: PluginEnvironment): List<NativePlugin> {\n        val plugins: List<NativePlugin> = listOf(${plugins.map(p => `${p.android.factory}(environment)`).join(', ')})\n        val actions: Map<String, Set<String>> = mapOf(${expectedKotlin})\n        val events: Map<String, Set<String>> = mapOf(${eventsKotlin})\n        for (plugin in plugins) {\n            if (plugin.actions.map { it.name }.toSet() != actions[plugin.id] || plugin.events != events[plugin.id]) throw PluginFailure("INVALID_REQUEST", "Plug-in manifest/runtime mismatch")\n        }\n        return plugins\n    }\n}\n`;
  const serverAdapters = plugins.filter(p => p.server !== undefined);
  const imports = serverAdapters.map((p, i) => `import * as plugin${i} from ${JSON.stringify(`${p.package}/server`)};`).join('\n');
  const server = `${imports}\nexport const serverPlugins = Object.freeze({${serverAdapters.map((p, i) => `${JSON.stringify(p.id)}: plugin${i}`).join(', ')}});\n`;
  const testModes = plugins.flatMap(p => Object.entries(p.android.testEntrypoints ?? {}));
  const testRegistry = `package dev.spahost.prototype\n\ninternal object GeneratedPluginTestRegistry {\n    val modes: Map<String, String> = mapOf(${testModes.map(([mode, name]) => `${JSON.stringify(mode)} to ${JSON.stringify(name)}`).join(', ')})\n}\n`;
  const receipt = {schemaVersion: 1, hostApiVersion: 1, plugins: plugins.map(({id, package: name, version, manifestSha256, configuration}) => ({id, package: name, version, manifestSha256, configuration}))};
  return {'ios-project.yml': JSON.stringify(project, null, 2) + '\n', 'GeneratedPluginRegistry.swift': swift, 'settings.gradle': settings, 'app.gradle': app, 'android/dev/spahost/prototype/GeneratedPluginRegistry.kt': kotlin, 'androidTest/dev/spahost/prototype/GeneratedPluginTestRegistry.kt': testRegistry, 'server.mjs': server, 'plugins-lock.json': JSON.stringify(receipt, null, 2) + '\n'};
}
export function syncPlugins({root = defaultRoot, outputRoot = path.join(root, 'build/plugins'), plugins = loadSelectedPlugins({root}), check = false} = {}) {
  const outputs = pluginOutputs({root, outputRoot, plugins});
  for (const [name, content] of Object.entries(outputs)) {
    const file = path.join(outputRoot, name);
    if (check) { if (!existsSync(file) || readFileSync(file, 'utf8') !== content) invalid(`generated ${name} is stale; run plugins:sync`); }
    else {
      mkdirSync(path.dirname(file), {recursive: true});
      if (!existsSync(file) || readFileSync(file, 'utf8') !== content) {
        const temporary = `${file}.${process.pid}.tmp`;
        try { writeFileSync(temporary, content); renameSync(temporary, file); }
        finally { if (existsSync(temporary)) unlinkSync(temporary); }
      }
    }
  }
  return {plugins, outputs};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!['sync', 'check'].includes(process.argv[2])) invalid('Usage: plugins.mjs sync|check');
    const result = syncPlugins({check: process.argv[2] === 'check'});
    console.log(`${process.argv[2] === 'check' ? 'Checked' : 'Generated'} ${result.plugins.length} plug-in registrations (SwiftPM / Gradle / server).`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
