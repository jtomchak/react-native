# Android native-host prototype

This Activity embeds the shared C++ Hermes host, Rust service core, and Yoga.
Java mounts actual Android views for the seven initial primitives. Hermes and
mounts share the UI thread in this prototype; no responsiveness advantage is
claimed. Node is used only by the development tools, never as the app runtime.

## Build

Build `experiments/native-host/build/app.bundle.js` with the parent experiment's
bundle command. Set `ANDROID_HOME` or local `sdk.dir`, provide JDK 17, Gradle
8.13, Android SDK 35, NDK 27.1.12297006, CMake 3.30.5 and Rust's
`aarch64-linux-android` target. Gradle downloads the existing Hermes runtime at
the explicitly matched version `250829098.0.16` from Maven Central.
Its existing native transitive dependency `com.facebook.fbjni:fbjni:0.7.0` is
pinned to the version in that Hermes artifact's published POM.

The Android Hermes AAR omits JSI headers and requires a separate `libjsi.so`.
`python3 prepare-hermes-headers.py` obtains platform-independent JSI headers
from the **same version** Apple artifact. Android-specific headers and the VM
come from the Android AAR. CMake verifies the repository's JSI headers are
byte-identical before compiling its JSI implementation into `libjsi.so`.
`--source /path/to/matched/destroot/include/jsi` can reuse an existing artifact.

From this directory:

```sh
gradle :app:assembleDebug :app:assembleDebugAndroidTest
adb -s emulator-5580 install -r app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5580 install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s emulator-5580 shell am instrument -w dev.nativehost.experiment.test/dev.nativehost.HostInstrumentation
```

Use a task-owned emulator; the development run uses AVD
`native_host_experiment`, serial `emulator-5580`. This arm64-only prototype does
not declare an x86 emulator build.

## Development revision deployment

After the native shell is installed, JavaScript edits can deploy without another
Gradle/Cargo/CMake build:

```sh
python3 deploy-revision.py /absolute/path/to/build/revisions/DIGITS --serial emulator-5580
```

The directory contains `app.bundle.js`, `app.bundle.js.map`, and `manifest.json`.
The manifest uses schemaVersion 1, an exact string revision, development mode,
full reload, bundle SHA256/byteLength, and a sourceMap object with the fixed map
filename plus its SHA256/byteLength. Revisions stay digit strings, including
values larger than JavaScript's integer range. Both the deployer and native
debug startup validate the bundle and map. Missing/corrupt files, unsupported
metadata, mismatched revisions, nondigit paths and symlinked files are rejected
before Hermes starts.

The deployer uploads to an app-private temporary directory with `adb run-as`,
then atomically renames it into `files/dev-revisions/<revision>`. It never replaces
an existing revision; exact already-staged artifacts may be reused. A shell-only
debug receiver destroys the old Hermes/Rust host and WebViews before the deployer
stops the process and starts the exact revision via `--es devRevision DIGITS`.
This is a full process reload: React state resets. It is not Fast Refresh.

The release source variant contains only packaged-bundle selection, ignores the
development extra, and has no reload receiver. `run-as` also refuses the
non-debuggable release package. The device verification temporarily installs a
locally debug-key-signed release APK to test these properties, then restores the
debug APK. No production signing or installation is involved.

For a driver session against a staged revision, also pass `-e revision DIGITS`
to instrumentation. That exact selection is preserved by `fixture.reset`.
`session.describe` and `session.health` expose `bundleRevision`,
`requestedRevision`, `processId`, `hostSessionId`, and `runtimeStarted`;
`session.describe` additionally includes `runtimeGeneration`. Generation may
restart at 1 in a new process, so use the full process/session identity. Rejected
startup remains observable as unhealthy with `runtimeStarted:false`.
The debug variant also atomically writes app-private `files/dev-startup.json`
with this identity and initial health. Read it with `adb run-as` to observe the
actual deployed process without instrumentation relaunching the Activity. It is
explicitly a startup receipt, not a continuously updated health monitor. The
release variant writes no receipt.

`verify-deployment.py --serial emulator-5580 --android-sdk /path/to/sdk` checks
already-built APKs on a task device, creates explicit transport fixtures, and
tests native labels, state reset, process identity, native artifact rejection and
release override exclusion. It does not build native code or establish watcher
performance. Raw observations are retained under `.cache/deploy-verification/`.
The native corrupt-bundle, corrupt-map and missing-map cases bypass client-side
validation and prove rejection before the VM is created.

`verify-watch-reload.py --serial emulator-5580 --base /path/to/revision1 --updated
/path/to/revision2` observes two actual watcher outputs without building,
installing, or starting instrumentation. The verified run changed the native
heading from `Native host prototype` to `Native host reload verified`, reset a
count of 1 to 0, changed process/host-session identity, and preserved the installed
APK's SHA256. Its report and raw native UI trees are under `.cache/watch-reload/`.
Watcher build timing and native deployment/observation are separate evidence;
this test does not claim an edit-to-visible latency measurement.

## Test driver

The instrumentation APK owns system input and the optional loopback TCP server.
Neither is part of the release application. Generate a fresh session token and
start the driver using `am instrument -w -e mode server -e token TOKEN -e port
18771 dev.nativehost.experiment.test/dev.nativehost.HostInstrumentation`, then
forward a host port with `adb -s emulator-5580 forward tcp:18771 tcp:18771`.
Pass the generated token via a shell-safe argument; do not embed it in files.

The wire protocol is newline-delimited JSON. First send
`{id,method:"session.authenticate",params:{token}}`. Each response contains the
same `id` and either `result` or `error`. Supported driver operations:

- `session.describe`: runtime plus concrete driver identity.
- `session.health`: `{healthy,failure,errors}` after pumping the runtime. Native
  callback/pump errors remain sticky until the Activity/runtime is recreated.
- `ui.snapshot`: committed semantic tree; not the platform accessibility tree.
- `ui.find {testID}`: native label, enabled/visible flags, bounds in physical pixels.
- `ui.text {testID}`: native text observation, returned as `{text}`.
- `ui.inspect {testID}`: native focus/scroll state, or WebView document identity
  and copied back/forward list. This is instrumented native observation.
- `ui.tap {testID}`: fresh native lookup then system coordinate touch events.
- `ui.type {testID,text}`: native focus, select-all, and system key events;
  characters missing from the virtual keyboard report unsupported.
- `ui.dismissKeyboard`: sends system Back only when the IME is visible.
- `webview.evaluate {testID,source}`: explicitly instrumented DOM evaluation,
  not browser-protocol attachment or a system-input action.
- `webview.tap {testID,x,y}`: fixture-local CSS coordinates converted to actual
  system pointer input using the device density. Arbitrary page zoom is not
  supported by this initial conversion.
- `fixture.reset`: recreate the Activity/runtime. It does not erase browser
  cookies/storage; the result states `storageReset:false`.
- `runtime.pump` and other host methods: delegate to the embedded runtime.
- `session.close`: stop the test server and finish instrumentation.

The built-in instrumentation scenario sends actual system-coordinate events,
checks React state updates, checks a WebView instance survives a React update,
and verifies a React-mounted native cover prevents the covered DOM button from
receiving a tap while a second WebView remains independent.

## Current limits

The adapters implement the demonstration subset, not all React Native props.
Text currently flattens nested runs; native font measurement, rich styled runs,
complete IME/selection contracts, image event contracts and
full accessibility semantics need dedicated conformance work. HTTPS/inline HTML
WebView sources and messaging are implemented; cookies/storage,
permissions, popups, downloads and process-loss policies are not yet complete.
The prototype does not claim full RN/WebView compatibility or physical-device
verification from an emulator run. Test reports retain failures and their input
mechanism rather than converting them into passes.

## Verification evidence

On the task-owned Android 36 arm64 emulator, the native instrumentation scenario
passed 24 assertions with actual UiAutomation coordinate input, including
malformed/null WebView bridge messages. The
authenticated driver smoke test passed describe/snapshot, native tap and typing,
an Echo action, and instrumented DOM observation. Debug and unsigned release APKs
built; packaged JavaScript bytes matched their respective debug/release bundles.
The release APK does not contain the test driver class or authentication endpoint.

A separate intentional-fault regression also passed: a scheduled JavaScript
exception changed native session health to unhealthy; acknowledging the runtime
error did not clear that native failure; recreating the Activity/runtime restored
healthy state. Its evidence is separate from the successful interaction scenario
in `.cache/health-fault-evidence.json`.

Local logs and the machine-readable attempt history are under ignored `.cache/`.
The first two device attempts failed on missing JSI and fbjni packaging, which
were corrected and retained in the evidence history. These results do not replace
the broader compatibility, accessibility, lifecycle, release-device or
performance gates in the parent plan.

Physical baseline verification also ran on a Pixel 2 XL with Android 11/API 30:
the native instrumentation passed 24 assertions, the shared Playwright mobile
scenario passed 1/1, and the independent Maestro flow passed 1/1. Evidence is
separate under `.cache/physical-pixel2xl/`. The first Maestro attempt was
interrupted when Android installed a WebView update and explicitly killed this
app; that failed attempt and the system kill reason are retained. The unchanged
flow passed after the provider update completed. Native/Playwright ran with
WebView 155.0.8059.43; the final Maestro pass used 156.0.8078.47. Maestro provisioned
its own two test helper packages and automatically removed them afterward; no
unrelated app/browser data was cleared. These baseline runs precede the later
imperative native-command adapter work and make no performance claim.

## Imperative native commands

The versioned shared host command boundary calls Android on the UI thread.
Capabilities advertise TextInput `focus`, `blur`, `clear`; ScrollView `scrollTo`,
`scrollToEnd`; and WebView `goBack`, `goForward`, `reload`, `stopLoading`,
`postMessage`, `injectJavaScript`. Successful return acknowledges submission to
the platform, not asynchronous browser completion. Native callbacks enqueue
events onto a later UI turn, then recheck host/node/document identity before
entering Hermes. TextInput clear suppresses change events and an uncontrolled
`defaultValue` is applied only at creation; a controlled `value` may reassert its
value in a later React commit.

Inline HTML loads at a shared synthetic HTTPS origin through the individual
WebView's main-frame request interceptor. Each source gets a unique directory
containing the host session, node ID, and a fresh source identity. This keeps
shared-origin app/session semantics; it does not claim origin isolation between
WebViews. The adapter atomically retains one immutable URL/HTML resource per
node, serves only its exact original URL or one exact current same-document
alias for main-frame requests, and returns 410 for other synthetic URLs and all
synthetic subresource requests. The alias is updated by actual native history
callbacks within that source's unique directory; it is not a wildcard path rule
or a growing URL cache. This allows reload after a path/query `pushState` while
retaining the current source boundary. Previous source HTML is not retained in
an adapter cache.
Source replacement invalidates old document tokens, asynchronous evaluation
callbacks and old source-directory navigation callbacks. Relative same-document
history paths/query changes retain the current source identity. No network
server or global WebView pool is involved. A physical
regression established that `loadDataWithBaseURL` produced data-backed history
entries: actual activated browser taps created entries, and native history moved
one index, but back/forward restored a URL without its fragment. Setting its
`historyUrl` did not fix that behavior. Serving the same inline HTML through the
scoped interceptor preserves real URL history and native back/forward behavior.
This is a prototype origin/loading policy, not complete WebView source semantics.

The shared React-ref command scenario passed on the Pixel 2 XL using revision
`17938983654880759729474353483156800000001`: 1/1, zero skipped or flaky tests.
Actual system taps exercised input
focus/blur/clear without change emission, scroll offsets 160/320/0, independent
WebViews, quoted Unicode messages, injection, history traversal, reload, source
change, keyed replacement, and unmount/remount, with healthy native teardown.
`stopLoading` was invoked on a loaded page; in-flight network cancellation remains
unverified. The command callback itself does not claim browser completion.

Evidence is separate in `.cache/physical-commands/`: failed attempts 1 and 2,
successful attempt 3, native history/DOM/user-activation probes before and after
the inline-loading fix, build logs, and packaged baseline regression. Probe DOM
setup/evaluation is explicitly instrumented and is not substituted for the real
system-input actions used by the shared scenario.

The expanded fixture revision `17938996093131285980887163588606100000001` also
passed actual browser taps and native back/forward for same-URL and relative
path/query history entries, followed by a message proving the bridge survives.
The Android-specific reload following each same-URL/path-query traversal also
passed, followed by a fresh quoted Unicode post after the new document became
ready. `session.describe.platform` was verified as `android`, so those branches
ran. The final report is `playwright-attempt7.json`.

The separate test-APK mode `-e mode inline-source-race` is a white-box native
lifecycle regression, not React E2E/system-input evidence. It creates an adapter
WebView, records actual platform start/finish callbacks, then rapidly requests
A/B/C source replacement. Actual callbacks observed A then C; B was superseded
before a platform start. It verifies unique source URLs, drops two prior-source
native evaluation callbacks, rejects an old document token replayed from the real
current DOM, and observes current C messages in the Hermes event recorder.
Actual DOM fetches for the current source URL, an unregistered path and a stale
source URL all receive 410 as subresource requests; their status report is an
additional current C message.
The B-epoch callback deliberately bypasses public command admission, which would
reject an unready document; the report states this explicitly. Reflection checks
the adapter's one current resource and C HTML, not browser-engine cache memory.
Its final evidence is `source-race-attempt3.log` and `source-race-evidence.json`.

## Controlled TextInput event ordering

Each native text edit increments a per-node counter before its event is queued.
The renderer returns the acknowledged count in its internal
`mostRecentEventCount` property. Android applies a controlled value only when
that count equals the current native count, preventing an older JS echo from
replacing newer text still awaiting event delivery. Programmatic mount/commit
writes and `clear()` remain silent and do not increment the counter. A same-value
acknowledgement preserves selection. This is an internal prototype protocol,
not a new public React Native prop contract or complete IME conformance.

On the Pixel 2 XL, `-e mode text-input-race` passed eight assertions using actual
EditText changes A/AB/ABC in one UI turn. This deterministic white-box native
queue test rejected two stale controlled writes, retained ABC with count/ack 3,
and preserved selection at position 1. It is explicitly not system-input proof.
Separately, `-e mode text-input-system` passed 394 assertions over three real
UiAutomation keyboard bursts (110/96/158 key events, asynchronous injection),
verifying the complete native and React values and monotonically increasing
counts. That system run observed no rejected stale writes; the deterministic
test is the one that proves guard activation. The packaged 24-assertion baseline
also passed. Debug and Release builds include the AppState integration; the
Release artifact currently contains the standard Demo, not the staged shared
performance workload. Evidence is in `.cache/physical-text-input/`.

## Debug development update ingress

The Debug application has an opt-in loopback transport independent of the test
APK. Before startup, the desktop helper writes app-private
`files/native-dev-session.json` with exactly `schemaVersion: 1`, a 64-character
lowercase hexadecimal `token`, a nonzero 32-character hexadecimal `sessionId`,
`initialRevision`, a 64-character hexadecimal `initialBundleSha256`, and integer
`port` (zero selects an ephemeral port). The canonical regular file is limited
to 4 KiB. Startup verifies the selected bundle revision and opens the C ABI
session against the actual loaded bundle digest and current host generation.
It atomically publishes `files/native-dev-ready.json` with status, port, session,
revision, generation as a decimal string, and process ID. The receipt never
contains the token. A rejected configuration publishes a bounded startup error.

Each request and response is a four-byte big-endian length followed by UTF-8
JSON. The first request is `{method:"authenticate",token:"..."}`. A successful
response is `{id:null,result:{authenticated:true}}`. Authenticated methods are
only `dev.status`, `dev.enqueue`, and `dev.drain`; the latter two remain separate
owner-thread tasks. Enqueue takes string fields `generation`, `sessionId`,
`sequence`, `baseRevision`, `targetRevision`, `payloadSha256`, and `payloadHex`.
Generation and sequence are canonical positive decimal uint64 strings, never
JSON numbers. The parser rejects duplicate or unknown fields, escaped field
strings, non-ASCII wire strings, and noncanonical numbers; JavaScript source is
hex-encoded raw UTF-8 bytes, so Unicode source survives JNI without modified
UTF-8 conversion. Native session/sequence/base/digest admission and terminal
replay remain authoritative. The endpoint does not forward arbitrary runtime
or application methods.

The maximum authenticated frame is 8 MiB + 16 KiB, with a 4 MiB decoded payload
limit. Unauthenticated frames are limited to 1 KiB. The listener accepts one
active connection and one in-flight request. It allows 60 seconds waiting for
an authenticated first header byte, five seconds for an unauthenticated first
byte, and five seconds for the remaining header, body, or response. Each
partial-operation deadline is absolute even when bytes continue arriving.
Owner acknowledgement has a ten-second deadline. Disconnect invalidates queued
work; an operation already executing can complete and be recovered by the
native duplicate replay contract. Activity destruction invalidates queued tasks
and closes sockets before destroying Hermes. Network code does not dereference
the native host or access JSI.

Debug uses `NH_DEV_UPDATES=ON`; Release uses a no-op lifecycle class with no
JNI development declarations, `NH_DEV_UPDATES=OFF`, and
`NH_PRODUCTION_ARTIFACT=ON`. The application build rejects production and
development flags being enabled together. The tested Debug APK also has
`NH_TEST_HOOKS=ON`; the transport implementation does not require those hooks,
but this Android run does not prove a hooks-disabled Debug artifact.

On the physical Pixel 2 XL, the dedicated command
`adb -s 805KPFX1843819 shell am instrument -w -e mode dev-transport dev.nativehost.experiment.test/dev.nativehost.HostInstrumentation`
passed 30 assertions: authentication, strict schema and size limits, a real
five-second trickled-body timeout, raw Unicode source executed by Hermes,
separate enqueue/drain, terminal replay, and queued request cancellation after
disconnect or host destruction. The queued scheduling cases deliberately hold
the UI thread and inspect the pending runnable; they are native lifecycle
white-box tests over real sockets, not React compiler/Refresh evidence. The
regression removes only its own session files and destroys its host. Cleanup
verified the configuration and receipt absent and target process exited.

Debug/Release/test builds passed. The APK scan found eight Debug C/JNI dev
exports and all eight expected transport strings; Release contained none of
those exports or strings in its host library or DEX files. Raw evidence and
artifact SHA-256 hashes are in `.cache/dev-transport-physical.log` and
`.cache/dev-transport-verification/{artifact-scan,physical-cleanup}.json`.

### Surface geometry before runtime creation

Android creates the runtime only after the actual surface has both positive
width and positive height. A one-shot layout gate posts bootstrap outside the
layout callback, detaches before creation, and cancels its queued attempt and
listener during Activity teardown. A zero-size window remains pending without
polling or a fixed delay; native viewport validation still rejects zero sizes.
AppState is sampled when creation actually occurs. This handles delayed window
layout, including an observed startup while the physical device was dozing,
without treating the absent initial layout as a permanent runtime failure.

The `surface-bootstrap` instrumentation mode uses actual Android View layouts
and the UI queue to check each zero dimension, transition to positive geometry,
exactly-once execution, and teardown before a queued positive-layout attempt.
It is a deterministic lifecycle regression, not a simulation of device Doze.

After the geometry fix, Debug, Release, and test APK builds passed. On the
awake Pixel 2 XL, `surface-bootstrap` passed all six gate assertions plus the
instrumentation's real Activity runtime health check: bootstrap count one,
cancelled bootstrap count zero. Evidence is `.cache/surface-bootstrap-physical.log`;
updated artifact hashes and Release string checks are in
`.cache/dev-transport-verification/artifact-scan-surface-bootstrap.json`.
The original dozing-device Refresh attempt failed before updates and remains
separate evidence; this regression does not relabel that attempt as successful.
