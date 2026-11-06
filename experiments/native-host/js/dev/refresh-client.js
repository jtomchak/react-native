import Refresh from 'react-refresh/runtime';

// Bundled once into the compiler's permanent runtime, outside its update graph.
export function installNativeRefreshRuntime(DevRuntime, {clientId, applicationPrefix = 'application/'}) {
  if (globalThis.__nhApplyDevUpdate) throw new Error('Native Refresh bootstrap already installed');
  Refresh.injectIntoGlobalHook(globalThis);
  const runtime = new DevRuntime(clientId);
  const modules = new Map();
  const renderers = new Set();
  let lastAppliedSequence = 0;
  let poisoned = false;
  runtime.hooks = {
    createModuleHotContext() { return {accept() { throw new Error('Manual HMR acceptance is unsupported'); }}; },
    onModuleCacheRemoval() {},
  };
  globalThis.__rolldown_runtime__ = runtime;
  globalThis.__nhDevRegister = (moduleId, type, localId) => Refresh.register(type, `${moduleId} ${localId}`);
  globalThis.__nhDevSignature = Refresh.createSignatureFunctionForTransform;
  globalThis.__nhRegisterRefreshRenderer = reconciler => {
    if (renderers.has(reconciler)) throw new Error('Refresh renderer already attached');
    if (renderers.size) throw new Error('Only one permanent renderer is supported');
    // The reconciler return value indicates the DevTools DCE check, not whether
    // Refresh received the renderer. Verify the actual hook injection instead.
    const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const inject = hook.inject;
    let injected;
    hook.inject = function(internals) { injected = internals; return inject.call(this, internals); };
    try { reconciler.injectIntoDevTools(); } finally { hook.inject = inject; }
    if (!injected || typeof injected.scheduleRefresh !== 'function' ||
        typeof injected.setRefreshHandler !== 'function') throw new Error('Refresh renderer injection failed');
    renderers.add(reconciler);
  };
  globalThis.__nhDevModuleDone = moduleId => {
    const exports = runtime.loadExports(moduleId);
    const values = Refresh.isLikelyComponentType(exports) ? [['%exports%', exports]] :
      exports && typeof exports === 'object' ? Object.keys(exports).filter(key => key !== '__esModule').sort().map(key => [key, exports[key]]) : [];
    for (const [key, value] of values) Refresh.register(value, `${moduleId} %export% ${key}`);
    modules.set(moduleId, {
      boundary: values.length > 0 && values.every(([, value]) => Refresh.isLikelyComponentType(value)),
      keys: values.map(([key]) => key),
      families: values.map(([, value]) => Refresh.getFamilyByType(value)),
    });
  };
  const fail = (status, reason) => { poisoned = true; return {status, reason: String(reason).slice(0, 2048)}; };
  globalThis.__nhApplyDevUpdate = metadata => {
    if (poisoned) return {status: 'reload-required', reason: 'Previous update invalidated this session'};
    if (!metadata || metadata.schemaVersion !== 1 || !Number.isSafeInteger(metadata.sequence) ||
        metadata.sequence <= lastAppliedSequence || !Array.isArray(metadata.changedIds) ||
        metadata.changedIds.length < 1 || metadata.changedIds.length > 128 ||
        metadata.changedIds.some(id => typeof id !== 'string' || id.length > 4096)) {
      return fail('error', 'Invalid update metadata');
    }
    const affected = new Set(), boundaries = new Map(), walking = new Set();
    function visit(id) {
      if (!runtime.staticImports.has(id) && !runtime.hasFactory(id)) throw new Error(`Unknown changed module: ${id}`);
      if (!id.startsWith(applicationPrefix) || runtime.isEntry(id)) throw new Error(`Permanent bootstrap reached: ${id}`);
      if (walking.has(id)) throw new Error(`Cyclic propagation is unsupported: ${id}`);
      if (affected.has(id) || !runtime.isExecuted(id)) return;
      if (affected.size >= 256) throw new Error('Update propagation limit exceeded');
      if (!runtime.hasFactory(id)) throw new Error(`Missing module factory: ${id}`);
      affected.add(id);
      const previous = modules.get(id);
      if (previous?.boundary) { boundaries.set(id, previous); return; }
      const importers = runtime.getImporters(id);
      if (!importers.length) throw new Error(`No accepting component boundary: ${id}`);
      walking.add(id);
      for (const importer of importers) visit(importer);
      walking.delete(id);
    }
    try { for (const id of new Set(metadata.changedIds)) visit(id); }
    catch (error) { return fail('reload-required', error.message); }
    try {
      for (const id of affected) runtime.removeModuleCache(id);
      for (const id of affected) runtime.initModule(id);
      for (const [id, previous] of boundaries) {
        const next = modules.get(id);
        if (!next?.boundary || previous.keys.length !== next.keys.length ||
            previous.keys.some((key, i) => key !== next.keys[i] || previous.families[i] !== next.families[i])) {
          return fail('reload-required', `Component boundary exports changed: ${id}`);
        }
      }
      Refresh.performReactRefresh();
      lastAppliedSequence = metadata.sequence;
      return {status: 'applied'};
    } catch (error) { return fail('error', error?.stack || error); }
  };
  globalThis.__nhDevRefreshState = () => ({lastAppliedSequence, poisoned, renderers: renderers.size,
    mountedRoots: Refresh._getMountedRootCount(), modules: [...modules].map(([id, value]) => ({id, boundary: value.boundary, keys: value.keys}))});
}
