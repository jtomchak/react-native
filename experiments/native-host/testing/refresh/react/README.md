# React Refresh gates

```sh
node experiments/native-host/testing/refresh/react/run.mjs
node experiments/native-host/testing/refresh/react/ingress.mjs
node --test experiments/native-host/testing/refresh/react/publisher.test.mjs
```

`run.mjs` executes genuine Rolldown updates in the embedded Hermes test host.
The seventeen checks cover seeded state and controlled input, `useRef` and public
node identity, handler replacement, effect cleanup, noncomponent dependency
propagation, import addition/removal, CommonJS updates, nested factories with
the same local component name, pending services/subscriptions, syntax-error/fix,
hook-signature remounting, mixed-export rejection, permanent-entry reach,
initialization errors, forward attempt-sequence gaps, stale sequences, and
unknown module IDs. Related assertions are grouped into check records.

`ingress.mjs` uses the dedicated native update API with `NH_TEST_HOOKS=OFF`.
It pins a private driver and Hermes framework, confirms the loaded framework
path, records hashes, and exercises actual preparation/evaluation/Refresh/mount
acknowledgments. Its narrow fixture observations use `app.event`; arbitrary
`runtime.eval` remains disabled. This gate has eight grouped checks.

Receipts and all generated patches/maps remain in timestamped `build/refresh/`
directories, including failed attempts. The first React attempt incorrectly
treated `reconciler.injectIntoDevTools()`'s return value as injection success.
That return value describes a DevTools DCE check; the bootstrap now verifies the
actual hook injection and the renderer's Refresh helpers instead.

`publisher.test.mjs` uses a mocked transport and real compiler. Its scope is
publisher ordering, lifecycle and configuration handling, not native execution.

## Runtime contract

`scripts/refresh-transform.mjs` supplies two building blocks:

- `buildNativeRefreshBootstrap({clientId, applicationPrefix})` bundles the
  Refresh/client implementation once, outside the incremental module graph.
  Inject it as the custom runtime passed to `createNativeDevEngine`.
- `nativeRefreshTransform({root, applicationDirectory})` transforms only app
  modules. Oxc generates hook signatures and registrations; lexical per-module
  registration functions attach stable module-qualified identities. Nested
  factory evaluation cannot change another module's registration namespace.

After compiler runtime initialization, the permanent app entry imports its one
renderer and calls `attachRefreshRenderer(reconciler)` before the first render.
No existing renderer source is modified. The bootstrap rejects duplicate
installation or multiple renderer attachment.

A compiler patch registers graph rows and factories. Its last expression is:

```js
globalThis.__nhApplyDevUpdate({
  schemaVersion: 1,
  sequence: 1,
  changedIds: ['application/Screen.jsx'],
});
```

The sequence is the native attempt number as a safe JavaScript integer, not
necessarily Rolldown's sequence. It must increase, but forward gaps are allowed
because a native preparation failure consumes an attempt without running JS.
The outer native API checks the wire sequence, session, generation, base revision
and payload digest before registration executes.

The client returns a plain `{status: 'applied'}` only after accepted modules and
`performReactRefresh()` finish synchronously. The host then drains microtasks
and flushes native mounts before returning its stronger terminal acknowledgment.
`reload-required` and `error` poison the JS session; subsequent updates cannot
turn it into a clean session without a new host.

Propagation stops at previously component-only exports with matching export keys
and component families. Noncomponent dependencies propagate to their importing
boundaries. Entry/bootstrap reach, unsupported cycles, missing factories, unknown
IDs, or incompatible export shapes request reload. Changes to hook signatures
allow React to remount the affected component instead of retaining invalid state.

Module evaluation can have side effects before throwing. The initialization-error
test deliberately confirms such a side effect remains; no rollback guarantee is
claimed. Syntax errors prevented from executing leave the live app intact.

The runtime is development-only. Lazy imports, asset delivery, arbitrary manual
HMR acceptance, browser clients, WebView document preservation, real keyboard
focus/selection, platform widget identity, and compositor visibility are outside
these headless gates. Public-node identity is a reconciler observation, not an
operating-system widget assertion.
