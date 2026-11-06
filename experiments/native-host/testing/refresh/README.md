# Native Refresh experiment

The compiler and renderer gates execute actual Rolldown module patches in the
existing Hermes host. They do not reload the application IIFE to imitate updates.
React, reconciler, services, root and Refresh runtime remain permanent. Only
application modules within the declared mutable directory participate in update
propagation. The ordinary full-reload development path remains available.

## Evidence boundaries

- `compiler/run.mjs`: browser-free compiler/runtime feasibility, real Hermes,
  changed imports, CJS, repeated patches and compile error/fix. The common runtime
  source is adapted before bundling to remove unsupported browser lazy loading.
- `react/run.mjs`: real React Refresh with hook signatures, handlers/effects,
  state/input/ref/node identity, nested component families and service continuity.
  This gate uses the existing test-only evaluator for inspection and delivery.
- `react/ingress.mjs`: real compiler/React patches through the dedicated C ABI,
  with native test evaluation disabled. Includes native preparation rejection,
  subsequent sequence recovery, incompatible hooks and poisoned-session behavior.
- `../../runtime/dev/test-matrix.py`: ingress enabled/disabled crossed with test
  hooks enabled/disabled, payload integrity, ownership/reentry, bounded queues,
  duplicate delivery, lifecycle/service continuity, watchdog and production guards.

Each run writes a timestamped report under ignored `build/refresh/`. Failed runs
remain evidence. A forced child termination after all successful compiler checks
must still produce `status: failed`; successful assertions do not excuse teardown
failure. These gates do not establish mobile delivery or a performance win.

## Dedicated mobile development connection (wire v1)

This is separate from app testing and is enabled only by an explicit private
Debug session configuration. The device listens on IPv4 loopback. Android uses
an owned ADB forward; iOS can use the simulator loopback or a USB forward. Each
message is a four-byte big-endian byte length followed by a UTF-8 JSON object.
The frame limit is `2 * 4 MiB + 16384`; source is lowercase hex so JNI preserves
exact bytes. A compact raw-byte wire format can be evaluated after correctness.

The first request is `authenticate` with a random 32-byte token encoded as 64
lowercase hex characters. Subsequent requests are allowlisted `dev.status`,
`dev.enqueue` and `dev.drain`, returning the existing C ABI result/error JSON.
No evaluation, app-event or browser-test methods are exposed. The native owner
thread opens the session against the actual initial artifact digest and host
generation before listening. Network work never retains JSI values or an
unprotected host pointer. Disconnect cancels UI tasks that have not started;
an already executing update can finish and its acknowledgement can be replayed.

The private device file `native-dev-session.json` contains exactly `schemaVersion`
(1), `token`, `sessionId` (16 bytes as lowercase hex), `initialRevision`,
`initialBundleSha256`, and `port` (0 requests an ephemeral port). The selected
bundle revision must match. A separate ready receipt contains the actual port
and identity, never the token. Desktop configuration additionally has
`host: "127.0.0.1"` and the forwarded port. Tokens are never logged or placed in
process arguments. An old configuration for another selected bundle stays
inactive. Release artifacts must exclude ingress and listener implementations.

Rust's separate desktop transport owns sequential delivery and acknowledgement
validation. It never coalesces dependent patches. A lost acknowledgement may
replay the exact pending/latest payload only after validating the same live
session, generation, digest, revision and accepted sequence. A restarted desktop
process does not guess unknown history. Compilation errors leave the running
app intact; execution failures require a full reload. The first publisher stops
on any non-applied terminal result rather than silently restarting the app.

`applied / mount-submitted` means synchronous Refresh, microtasks and native
commit returned. It does not prove an OS-visible frame or browser completion.
Physical verification must separately check the exact accessibility marker,
same PID/generation, state, focus/selection, scroll and WebView document identity.
The full RNTester baseline remains the comparison app.

## Physical Android packet

`mobile-android.mjs --serial DEVICE --observer /absolute/private-observer.json`
owns its publisher, staging/forward configuration and source edits. Start the
already-built external OS observer separately as documented in
`performance/android/observer/README.md`. The packet wakes the device, verifies
an awake display, then performs actual typing/taps/swipes and four compiler
patches. It checks counter/input/focus/caret/visible row geometry, compile error
and fix, component-body edit, same process/generation and unchanged installed
APK. It restores sources only if they still match its own writes, removes its
owned forward/config and verifies a fresh healthy receipt for the prior fixture.
The default closes only its observer client; add `--close-observer` when this
test also owns the external observer session. Publisher shutdown uses the shared
bounded process-group owner, including interruption and descendant cleanup.

The passing run is `build/refresh-mobile/1793907307105-14710/report.json`.
The earlier `1793907003426-8144` attempt failed before applying any patch: a
dozing Pixel reached host creation with a zero viewport, then deployment timed
out and fixture restoration could not establish health. That failed report is
retained. The resulting native layout-readiness gate waits for positive geometry
and cancels on teardown; deployment timeouts now terminate the owned deployer
and its descendants. This packet is correctness evidence, not a speed result.

The separate [WebView packet](./webview/README.md) verifies two real browser
documents across revision and component-body updates, followed by an explicit
one-browser replacement. Its Android evidence does not substitute for iOS,
cookie/storage policy or browser-process recovery checks.
