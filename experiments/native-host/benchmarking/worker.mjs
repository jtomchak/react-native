import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {bundleConfig} from '../scripts/bundle-config.mjs';

const config = JSON.parse(process.argv[2]);
const {engine, mode, project, output, reference, dependencies, cache} = config;
const emit = data => process.stdout.write(`${JSON.stringify(data)}\n`);
const bundleFile = path.join(output, 'app.bundle.js');
const mapFile = `${bundleFile}.map`;
await mkdir(output, {recursive: true});
let close = async () => {};
let pending = false;
let initial = true;
let buildStart = 0;
let input;
async function built(durationMs, extra = {}) {
  emit({type: 'built', bundleFile, mapFile, durationMs, initial, ...extra});
  initial = false;
}
async function fail(error) {
  emit({type: 'failure', error: error.stack || String(error)});
  process.exitCode = 1;
  input?.close();
  await close();
}

try {
  if (engine === 'rolldown') {
    const {build, watch, VERSION} = await import('rolldown');
    const options = bundleConfig({root: project, outputFile: bundleFile});
    if (mode === 'fresh') {
      const started = performance.now();
      await build(options);
      await built(performance.now() - started, {version: VERSION});
    } else {
      const watcher = watch({...options, watch: {buildDelay: 35}});
      close = () => watcher.close();
      watcher.on('change', () => { if (pending) emit({type: 'change'}); });
      watcher.on('event', event => {
        if (event.code === 'BUNDLE_START') buildStart = performance.now();
        if (event.code === 'ERROR') void fail(event.error);
        if (event.code === 'BUNDLE_END') {
          void (async () => {
            await event.result.close();
            if (initial || pending) {
              pending = false;
              await built(performance.now() - buildStart, {version: VERSION});
            }
          })().catch(fail);
        }
      });
    }
  } else if (engine === 'metro') {
    process.env.NH_BENCH_REFERENCE = reference;
    const require = createRequire(path.join(reference, 'package.json'));
    const Metro = require('metro');
    const {getDefaultConfig, mergeConfig} = require('metro-config');
    const {FileStore} = require('metro-cache');
    const metroConfig = mergeConfig(await getDefaultConfig(project), {
      projectRoot: project,
      // loadConfig normally prepends projectRoot; direct programmatic defaults
      // do not, so include it explicitly in the file-map roots.
      watchFolders: [project, dependencies, path.join(reference, 'node_modules/metro-runtime'), path.join(reference, 'node_modules/@babel/runtime')],
      maxWorkers: 4,
      fileMapCacheDirectory: path.join(cache, 'file-map'),
      cacheStores: [new FileStore({root: path.join(cache, 'transforms')})],
      reporter: {update() {}},
      resolver: {useWatchman: false, disableHierarchicalLookup: true, nodeModulesPaths: [dependencies, path.join(reference, 'node_modules')]},
      transformer: {
        babelTransformerPath: fileURLToPath(new URL('./metro-transformer.cjs', import.meta.url)),
        enableBabelRCLookup: false,
        hermesParser: true,
        asyncRequireModulePath: require.resolve('metro-runtime/src/modules/asyncRequire'),
        getTransformOptions: async () => ({transform: {experimentalImportSupport: false, inlineRequires: false}}),
      },
      serializer: {getPolyfills: () => [], getModulesRunBeforeMainModule: () => []},
    });
    const version = require('metro/package.json').version;
    if (mode === 'fresh') {
      const started = performance.now();
      await Metro.runBuild(metroConfig, {entry: 'js/entry.jsx', dev: true, minify: false, platform: 'android',
        sourceMap: true, sourceMapUrl: 'app.bundle.js.map', bundleOut: bundleFile, sourceMapOut: mapFile});
      await built(performance.now() - started, {version});
    } else {
      const service = await Metro.createConnectMiddleware(metroConfig, {watch: true, waitForBundler: true});
      const server = createServer(service.middleware);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      close = async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await service.end();
      };
      const origin = `http://127.0.0.1:${server.address().port}`;
      const query = '?platform=android&dev=true&minify=false&lazy=false&modulesOnly=false&runModule=true&excludeSource=false&inlineSourceMap=false';
      async function buildPair() {
        const started = performance.now();
        const codeResponse = await fetch(`${origin}/js/entry.bundle${query}`);
        const code = await codeResponse.text();
        if (!codeResponse.ok) throw new Error(`Metro bundle HTTP ${codeResponse.status}: ${code}`);
        const mapResponse = await fetch(`${origin}/js/entry.map${query}`);
        const map = await mapResponse.text();
        if (!mapResponse.ok) throw new Error(`Metro map HTTP ${mapResponse.status}: ${map}`);
        await Promise.all([writeFile(bundleFile, code), writeFile(mapFile, map)]);
        await built(performance.now() - started, {version, port: server.address().port});
      }
      await buildPair();
      // Version-pinned Metro graph notification; the HTTP bundle path retains
      // initializeGraph/updateGraph state. Server.build() does not do that.
      const graph = await service.metroServer.getBundler().getBundler().getDependencyGraph();
      graph.on('change', () => {
        if (!pending) return;
        pending = false;
        emit({type: 'change'});
        setImmediate(() => void buildPair().catch(fail));
      });
    }
  } else throw new Error(`Unknown engine: ${engine}`);
  if (mode === 'warm') {
    input = createInterface({input: process.stdin});
    input.on('line', line => {
      if (line === 'arm') { pending = true; emit({type: 'armed'}); }
      else if (line === 'quit') {
        input.close(); process.stdin.pause();
        void close().then(() => {
          // All watcher/server cleanup has resolved. The isolated benchmark
          // process can end even if Node's fetch pool retains idle handles.
          process.stdout.write(`${JSON.stringify({type: 'stopped'})}\n`, () => process.exit(0));
        }).catch(fail);
      }
      else void fail(new Error(`Unknown control: ${line}`));
    });
  }
} catch (error) { await fail(error); }
