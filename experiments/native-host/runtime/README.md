# Native Hermes host

This implementation embeds Hermes through its C++ JSI API, links the Rust
service core through its C ABI, and calculates the supported layout subset with
this checkout's Yoga. It does not use Node to execute application JavaScript.

## Build and verify

Use a matched Hermes header/library set. The initial verified bootstrap set is
Hermes `250829098.0.16`, available locally at:

```sh
export HERMES_ROOT=/Users/jesse/code/tapcart/tapcart-react-native/ios/Pods/hermes-engine/destroot
experiments/native-host/scripts/build-native.sh
ctest --test-dir experiments/native-host/build/headless --output-on-failure
python3 experiments/native-host/runtime/test_services.py -v
```

This is older than the reference checkout's Hermes version. Results identify the
bootstrap artifact and must not be presented as reference-version equivalence.
The framework/header cache is external to this experiment; portable artifact
acquisition is a separate remaining task. Override `HERMES_FRAMEWORK` only with
the appropriate framework from the same matched distribution.

`build-native.sh` builds an explicitly test-enabled executable at
`build/headless/native-host`. It enables `NH_TEST_HOOKS` and
`NH_SERVICE_TEST_HOOKS`, with the Rust `test-hooks` feature in a separate
`build/core-test` target directory. Shipping core builds remain separate.

CMake defaults both options OFF. `NH_SERVICE_TEST_HOOKS` requires
`NH_TEST_HOOKS`. A hooks-OFF CTest build verifies that arbitrary `runtime.eval`
is rejected. Mobile builds may enable only `NH_TEST_HOOKS` for evaluation
without linking the optional Rust fault-injection symbol.

## Native API

[host.h](./host.h) exports a C API usable from Objective-C++ or JNI. The runtime,
all JS values, timers, and callbacks are confined to the creating thread.
Wrong-thread API calls fail before touching Hermes. Rust workers deliver owned
messages through a polled queue; they never hold JS values or invoke JS.

The mount callback can run during `nh_host_create`, before the caller has stored
its returned host pointer. The callback borrows JSON only for that invocation.
Dispatch responses are owned strings released with `nh_host_string_free`.

### Native command callbacks

`nh_host_create_with_options` accepts `NHHostOptions` version 1, with `size` set
to `sizeof(NHHostOptions)`. It installs both commit and command callbacks before
evaluating the application bundle. The existing `nh_host_create` remains usable
and advertises no native commands. Options and capability text are copied during
creation; callback contexts must remain valid until host destruction.

`command_capabilities_json` maps primitive names to supported command arrays:

```json
{"TextInput":["focus","blur","clear"],"ScrollView":["scrollTo","scrollToEnd"],"WebView":["goBack","goForward","reload","stopLoading","postMessage","injectJavaScript"]}
```

Declare only commands actually implemented by the platform adapter. Unknown
types/commands, duplicate entries, malformed JSON, capabilities over 16KiB, and
nonempty capabilities without a callback reject creation. Capabilities appear in
`session.describe.nativeCommands`, with `nativeCommandVersion: 1`, and in the JS
global `__nhCommandCapabilities` before bundle evaluation.

`__nhCommand` accepts one JSON string:

```json
{"version":1,"generation":1,"nodeId":42,"name":"scrollTo","args":{"x":0,"y":100,"animated":false}}
```

The generation must equal `__nhGeneration`. The target must exist in the last
successfully published native snapshot, and its primitive must support the
command. `scrollTo` accepts optional finite x/y coordinates within +/-10000000
and an optional boolean `animated`; `scrollToEnd` accepts optional `animated`.
Omitted x/y default to zero and omitted animated defaults to true in adapters.
`postMessage` requires string `data`; `injectJavaScript` requires string `source`.
Each string is limited to 1MiB UTF-8, including embedded null characters as string
content; adapters must preserve string lengths. Other commands require empty
args. Unknown envelope/argument fields fail. The full command is limited to
1MiB+4096 bytes. Native callbacks receive the borrowed request only during the
call; asynchronous native work must copy any necessary data.

The callback returns a malloc-owned JSON string containing either `{"result":null}`
or `{"error":{"code":"PLATFORM_ERROR","message":"operation failed"}}`.
The host frees this allocation on every success/error/parse-failure path. A null
pointer, invalid envelope, non-null result, response over 64KiB, error code over
64 bytes, or message over 4096 bytes becomes `NATIVE_COMMAND_ERROR`.
JS receives null for accepted submission or an Error carrying `code`. Host codes
include `INVALID_COMMAND`, `STALE_GENERATION`, `STALE_NODE`, and
`UNSUPPORTED_COMMAND`; valid adapter error codes are preserved with operation
context. This is a submission acknowledgement, not asynchronous browser script
completion. Promise-returning native commands require a separate lifecycle API.

Both callbacks are guarded against reentrancy. `nh_host_dispatch`, `nh_host_pump`
and `nh_host_destroy` reject calls made inside a commit or command callback with
`REENTRANT_HOST_CALL`, without deleting the host or entering Hermes. Native focus,
text, scroll and browser delegates can fire synchronously inside these callbacks:
platform adapters must enqueue those events for a later UI-thread turn and
revalidate runtime generation, widget identity and document identity then.

Layout-effect refs can refer to nodes not yet mounted. The React adapter owns
that queue: defer commands until the final `__nhCommit` returns, preserve order,
and discard targets removed by the final commit. The C++ boundary intentionally
does not execute against the speculative layout tree. A callback invoked during
host creation must also tolerate the caller's host pointer not yet being assigned.

The C++ contract executable exercises native commands through real Hermes in both
hooks-enabled and hooks-disabled builds, using a callback test adapter rather than
platform widgets. It covers early registration, capabilities, malformed/bounded
inputs and responses, all declared commands, stale targets/generations,
wrong-thread access and dispatch/pump/destroy reentrancy. It also guards the
failure path where a Hermes exception must be released before destroying its VM.
Platform command effects and asynchronous browser completion are separate tests.

### Real platform AppState service

The size-gated `NHHostOptions.initial_app_state` tail field enables AppState before
bundle evaluation. Exact older v1 option structures remain accepted using
`NH_HOST_OPTIONS_V1_SIZE`; absent/null tail fields disable the service. A non-null
initial state requires an iOS or Android adapter. Headless hosts advertise
`nativeAppState:false` and throw `UNSUPPORTED_SERVICE` for snapshot/subscription
requests. Native hosts advertise `nativeAppState:true`, with `appStateScope` set
to `application` on iOS or `single-activity` on Android.

iOS observes actual UIApplication active/inactive/background notifications.
Android observes the selected Activity's onResume (active) and onStop
(background); onPause does not invent an inactive transition. This does not yet
model an application with several Activities or multiple iOS scenes. Native
notifications enqueue a later owner/UI-thread update with captured host identity
and runtime generation. Observers and pending UI work are invalidated before
teardown. `nh_host_app_state_update(host,generation,state)` validates the owner,
generation and state, and queues subscription events without calling JavaScript.
Its owned JSON response must be freed with `nh_host_string_free`.

From `js/services.js`:

```js
const subscription = subscribeAppState(value => {
  // value.state, value.generation, value.sequence, value.capturedAtMs
});
const request = getAppState();
const snapshot = await request.promise;
subscription.unsubscribe();
```

`getAppState()` captures the host's latest accepted OS-lifecycle observation at
request time. It copies that value into an actual asynchronous Rust request;
completion arrives through the existing poll/event boundary and resolves the JS
promise. It does not query an instantaneous OS state during a notification that
has not yet reached the host. `request.cancel()` follows the existing
first-terminal-transition-wins contract, so a completed snapshot cannot be
replaced by cancellation. This service does not use the void native-command API.

Subscriptions deliver subsequent transitions only, with no implicit initial
event. Subscribe before requesting a snapshot to avoid a registration gap;
consumers combining both streams must retain the greatest sequence within the
current runtime generation because a snapshot may complete after a newer event.
Records have schemaVersion 1, source `native-lifecycle`, state, generation,
sequence, and capturedAtMs relative to this host's monotonic clock. Duplicate
native states emit no event. Background execution is not promised: queued events
can be delivered when the OS permits the host to pump again.

AppState supports at most 64 subscriptions and shares the core's bounded event
queue and byte budget. Queue overflow is an explicit update error and a sticky
runtime diagnostic, not silent success; the real current state still advances.
Generic JS subscription publishing cannot forge an AppState event. Unsubscribe
removes pending core events and JS callback ownership; reentrant unsubscribe can
drop later queued transitions. Shutdown releases outstanding requests/events and
the next generation rejects the prior generation's native updates. Native code
must still never call any API with a freed host pointer.

`host-contract-tests.cpp` executes the actual JS services implementation in
Hermes against Rust, using **explicitly simulated OS ingress**. It checks legacy
option size, unsupported headless behavior, async capture-time snapshots, bounds,
stale/wrong-thread ingress, duplicate suppression, reentrant unsubscribe and
generation replacement in both hooks-enabled and hooks-disabled builds. The
`runtime/tests/AppStateLifecycleTest.java` check runs the actual Android module
with simulated lifecycle calls. These are not physical OS-transition results;
background/foreground acceptance on real devices is a separate lane.

Headless input/output uses one JSON request/response per line:

```json
{"id":1,"method":"session.describe","params":{}}
```

Run with `--bundle path`, `--width 390`, and `--height 844`. The headless process
pumps when processing requests. Test runners poll `runtime.pump`; it is not a
background browser event loop. Native adapters pump on their owner/UI thread.

Native protocol methods are `session.describe`, `runtime.pump`,
`native.snapshot`, and test-only `runtime.eval`. Other methods invoke the bundle's
`__nhDispatch(method, params)`. Protocol errors use
`{id,error:{code,message}}`; successful responses use `{id,result}`.

## JavaScript boundary

- `__nhLayout(treeJSON)` calculates geometry without publishing a mount.
- `__nhCommit(treeJSON)` publishes a laid-out snapshot and calls the mount adapter.
- `__nhEcho(payloadString, delayMs)` returns a native request ID.
- `__nhCancel(id)` returns a native status; terminal delivery still uses the queue.
- `__nhSubscribe`, `__nhPublish`, and `__nhUnsubscribe` use the same native queue.
- The optional `__nhTestEchoError` schedules a real asynchronous Rust error.
- `__nhServiceEvent(eventJSON)` receives generation, ID, kind, status and payload.
- `__nhGeneration`, `__nhPlatform`, and `__nhViewport` describe the host.
- Timers, microtasks, `performance.now`, and console output are host-backed.

After outer native task/microtask processing, the host calls optional
`__nhFlushMount()`. The React adapter must use that boundary to publish only the
final visible tree after synchronous layout-effect updates. Intermediate layout
queries use `__nhLayout`, so geometry reads do not publish partial UI.

Each node's `bounds` is absolute in surface coordinates. `layout` is relative to
its parent. Preserve node identity and subtract parent bounds when mounting into
nested native views. The snapshot retains input props and children.

The supported style subset includes numeric/percentage width and height,
min/max dimensions, flex, alignment, gap, padding, margins, border widths,
position offsets, absolute positioning, direction, wrapping and display:none.
Unsupported styles are not full React Native style compatibility. Headless text
has no native font-shaping or intrinsic typography measurement; explicit geometry
is useful integration evidence only. Native widgets/WebViews are implemented by
platform adapters, not simulated by this headless runtime.

`runtime.pump` reports timers, authoritative pending request/queued event counts,
subscriptions, retained service bytes, and asynchronous errors. Errors must be
checked by the runner; they persist across pumps until explicit test-only
`runtime.ackErrors` acknowledges them. Diagnostics retain the first 256 errors
and report the suppressed count thereafter. Release dispatch rejects test
methods before entering the JavaScript adapter, even with an accidental test bundle.

## Evidence boundaries

The C++ contract executable verifies actual Hermes identity, wrong-thread
rejection, malformed-request recovery, hook gating, and unpublished versus
published geometry. The Python suite crosses Hermes/JSI/C/Rust for echo,
cancellation, error delivery, subscriptions, reentrancy, timer/microtask order,
and delayed-work shutdown. None of these checks establishes actual native
keyboard, accessibility, WebView, or system-input behavior.

### Development-only update ingress

The separate `NH_DEV_UPDATES` C ABI queues copied, hash-verified source for an
explicit owner-thread preparation/evaluation boundary. It preserves generation
on success and requires full reload after partial evaluation failure. It is
independent of test hooks and absent from normal builds. See
[`dev/README.md`](dev/README.md) for the exact completion/queue contract, isolated
NDJSON exerciser, failure limitations and four-configuration verification command.
