# Next measured bottleneck: state-preserving native updates

The repeated Pixel comparison in `RESULTS.md` selects the development update
path as the next implementation target. Keep the larger native-build, release
startup/memory/frame and browser lifecycle gates open. A faster compiler alone
does not resolve process restart or React state loss.

## Current implementation evidence

Compiler, permanent React bootstrap, dedicated native ingress, ordered Rust
delivery and Debug platform transports are implemented. Four actual compiler
patches on the physical Pixel preserve process/generation, counter/input,
focus/caret and OS-visible scroll geometry; syntax error/fix and a component-body
edit also pass. The shared workload remains byte-identical to the full RNTester
baseline. The Refresh revision copy is a separate mutable application module;
the old full-reload fixture and original revision file remain intact.

Evidence: `build/refresh-mobile/1793907307105-14710/report.json` and
`../VERIFICATION.md`. iOS transport-only simulator checks pass with test hooks
disabled, but actual iOS React Refresh and physical initial staging remain open.
Next: validate the actual iOS pipeline and browser document continuity, then
rerun the paired edit-to-visible packet against full RNTester. The old timing
results describe full reload and do not measure this new Refresh implementation.

## Ordered implementation

1. **Feasibility gate, isolated files first.** Inspect the pinned Rolldown 1.3
   `experimental.dev()`/`DevEngine` and `experimental/runtime` contracts. Add an
   isolated compiler driver and `testing/refresh/` fixtures. Execute initial
   output and actual successive patches in real embedded Hermes, with lazy
   compilation disabled initially. Exercise module additions/removals and CJS
   interop. Reject unresolved DOM, WebSocket, script insertion or dynamic-import
   dependencies. The default browser client is not the native implementation.
2. **Permanent renderer/bootstrap.** Install `react-refresh/runtime` into the
   global hook before the single reconciler initializes; inject its development
   helpers once. Keep React, reconciler, services, root and native bindings outside
   updateable application modules. Use Oxc-generated refresh registrations and
   hook signatures with module-qualified identities. Never reevaluate the
   existing complete IIFE to simulate hot updates.
3. **Application boundary.** Split the candidate performance entry into permanent
   bootstrap, stable bound screen and component-only revision wrapper, matching
   the fixed RNTester adapter. Preserve shared workload bytes. Test actual
   component-body changes too; a revision-constant edit alone is insufficient.
4. **Bounded native development transport.** Rust supervisor and compiler driver
   deliver session/client identity, runtime generation, base/target revision,
   sequence, payload hash and source map. Native networking queues immutable
   bytes to the owner thread. Use explicit ephemeral development sessions;
   separate payload execution acknowledgements from successful React/native
   mount acknowledgements. Handle reconnects, duplicates, missing dependencies
   and server restart; dependent patches cannot simply be coalesced.
5. **Dedicated runtime ingress.** Add development-only update handling at the
   host's outer task boundary. Validate generation/sequence, register/evaluate
   changed modules, run Refresh and flush the existing native commit path.
   Successful refresh retains generation and host identity. Bootstrap/native
   edits explicitly reload. Release artifacts contain neither ingress nor Refresh.
6. **Recovery and correctness.** Compilation failures leave the app intact.
   Incompatible hooks/exports have explicit remount/reload behavior. Module side
   effects cannot generally be rolled back; failed evaluation must never be
   acknowledged as a successful update. Test handler replacement, effect cleanup,
   state/ref preservation, signature changes, error/fix cycles, stale/reordered
   patches, reconnects and renderer singleton identity in Hermes, then on devices.
7. **Rerun the existing packet.** Require PID, runtime generation and state
   preservation plus exact OS-observed marker. Verify focus, selection, scroll,
   pending services and WebView document identity separately. Measure compiler,
   transfer, evaluation and mount spans where available while retaining the same
   end-to-end endpoint and full RNTester baseline.

This is a new development-runtime feature, not a watcher option. The first gate
needs no production dependency. A pinned development-only `react-refresh` package
would make the experiment self-contained; production dependency additions still
require the user's approval. Existing runtime/module imports must not introduce
Refresh into release bundles.

Local installed source is authoritative for the pinned API. Design references:
[Rolldown overview](https://rolldown.rs/guide/introduction),
[default browser client](https://github.com/rolldown/rolldown/blob/main/crates/rolldown_plugin_hmr/src/runtime/runtime-extra-dev-default.js),
[engine delivery contract](https://github.com/rolldown/rolldown/blob/main/internal-docs/dev-engine/implementation.md),
[React Native Refresh behavior](https://reactnative.dev/docs/fast-refresh).
Those upstream branches can move; record exact source/version evidence when
implementing the feasibility gate.
