# Stock RNTester Android reference

This lane builds the **full RNTester app** from the detached source checkout at
`fe398e511d7b4cfa22baf5b449e256ff9b7d66c4`. It keeps RNTester's native components,
menus, examples, JS dependency graph and source ReactAndroid dependency. The
shared performance screen is registered alongside existing examples by the
separate shared adapter setup. This is not a minimal HelloWorld baseline.

Run from `experiments/native-host`:

```sh
python3 performance/android/setup.py
python3 performance/android/build.py --variant debug --label initial-setup
python3 performance/android/build.py --variant debug --label noop-setup
python3 performance/android/build.py --variant release --label initial-setup
```

Setup refuses any checkout except the task-owned, pinned, detached
`build/reference`. It changes the application ID to `dev.nativehost.reference`
and its BlobProvider authority, while preserving the Java/Kotlin namespace. It
writes the local SDK location and records the React/Hermes versions. It does not
install dependencies, prune the app graph, build, install, or operate a device.
Existing unrelated reference edits are preserved.

The build wrapper uses the stock Gradle wrapper and root project, arm64-v8a,
New Architecture, four workers/active Java processors, and Metro port 18791.
Stock AGP invokes Ninja without an explicit job limit; the Gradle worker setting
does not fully limit native compiler fanout. That native parallelism is recorded
as uncontrolled for these setup builds.
The root RNTester project already depends directly on source ReactAndroid. Its
stock nightly flag substitutes the Hermes engine source project with the exact
Hermes artifact selected by the reference workspace (`260318099.0.6`). Headers,
compiler and runtime must match that reference version; the candidate prototype
currently uses a different Hermes version. No RN WebView dependency is added.

Raw logs/results go under ignored `build/performance/android/`. Each result
records the exact command, source revision/status, tool versions, elapsed wall
time, and APK sizes/hashes. These setup timings run amid other work and have
uncontrolled cache state; they are **not publishable comparative performance**.
The wrapper never cleans. A `--label cold` string would only be a label, not
proof of a cold build. A controlled cold-build protocol must separately define
which outputs/caches are absent. Existing codegen/dependency preparation from
other reference validation is not silently classified as cold.

Full RNTester versus the small candidate measures different application graphs.
Build or development timings from that comparison cannot isolate bundler,
renderer or language speed. Matched runtime work must use the same registered
workload and readiness marker, and report toolchain/Hermes differences.

Device operations are intentionally separate from setup/build. Only after the
parent coordinates access to the Pixel 2 XL (`805KPFX1843819`), install the chosen
variant in the isolated package and start
`dev.nativehost.reference/com.facebook.react.uiapp.RNTesterActivity`. The shared
adapter uses the existing `--es route NativeHostPerformance` launch extra.
Debug requires a dedicated Metro server on port 18791 plus an explicitly scoped
ADB reverse; release uses its packaged bundle. Do not clear unrelated apps,
browser data, or system caches. A successful APK build is not device-launch or
workload-marker verification.

## Functional preflight evidence

Debug and Release APKs built successfully. Initial uncontrolled setup durations
were 172.58s for Debug, 7.68s for its subsequent no-op invocation, and 216.64s for
Release. These are retained raw setup observations, not a speed comparison or
a cold-build claim. Debug APK size was 42,008,197 bytes; Release was 21,000,212.
Exact logs, versions and hashes are in `build/performance/android/*/result.json`.

On the Pixel 2 XL, the separate external observer verified both stock RNTester
and the candidate using the same shared workload: exact `baseline-000` marker,
actual typing and count update, 100 native accessibility row nodes, reverse
ordering, a real swipe changing the visible rows, unmount/remount, and state
reset after stopping/relaunching each target. The same observer process and
TCP connection survived each target force-stop. Screenshots visibly show the
decoded blue image in both applications. The Release reference also launched
its packaged workload with the expected marker and rows; Debug was restored.
This establishes functional readiness, not comparative timing, memory or FPS.

`functional-preflight.py` reproduces those OS-accessibility/input checks against
an already running observer and a freshly launched target. Pass `--config`,
`--serial`, `--package`, an evidence `--label`, and for the candidate its exact
`--candidate-revision`. It force-stops/relaunches only the selected task package
to test observer independence. Image decode remains separately verified by
the screenshots; accessibility node presence alone does not prove decoding.

Raw evidence includes `reference-functional-preflight.json`,
`candidate-functional-preflight.json`, `reference-release-marker.json`, native
accessibility snapshots, and screenshots. The first failed reference preflight
is retained: it was confounded by a candidate foreground launch while a wait
was pending, so it does not establish an RN or Android cache defect. The
observer now explicitly refreshes nodes before matching; subsequent complete
functional runs were sequential and passed.
