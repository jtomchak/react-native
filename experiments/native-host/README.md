# Native host hypothesis and validation plan

Status: working headless/iOS/Android prototype; compatibility and performance gates remain open.
Decision date: 2026-11-05.
Reference checkout: `fe398e511d7b4cfa22baf5b449e256ff9b7d66c4`.

## Product contract

Build a native application host with React/JSX as its UI programming model.
Retain React and Hermes initially, use Rust for shared services and development
tooling, and use small C++/Objective-C++/Swift and Kotlin/JNI adapters where needed.
Reuse Yoga initially. React owns reconciliation and component state; the native
host owns committed presentation, resources, surfaces, and lifecycle.

Initial primitives: View, Text, Image, Pressable, ScrollView, TextInput, and
WebView. WebView is a built-in native component that can be embedded within a
screen, not merely a screen-level escape hatch. The host also includes an
embedded test interface and a proposed Playwright-style TypeScript test SDK.

The executable subset and remaining per-primitive gaps are tracked in
[CAPABILITIES.md](./CAPABILITIES.md).

The [native product comparison](./performance/README.md) uses the full RNTester
application as requested, with a byte-identical shared screen added to its
existing module lists. Full-app build/development costs and shared-screen runtime
behavior are separate measurements; RNTester's larger feature set remains explicit.

Preserve selected observable React/RN behavior, not Fabric's internal tree or
native-module binary ABI. Pin React/reconciler versions. Compatibility with
arbitrary Expo modules, Babel plugins, and existing native libraries is not
implied. The native host is the selected direction; adopting Tauri or Wry is
still an experiment, not a dependency decision.

## Reuse existing tests as reference evidence

[Fantom](../../private/react-native-fantom/__docs__/README.md) executes Hermes and
RN's cross-platform native implementation against a mock UI tree. It provides
layout, event scheduling, timers, and native integration coverage beyond mocked
Jest tests. However, its [root implementation](../../private/react-native-fantom/src/index.js)
directly invokes the existing RN renderer. Passing unchanged Fantom tests would
test the reference implementation, not the new host.

The [source inventory](./compatibility-sources.json) pins local source hashes.
It is a suite-level inventory, not an executable conformance suite or results
report. Executed cases and evidence limitations are tracked in [VERIFICATION.md](./VERIFICATION.md).

| Source suite | Behavior to extract | Limits |
| --- | --- | --- |
| [Timers](../../packages/react-native/src/private/timers/__tests__/Timers-itest.js) | Due-time ordering, cancellation, recurring and nested timers | Deterministic clock, not OS timer accuracy |
| [ShadowTreeBranching](../../packages/react-native/src/private/renderer/branching/__tests__/ShadowTreeBranching-itest.js) | Atomic visible updates around layout effects | Adapt assertions; do not require identical mounting logs |
| [UIConsistency](../../packages/react-native/src/private/renderer/consistency/__tests__/UIConsistency-itest.js) | Consistent reads and committed layout | Contains a known-issue skipped case; triage separately |
| [EventDispatching](../../packages/react-native/src/private/renderer/core/__tests__/EventDispatching-itest.js) | Priority, event order, capture and coalescing | Synthetic events do not prove native touch delivery |
| [View](../../packages/react-native/Libraries/Components/View/__tests__/View-itest.js) | Geometry, prop updates/reset, accessibility mapping | Do not preserve Fabric flattening internals |
| [Text](../../packages/react-native/Libraries/Text/__tests__/Text-itest.js) | Nesting, style propagation, public properties | Generic headless text measurement does not prove native typography |
| [TextInput](../../packages/react-native/Libraries/Components/TextInput/__tests__/TextInput-itest.js) | Focus/blur/selection, commands, ref/effect timing, cleanup | Actual IME and keyboard require platform tests |
| [Pressable](../../packages/react-native/Libraries/Components/Pressable/__tests__/Pressable-itest.js) | Pressed state, disabled state, refs and callbacks | Native gesture arbitration remains separate |
| [ScrollView](../../packages/react-native/Libraries/Components/ScrollView/__tests__/ScrollView-itest.js) | Refs, prop reset, scroll event batching | Native momentum and nested scrolling remain separate |
| [Image](../../packages/react-native/Libraries/Image/__tests__/Image-itest.js) | Sources, sizing, events, accessibility | Harness-injected responses do not prove native decoding/networking |
| [Dimensions](../../packages/react-native/Libraries/Utilities/__tests__/Dimensions-itest.js) | Pixel/logical units, screen/window metrics, font scale | Changing Platform.OS in JS is not an iOS host run |
| [Network](../../packages/react-native/Libraries/Network/__tests__/Network-itest.js) | XHR state and request validation | Its HTTP stub does not deliver responses |
| [RuntimeExecutorShutdown](../../packages/react-native/ReactCommon/react/runtime/tests/cxx/RuntimeExecutorShutdownTest.cpp) | Late work dropped, captures released, safe repeated calls after shutdown | Port scenarios to the candidate executor |
| [BufferedRuntimeExecutor](../../packages/react-native/ReactCommon/react/runtime/tests/cxx/BufferedRuntimeExecutorTest.cpp) | Buffering, flush order, priority propagation | Recording executor does not execute a VM |
| [Bridging](../../packages/react-native/ReactCommon/react/bridging/tests/BridgingTest.cpp) | Values, callback invalidation, promises, buffers | Test our ABI; do not copy C++ binding implementation assumptions |
| [iOS TurboModules](../../packages/react-native/ReactCommon/react/nativemodule/core/iostests/RCTTurboModuleTests.mm) | Null conversion, error context, backing-store lifetime | Port applicable contracts, not Objective-C export conventions |

Existing behavior is evidence, not automatically the desired specification.
[StaleEventHandlersFromInterruptedRender](../../packages/react-native/Libraries/ReactNative/__tests__/StaleEventHandlersFromInterruptedRender-itest.js)
deliberately demonstrates a known bug. The candidate contract should deliver
events to committed handlers, and record this as an intentional divergence.
Skipped cases and feature-flag permutations must remain visible in reports.

For each extracted scenario, define inputs, observable results, environment,
normalization, tolerances, and expected differences before implementing it.
Compare public event/effect order, geometry and ref behavior. Normalize unstable
IDs while preserving identity relationships. Do not normalize away ordering
failures or require identical shadow nodes or internal view names.

Reference commands, after installing existing repository dependencies and
building codegen in an isolated reference worktree:

```sh
yarn --cwd packages/react-native-codegen build
yarn fantom 'Timers-itest|ShadowTreeBranching-itest|UIConsistency-itest|EventDispatching-itest' --runInBand
yarn fantom '/(View|Text|TextInput|Pressable|ScrollView|Image|Dimensions|Network)-itest\.js$' --runInBand
```

Fantom builds its native tester on first use. Its Android bundle target does
not mean Android widgets ran. Native C++/XCTest source entries above are not run
by these Fantom commands. Dependency installation also has a documented Hermes
version/lockfile preinstall side effect; preserve those setup changes separately.

## First native service boundary

Use an asynchronous byte echo service with controlled completion, injected
errors, cancellation, and subscriptions. This intentionally small service tests
the boundary without requiring camera/network permissions or complex business
logic. Add a real platform capability after these contracts work.

The first implemented platform capability is now
[AppState](./testing/APP_STATE.md): native lifecycle snapshots and subscriptions
through the asynchronous Rust boundary, physically exercised on both phones.

Proposed v0 semantics:

- Every request belongs to an application-runtime generation and has a unique ID.
- Worker results return through the runtime executor; workers never retain or
  access JS heap values directly. UI operations run on the platform UI thread.
- While the runtime is live, accepted requests reach one terminal state:
  success, error, or cancellation. Cancellation and completion race through one
  atomic terminal-state transition; the first accepted transition wins.
- A winning cancellation rejects the live request promise with a typed
  cancellation error and suppresses the later worker result, even when underlying
  work cannot be interrupted. A cancellation after success/error has already won
  does not replace that result. Resources still have a defined release path when
  work finishes.
- Shutdown invalidates the generation. Queued work and captures are released;
  late results never enter a destroyed VM or a replacement runtime.
- Unsubscribe is idempotent; events not yet delivered when unsubscribe takes
  effect are dropped. Reentrant callbacks must not execute while holding service
  registry locks.
- Buffers start with explicit copy semantics. Borrowed/zero-copy buffers require
  separate lifetime tests before introduction. Errors carry operation context.
- Capability/schema mismatches fail before dispatch. Bounds and malformed input
  are validated at the ABI boundary.

Required scenarios: cancel before dispatch; cancel during work; completion race;
duplicate completion; queued work during shutdown; callback after reload;
unsubscribe with queued events; callback reentrancy; wrong-thread access;
buffer release on success/error/cancel/shutdown; mismatched schema.

Run against a real embedded Hermes boundary, then both platform adapters. A
Rust-only state-machine test is useful unit evidence, not proof of the FFI path.

## Built-in WebView

Use react-native-webview's [public API](https://raw.githubusercontent.com/react-native-webview/react-native-webview/master/docs/Reference.md)
as a behavior reference. Define a supported subset explicitly rather than
promising every prop immediately: URL/HTML sources, layout, load/error events,
navigation policy/state, back/forward/reload/stop, messaging, and script execution.
Cookies/storage, permissions, popups, downloads, media, and process recovery need
explicit policies and platform-specific tests as the primitive expands.

Each mounted WebView owns its browser lifecycle. Stable React identity preserves
the instance; source updates navigate it, key changes replace it, and unmount
disposes its callbacks and resources. No mandatory global pool or global singleton.
Test at least two independently mounted instances.

Hermes and each browser JS context are separate runtimes. Message envelopes carry
the app generation, WebView identity and document/navigation generation so stale
messages cannot affect replacement content. Document messages do not implicitly
inherit app-native capabilities. Validate payloads and establish sender/frame
trust through the platform transport; a message's claimed origin is not proof.

Compile navigation allow/deny rules into the native adapter where decisions must
be synchronous. Avoid blocking the UI thread waiting for Hermes. Report decisions
back to React; document any differences from asynchronous application callbacks.

Platform gates: embedded sizing/clipping/z-order; native siblings over web content;
native-to-web focus/keyboard transitions; nested scroll/gesture cancellation;
navigation/redirect/error ordering; history; message ordering and stale drops;
cookie isolation/shared-session policies; accessibility traversal; background and
foreground; content-process loss; multiple instances and unmount cleanup.
An occluding native sibling must prevent a system-driver coordinate tap from
reaching the covered DOM target. A DOM-only click cannot satisfy this gate.

## Tauri v2 reuse assessment

Tauri's [mobile plugins](https://v2.tauri.app/develop/plugins/develop-mobile/)
provide Rust-to-Swift/Kotlin command patterns. Their Plugin/AppHandle/runtime
integration and WebView load hooks mean they are not automatically standalone
libraries for this host. Evaluate underlying platform implementations or a
small adapter before promising plugin compatibility.

Its [capability model](https://v2.tauri.app/security/capabilities/) is useful
design input for per-WebView permissions; its existing authorization boundary
does not automatically protect a new direct Hermes-to-Rust invocation route.
Its [mobile build commands](https://v2.tauri.app/distribute/) are useful reference
for packaging, while extraction into a custom host remains unvalidated.

Wry is a candidate WebView backend, especially for future desktop targets.
However, the inspected [Wry 0.57.1 builder API](https://docs.rs/wry/0.57.1/wry/struct.WebViewBuilder.html#method.build_as_child)
explicitly marks `build_as_child` unsupported on Android/iOS. Mobile support in
general does not establish embeddable primitive support. Start with direct
WKWebView/Android WebView adapters behind our backend interface, and benchmark
a Wry integration only after it proves placement inside the native view tree.

Keep Tauri comparison work isolated: inspect or adapt a small capability such as
haptics, measure required host dependencies, and verify lifecycle/late callbacks.
Do not introduce an invisible WebView solely to make plugin initialization work.

## Embedded test interface and Playwright-style runner

The test interface is part of the host architecture. Its control transport is
enabled only in explicit test builds, absent from production distribution, and
restricted to an authenticated local/device-forwarded test session.

Proposed protocol operations:

| Operation | Contract |
| --- | --- |
| `session.describe` | Protocol/build versions, device/platform, backend, runtime generation, supported features |
| `ui.snapshot` | Semantic tree, role/name/testID, bounds, enabled/visible state, surface IDs and revision |
| `ui.perform` | Resolve fresh target and deliver system-driver pointer/keyboard/scroll input; actionability and hit testing first |
| `runtime.waitFor` | Wait for a scoped condition or commit revision; report busy resources on timeout |
| `webview.attach` | Select an instance and document generation; expose supported DOM-driver capabilities |
| `fixture.reset` | Reset test-owned storage/services and app lifecycle under an explicit fixture policy |
| `diagnostics.capture` | Logs, screenshot where available, semantic tree, scheduling/service trace and build identity |

The semantic snapshot and the platform accessibility tree are separate evidence.
Compare them; an internal tree alone can hide an inaccessible or occluded UI.
Normal end-to-end interactions use platform automation input delivery, never
direct calls to React handlers. Programmatic native `performClick`, `sendActions`,
or accessibility-action invocation alone also does not prove geometric hit
testing; label those mechanisms separately. Deterministic event injection belongs
to the headless test mode.

Use scoped readiness (pending finite tasks, commits, relevant service requests,
finite animations). Infinite animations, polling and open WebSockets must not
force permanent global busy state. No fixed sleeps as the default synchronization
mechanism. Headless virtual time and real device time remain distinct modes.

[Playwright Test fixtures](https://playwright.dev/docs/test-fixtures) can host an
`app` fixture plus reporting and worker isolation. Native locators, actionability,
auto-waiting and mobile transport still require our adapter; they do not become
Playwright Page APIs automatically. A prospective test authoring surface is:

```ts
// Proposed SDK, not implemented APIs.
test('native and web content work together', async ({app}) => {
  await app.getByRole('button', {name: 'Open checkout'}).tap();
  const checkout = await app.webView('checkout').attach();
  await checkout.getByRole('textbox', {name: 'Email'}).fill('test@example.invalid');
  await checkout.getByRole('button', {name: 'Continue'}).click();
  await app.getByTestId('confirmation').waitFor({state: 'visible'});
});
```

The implemented [shared mobile test](./testing/mobile.spec.mjs) currently uses
`getByTestId().tap()/fill()/textContent()/waitFor()`, native health checks and
`webView().attach().tapAt()` with real system coordinates. For example:

```js
await app.getByTestId('increment').tap();
await expect.poll(() => app.getByTestId('count-label').textContent()).toBe('Count: 1');
const primary = await app.webView('web-primary').attach();
await primary.tapAt({x: 100, y: 80});
```

Role-based native locators, generic DOM selectors and the broader proposed
operations above remain separate work. Android exposes explicitly instrumented
DOM evaluation; the iOS adapter reports it unsupported.

WebView attachment is a separate adapter per platform. Do not assume desktop
Playwright WebKit can attach to an arbitrary iOS WKWebView. Probe actual browser
automation support; use explicit instrumented DOM hooks for controlled test
content where needed, and label those results accordingly. Cross-origin frames
and third-party content require declared capabilities or an unsupported result.

[Maestro](https://docs.maestro.dev/get-started/how-maestro-works) is a useful
external UI/accessibility-driven smoke test lane. [Detox](https://wix.github.io/Detox/docs/articles/design-principles/)
provides a reference for runtime-aware synchronization, but its existing RN
integration cannot be assumed to understand our Rust executor and service queues.
Evaluate an adapter rather than running multiple engines against the same app
concurrently. A shared scenario catalog can target these independent lanes.

## Execution lanes and gates

1. **Reference:** install/build the existing RN test environment and run the
   selected suites. Record exact cases, skips, flags and commands. Keep bugs as
   documented observations rather than golden behavior to reproduce.
2. **Headless candidate:** real Hermes plus Rust services and a nonvisual host.
   Implement the test protocol, service races, and adapted render/scheduling
   assertions. This is integration evidence, not full mobile end-to-end evidence.
3. **iOS and Android:** native shells using the same service contracts; native
   primitives plus an embedded WebView and mixed native/web test flow. Verify
   UI thread affinity, actual input, accessibility, lifecycle, and cleanup.
4. **External automation:** run independent Maestro smoke flows; evaluate Detox
   synchronization/driver integration. Prove test hooks do not bypass hit testing.
5. **Performance:** matched stock-RN and candidate workloads, equivalent tooling
   and cache conditions. Measure cold/warm build, edit-to-visible p50/p95, release
   startup, memory, frame misses, and repeated WebView/runtime teardown.

Reports distinguish reference, headless candidate, simulator/emulator and physical
device. Never collapse not-run, unsupported, skipped, expected-divergence or failed
into pass. A differential match requires both backends to execute the same
scenario. Empty selections fail. Preserve original attempts when retries occur.
Record the concrete input-driver backend and action mechanism for each run;
driver selection and platform support must be proven during the mobile spike.
Each worker has an isolated app/device/storage namespace; shared mutable app state
must not create false parallel-test passes.

Architecture acceptance requires the selected behavior contracts on both mobile
platforms, no lifetime/thread-affinity violations, and a measured benefit that
justifies host maintenance. Revisit the boundary if it requires reproducing most
of Fabric without a demonstrated benefit. Do not claim compatibility or speed
from source inspection or mocked platform execution.

## Prototype implementation

- `core/`: standard-library-only Rust asynchronous services and bounded C ABI.
- `runtime/`: real embedded Hermes, Yoga layout, native lifecycle and test protocol.
- `js/`: approved React/reconciler versions, JSX primitives and reference-derived scenarios.
- `platforms/ios/` and `platforms/android/`: native widgets and independently mounted WebViews.
- `testing/`: Playwright Test fixtures for headless contracts and actual platform input.
- `dev/` and `scripts/watch.mjs`: Rust development supervisor with persistent
  Rolldown, atomic immutable revision publication and optional deployment commands.
- `scripts/bundle.mjs`: one-shot Rolldown development/release bundles.

The prototype uses JSON snapshots across the renderer/host boundary and runs
Hermes on the native UI thread. These are implementation choices for validating
behavior; neither is evidence of improved runtime performance. Native text,
images, scrolling, input and accessibility implement only the documented subset.

The approved dependency versions are in [DEPENDENCIES.md](./DEPENDENCIES.md).
Install from this directory with `npm ci --workspaces=false`. Build the matched
native runtime following [runtime/README.md](./runtime/README.md), then run:

```sh
npm run bundle
npm run bundle:release
npm run test:core
npm run test:driver
npm test
npm run test:contracts
npm run test:dev
```

`npm run dev` keeps the Rust supervisor and Rolldown worker running. The
[development tooling README](./dev/README.md) describes revision publication,
deployment commands, failure recovery and timing boundaries. Platform debug
reload adapters consume validated revisions; this first loop uses full process
restart. It does not preserve React state or WebView history as Fast Refresh would.

A separate [native Refresh experiment](./testing/refresh/README.md) now passes
actual Rolldown/React updates through the dedicated Hermes development API with
test evaluation disabled. Physical Pixel updates through the dedicated Debug
transport preserve state, input focus/caret and visible scroll geometry, with
the same process/generation and APK. iOS transport-only simulator checks pass;
actual iOS Refresh, WebView document preservation and the repeated performance
comparison remain acceptance gates. The existing `npm run dev` command retains
its full-reload behavior.

Mobile builds and test-driver startup are documented in each platform directory.
`npm run test:mobile` requires `NH_DRIVER_CONFIG` pointing to a private local JSON
configuration for an already-running authenticated driver. It fails if no driver
is available; it never substitutes headless events for platform input.

See [VERIFICATION.md](./VERIFICATION.md) for observed results, original failures,
version differences and acceptance gates that remain unvalidated.
