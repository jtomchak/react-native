import {dev} from 'rolldown/experimental';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export async function nativeCommonRuntime() {
  const source = await readFile(new URL(import.meta.resolve('rolldown/experimental/runtime')), 'utf8');
  // Adapt the published runtime source BEFORE compilation. Hermes cannot parse
  // the browser import() in this method, even when lazy compilation is disabled.
  // Fail closed if an upgrade changes this precise unsupported loader.
  const browserLoader = /loadLazyChunk\(proxyModuleId\) \{\s*return import\([\s\S]*?\);\s*\}/g;
  if ([...source.matchAll(browserLoader)].length !== 1) throw new Error('Rolldown lazy loader source changed');
  const adapted = source.replace(browserLoader,
    'loadLazyChunk() { throw new Error("Native dev gate does not support lazy chunks"); }')
    .replace(/export \{ DevRuntime, MissingFactoryError \};\s*$/, '');
  if (adapted === source || /\bimport\s*\(/.test(adapted.replace(/\/\*[\s\S]*?\*\//g, ''))) {
    throw new Error('Unexpected native common-runtime adaptation');
  }
  const sha = text => createHash('sha256').update(text).digest('hex');
  return {source: adapted, originalSha256: sha(source), adaptedSha256: sha(adapted)};
}

// Experimental compiler adapter only. The caller owns transport, the native
// module client, and delivery acknowledgments. No browser runtime is installed.
export async function createNativeDevEngine({root, entry, runtime, onOutput,
  onHmrUpdates, onAdditionalAssets = () => {}, watch = true, transform, plugins = []}) {
  const common = await nativeCommonRuntime();
  return dev({
    cwd: root,
    input: entry,
    platform: 'neutral',
    transform, plugins,
    experimental: {devMode: {implement: `${common.source}\n${runtime}`, lazy: false,
      skipCommonRuntimeInjection: true}},
  }, {
    format: 'esm', sourcemap: true,
  }, {
    watch: {enabled: watch, skipWrite: true},
    rebuildStrategy: 'never',
    onOutput, onHmrUpdates, onAdditionalAssets,
  });
}
