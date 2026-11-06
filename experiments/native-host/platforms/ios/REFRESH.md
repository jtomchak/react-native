# iOS development update connection

`NHDevUpdates` is an explicitly enabled Debug-only loopback server for the
dedicated native development C ABI. It does not expose the app test protocol or
`runtime.eval`, and does not require XCTest. Actual component update semantics
come from the permanent Refresh bootstrap and compiler patches; a successful
transport script is not evidence of React compatibility.

The Debug app reads `native-dev-session.json` only when present in its development
directory: the app data-container root on Simulator, and `Documents` on physical
iOS. The latter is still inside the private prototype app container.

```json
{"schemaVersion":1,"token":"<64 lowercase hex>","sessionId":"<32 lowercase hex>","initialRevision":"<selected revision>","initialBundleSha256":"<64 lowercase hex>","port":0}
```

These are the exact six keys. The copied file must be regular, nonsymlinked,
bounded to 4096 bytes and inside the private app data container. The adapter
restricts its permissions to 0600 before reading. It verifies the selected
revision and opens the C ABI session against the exact loaded bundle digest.
An invalid or stale config writes an error receipt and leaves the ordinary app
running without a listener. No configuration means no listener.

The listener binds only `127.0.0.1`. Port zero selects an ephemeral port; the
atomic `native-dev-ready.json` receipt contains the chosen port, session/revision,
decimal-string generation and process ID. It also records one-time native SHA-256
hashes of the app executable, optional Debug implementation dylib, packaged bundle
and embedded Hermes framework. It never contains the authentication
token. Every launch removes the previous receipt. Transport shutdown writes
`status: stopped` with port zero. Simulator processes share the Mac loopback;
a physical device needs a separately owned USB port forward.

Each frame has a four-byte, big-endian byte length followed by UTF-8 JSON.
The maximum frame is 8 MiB plus 16384 bytes. Authentication is the first frame:
`{"method":"authenticate","token":"<token>"}`. Success returns
`{"id":null,"result":{"authenticated":true}}`. Subsequent methods are only
`dev.status`, `dev.enqueue`, and `dev.drain`. Enqueue uses the flat string fields
documented by `runtime/dev/README.md`; binary UTF-8 JavaScript travels as
lowercase `payloadHex`. Control strings are unescaped ASCII; duplicate/unknown
keys, nested values, booleans, noncanonical integers and trailing input reject.
The adapter returns the C ABI result/error JSON without converting acknowledgement
into a claim about displayed frames.

One IO worker handles one connection and at most one queued owner task. A stalled
or disconnected client cannot accumulate retained payloads while the main queue
is blocked. Unauthenticated/partial frames have five-second bounds; an idle
authenticated header has 60 seconds. Disconnect before execution cancels the
queued task. An already executing task may finish: reconnecting clients must use
the same identity and C ABI duplicate replay, never assume a lost reply means no
execution. Every owner task resolves the current controller through a weak
reference and checks epoch/generation. Shutdown invalidates queued work and
shuts sockets before host destruction. Enqueue and drain run in separate main
queue turns.

## Builds and checks

From repository root:

```sh
bash experiments/native-host/platforms/ios/build.sh
NH_CONFIGURATION=Release bash experiments/native-host/platforms/ios/build.sh
NH_TEST_HOOKS=0 \
  NH_DERIVED_DATA="$PWD/experiments/native-host/platforms/ios/build/dev-only" \
  bash experiments/native-host/platforms/ios/build.sh
```

The last command builds Debug development ingress without app or service test
hooks, using the ordinary Rust core. Release defines `NH_PRODUCTION_ARTIFACT=1`
and excludes the listener, config paths, development C ABI and Refresh source.
The host header rejects a simultaneous production/development definition.

After installing the chosen Debug app into an explicitly selected simulator:

```sh
python3 experiments/native-host/platforms/ios/test-refresh-transport.py \
  --simulator D942F30F-EB29-4921-892E-5F3160A038A3 \
  --report experiments/native-host/platforms/ios/artifacts/refresh-transport-hooks-off.json
```

The script temporarily configures and restarts the prototype, checks malformed
control input/authentication/bounds and a FIFO config with no writer, actual native apply and duplicate replay,
disconnect around drain, prepare failure preservation and execution poisoning.
It verifies actual simulator process identity, generation, Unicode source bytes
and unchanged launcher, Debug dylib, Hermes and bundle hashes. It restores the prior config and relaunches the
packaged fixture on completion; each cleanup failure invalidates the report.
It deliberately uses small C ABI scripts, not fabricated React Refresh output.

Verified 2026-11-05: 15 checks passed in normal Debug; the additional FIFO regression
brings the Debug-with-test-hooks-off run to 16 checks. Evidence is `artifacts/refresh-transport.json` and
`artifacts/refresh-transport-hooks-off.json`. Release symbol/string absence is
recorded in `artifacts/refresh-release-exclusion.json`. Transport-only checks do
not by themselves prove React update semantics or source-edit-to-display latency.

## Initial bundle staging

Development builds create a dedicated `dev-revisions` directory and exclude it
from backups. Existing verified immutable revisions are selected with
`--native-host-revision <digits>` independently of test hooks. Simulator keeps its
existing app data-root path and atomic staging script. Physical iOS uses
`Documents/dev-revisions`; the tested iPhone rejected a data-root mkdir with
NSCocoaErrorDomain 513 / underlying NSPOSIXErrorDomain 1 (`Operation not permitted`).
The actual native error and launch PID are retained in
`artifacts/refresh-device-stage-probe.json` and its `-launch.json` companion.

An explicit Debug launch with `--native-host-stage-revision <1-64 digits>` reserves
one empty, canonical revision directory. It refuses a nonempty existing revision
or a symlink; it accepts no caller-supplied paths. The connector copies the three
locally verified artifacts into that directory with `devicectl`, then the app
verifies manifest, lengths and hashes before evaluating the initial bundle.
`--native-host-end-session <session-id>` removes only the matching private config.
Each staging/disconnect receipt is bound to the fresh PID returned by that exact
`devicectl` launch plus action and revision/session, so a stale `prepared` receipt
cannot authorize overwriting a prior revision.

`scripts/connect-refresh-ios.py` connects either `--simulator <uuid>` or
`--device <udid>` with `--session <publisher/session.json>`,
`--revision-directory <immutable-directory>` and `--output <private-desktop.json>`.
The physical path owns an explicit `iproxy` process; `--disconnect` validates the
saved PID/start/command identity before removing the forward and owned app config.
Compiler updates after this initial staging need neither a native rebuild nor
XCTest. Authentication tokens stay in private files, never argv or printed results.

## Actual React update validation

`testing/refresh/mobile-ios.mjs` drives the real publisher and Rust transport while
an independent XCTest runner observes native accessibility and performs actual
coordinate taps, keyboard input and scrolling. The app is built with both app
and Rust service test hooks disabled. The app's development connection itself
does not depend on that observer.

The simulator observer is described in `performance/ios/observer/README.md`.
For a physical run, `platforms/ios/start-refresh-observer.py --device <udid>
--team <authorized-team> --config <private-observer.json>` builds the same observer
source in a separate project using the already-authorized
`dev.nativehost.prototype.uitests.xctrunner` identity. Its private configuration
includes `platform: "ios"`, token, desktop `port`, `devicePort`, and
`timeoutSeconds`. It owns and closes its USB forward and requires one passing
observer test. No additional app ID or signing team is selected implicitly.

```sh
node experiments/native-host/testing/refresh/mobile-ios.mjs \
  --device 00008101-001C74580AE3001E \
  --app experiments/native-host/platforms/ios/build-device/dev-only/Build/Products/Debug-iphoneos/NativeHost.app \
  --observer <private-observer.json> --close-observer
```

Use `--simulator <uuid>` instead of `--device`/`--app` for Simulator. The explicit
`--close-observer` flag is appropriate when the caller owns that runner; otherwise
the harness closes only its own socket. Publisher cleanup owns the process group
including Rust descendants. Source restoration is compare-and-swap, failures and
cleanup failures remain in the final report, and the previous healthy app fixture
is restored through normal OS launch plus independent accessibility readback.

Verified 2026-11-05 on both the dedicated simulator and physical iPhone 12:

- Four genuine compiler patches retained OS process, runtime epoch/generation,
  counter state and actual keyboard-entered input.
- Native ScrollView visible row geometry stayed identical across an update.
- A compiler syntax error left the app running; its fix preserved state.
- A component-body edit changed the visible marker while preserving state and
  a subsequently exercised press handler.
- Shared workload bytes matched the full RNTester reference. Public OS screenshots
  were inspected for the image, input and native scroll clipping.

Simulator evidence: `build/refresh-mobile-ios/1793907947835-25715/report.json`.
Physical evidence: `build/refresh-mobile-ios/1793909239599-60054/report.json`,
with one passing independent observer test in
`artifacts/refresh-observer-device-1793909194844542000.xcresult`.
The phone's one-time native artifact hashes matched the signed local build;
the local artifact map was also unchanged before/after. The phone artifacts
were not rehashed after the patches. Continuous OS PID and runtime epoch were
observed. Public XCTest snapshots do not expose caret selection/focus, so those
are not claimed. This packet is functional evidence, not a latency benchmark.

Prior failed attempts remain: the simulator connector option-order failure,
the physical XCTest automation timeout before any tests, and the data-root staging
failure before patches. The latter motivated the measured Documents fix above.
Six no-device connector regressions cover FIFO rejection, timeout/interrupt
descendant cleanup, stale receipt identity and forced USB-forward rollback:
`python3 experiments/native-host/platforms/ios/test-refresh-connector.py`.
