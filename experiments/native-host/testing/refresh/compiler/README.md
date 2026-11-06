# Native compiler feasibility gate

Run from the repository root:

```sh
node experiments/native-host/testing/refresh/compiler/run.mjs
```

This uses the existing macOS headless Hermes test host. `NH_HOST_BINARY` may
select another compatible macOS test host. The test copies the executable into
its own timestamped `build/refresh/` directory; it never rebuilds the shared
binary, starts Metro, or touches a device. It records host and resolved Hermes
framework hashes before/after, runtime identity, compiler/client source hashes,
every generated bundle/patch/map, negative checks, and previous run outcomes.
The framework itself remains shared and hash checked. This is correctness
evidence, not a timing benchmark.

## Compiler/runtime contract

`scripts/dev-engine.mjs` exports
`createNativeDevEngine({root, entry, runtime, onOutput, onHmrUpdates,
onAdditionalAssets, watch, transform, plugins})`. It returns the actual
Rolldown 1.3 experimental `DevEngine`; the caller owns `run()`, client
registration, delivery acknowledgments, and `close()`.

- `runtime` is source appended to the common runtime, before app modules. It
  must initialize `globalThis.__rolldown_runtime__` using `DevRuntime`. The
  fixture `gate-runtime.js` is only a small non-React test client, not a
  production Refresh boundary implementation.
- Dev mode requires `output.format: 'esm'`. A single side-effect entry with no
  external imports/exports produces a script that Hermes can evaluate. Other
  entry/output shapes are not established by this gate.
- The published common runtime contains a browser `import()` lazy-loader even
  with `lazy:false`. Hermes rejects the syntax. `nativeCommonRuntime()` adapts
  exactly that method in the published runtime SOURCE before compilation to
  throw an explicit unsupported error. It removes the module export footer so
  the source can be injected. Unexpected source shapes fail closed. No generated
  application bundle is patched, and the browser client is never injected.
- `onHmrUpdates` reports `{updates:[{clientId,update}],changedFiles}` or an Error.
  A Patch carries `{code,filename,changedIds,seq,sourcemap,sourcemapFilename}`.
  Empty or Noop notifications are possible and are recorded. FullReload is a
  distinct outcome; this test rejects it instead of disguising it as a patch.
- Patch code registers graph rows and factories. It does not refresh React or
  automatically execute changed modules. The client walks affected importers,
  invalidates affected executed caches, and initializes accepted modules.
  The gate permits reexecuting its simple entry. A real app must retain its
  renderer/bootstrap and stop at verified Refresh boundaries instead.
- Call `notifyPayloadDelivered(filename)` after registration code actually
  executes. This compiler delivery acknowledgment is separate from successful
  module evaluation, React refresh, and native mount acknowledgments.
- Await `ensureCurrentBuildFinish()` before the next controlled test edit.
  The test records irrelevant pending notifications without rewriting a source
  file or silently retrying a failed test. Runtime generation and bootstrap
  remain unchanged throughout valid updates.

## Coverage and limits

Eight successful patches exercise an exported value, newly imported dependency,
removed import, CommonJS dependency addition and change, repeated updates, and
syntax-error recovery. Assertions compare outputs in real Hermes after every
patch, check bootstrap singleton identity, and check edited source maps. Three
negative cases reproduce rejected IIFE configuration, rejected browser runtime
syntax, and compilation failure leaving the running output intact.

The initial seven-patch run passed. Subsequent expanded attempts exposed a
watcher-event timeout and a pre-client empty notification assumption; their
reports are retained. Completion synchronization and empty/Noop handling were
added, followed by consecutive passing runs. The evidence inventories these
attempts rather than keeping only green output.

This does not establish React state preservation, effect cleanup, cyclic graph
semantics, module deletion from disk, lazy chunks, native transport, asset
delivery, runtime-error rollback, or release isolation. Removed-import coverage
means graph topology changes; it does not claim garbage collection of old
module factories. Further clients must specify these behaviors explicitly.

Teardown is part of the verdict: process exit code, signal, failure latch,
forced termination, and unexpected stderr are checked. This explicit regression
fault should exit nonzero and retain a failed report even after all eight patch
checks succeed:

```sh
NH_COMPILER_GATE_CLEANUP_FAULT=kill-host node experiments/native-host/testing/refresh/compiler/run.mjs
```
