// Deliberately small NON-REACT gate client. Entries may rerun here; a real app
// client must stop at Refresh boundaries instead of rerunning its bootstrap.
globalThis.__gateBootstrapCount = (globalThis.__gateBootstrapCount || 0) + 1;
globalThis.__rolldown_runtime__ = new DevRuntime('native-compiler-gate');
globalThis.__rolldown_runtime__.hooks = {
  createModuleHotContext() { return {accept() {}}; },
  onModuleCacheRemoval() {},
};
globalThis.__gateSequence = 0;
globalThis.__gateApply = function(changedIds, sequence) {
  if (sequence !== globalThis.__gateSequence + 1) throw new Error('Noncontiguous patch sequence');
  const runtime = globalThis.__rolldown_runtime__;
  const affected = new Set(changedIds);
  const pending = [...affected];
  for (const id of pending) {
    for (const importer of runtime.getImporters(id)) {
      if (!affected.has(importer)) { affected.add(importer); pending.push(importer); }
    }
  }
  const executed = pending.filter(id => runtime.isExecuted(id));
  for (const id of executed) {
    if (!runtime.hasFactory(id)) throw new Error(`Missing affected factory: ${id}`);
  }
  for (const id of executed) runtime.removeModuleCache(id);
  for (const id of executed) runtime.initModule(id);
  globalThis.__gateSequence = sequence;
  return {affected: pending, executed, result: globalThis.__gateResult,
    bootstrapCount: globalThis.__gateBootstrapCount};
};
