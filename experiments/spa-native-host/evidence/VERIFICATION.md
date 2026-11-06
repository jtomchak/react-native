# Prototype verification — 2026-11-05

Historical initial-prototype baseline. Later hosted mode, native shell and
integration results are recorded separately in
[HOSTED-VERIFICATION.md](HOSTED-VERIFICATION.md). Counts and artifact hashes below
describe their original runs; they are not claims about the later binaries.

Working standalone prototype: Next.js static-export SPA, our own Swift/UIKit/
WKWebView and Kotlin/Android WebView hosts, framework-neutral document-start SDK,
native navigation controls/presentation, haptics, SQLite storage and native still
capture with managed photo files. No Capacitor, React Native, Hermes, Yoga, or
Rust runtime is linked into these hosts.

The initial runtime dependencies and iOS development provisioning were explicitly
approved. No commit or push was made. The earlier `experiments/native-host/`
experiment is independent and its historical results are not this host's results.

## Verified behavior

| Check | Result | Evidence |
| --- | --- | --- |
| Packaged Next build | Exported three application routes and 40 hashed assets | `build-assets.json`, `../build/web/asset-manifest.json` |
| SDK/history/tooling contracts | 29/29 Node tests pass, including bounded subprocess shutdown | `node-tests.log` |
| Browser application tests | 6/6 Playwright cases pass; native transport is explicitly mocked where used | `browser-results.json` |
| Browser without native host | Client route/reload works; native services report UNAVAILABLE; no page errors | `browser-smoke.json` |
| Real Next development server | Browser component edit/restore preserves draft and document | `browser-hmr.json`; native-device receipts below are separate |
| iOS simulator | 8/8 actual WK/native XCTest cases pass, including lossless NUL/non-BMP storage strings | `../hosts/ios/build/evidence/simulator-final-tests.log` |
| Physical iPhone 12 | 9 fixed in-app WK/native checks plus 2 storage checks after SIGKILL/relaunch; PID 1859 → 1864 | `ios-physical.json`, `../hosts/ios/build/evidence/physical-final-smoke/` |
| Physical Pixel 2 XL | 47 native/WebView assertions plus 6 checks in a new process; PID 27955 → 28089 | `../hosts/android/evidence/1793914635236611000/report.json` |
| iOS native OS navigation | Simulator OS native Compose/Back taps and warm/cold canonical deep links pass | `../hosts/ios/build/evidence/simulator-native-back-os.json`, `simulator-deeplink-{warm,cold}.json` |
| iOS development mode | Explicit Debug Next origin passes 8 fixed actual WK/native checks | `../hosts/ios/build/evidence/simulator-dev-smoke.json` |
| Android development mode | Actual native storage and public HTTPS API response work from Debug origin | `../hosts/android/evidence/pixel-dev-probe.json` |
| Android APK Fast Refresh | Changed/restored component heading, same draft/document/session/PID, then one native Save event and one SQLite write | `../hosts/android/evidence/pixel-final-hmr-{before,changed,restored}.json` |
| Native builds | iOS Debug/device and Release/simulator built; Android Debug/test and unsigned Release built | Host build logs and `../hosts/android/evidence/artifacts.json` |
| Release separation | iOS fixed probes/dev flags/Debug ATS excluded; Android dev-origin/cleartext/inspection gated out | `ios-release-guards.json`, host build configurations |

Native simulator cases exercise real packaged Next fetch/client navigation,
document continuity/reload, early SDK injection without a page SDK tag, native
validation/subframe rejection, SQLite, UIKit presentation, quota rollback, and
canonical resource/deep-link validation. Physical iPhone probes are fixed,
Debug-only in-app observations, not independent OS touch automation.

The eighth simulator test verifies NUL/non-BMP storage key/value preservation,
distinct prefix keys and deletion through both SQLite and the actual WK bridge.
The latest Pixel assertions verify the same valid strings, including after a
genuine process termination and restart.

Pixel assertions exercise the actual origin-aware WebView transport, native
toolbar/dialog/vibrator invocation/SQLite, same-document Next navigation and
correlated Back acknowledgment, duplicate side-effect prevention, malformed
arguments, same-origin iframe denial, retired document rejection and both HTML
fixtures. The final disk-queue stress admits 64 actual native reads then cancels
delivery: further work is rejected across document replacement until the disk
jobs finish. Force-stop/relaunch independently verifies committed storage.

Both hosts inject the complete bundled SDK before inline page code; the
`/injected.html` fixture contains no SDK tag or React/Next/Stimulus dependency.
Android assembly hashes every packaged asset, including `_next`, against the
staged manifest. The final iOS physical Debug and simulator Release web resource
maps match the staged resources, including the manifest.

## Development refresh evidence

The browser's real Next Fast Refresh edit/restore receipt is separate from mock
service tests. Physical Pixel refresh receipts record the actual document,
native session, process, draft and visible heading before, during and after an
edit; they also check a real native Save tap. A first attempt did not show the
changed heading and remains in `pixel-hmr-{before,changed,save}.json`.

A subsequent run after React history-subscription deferral and a fresh direct
route entry passed changed/restored headings, unchanged draft/document/session/
PID, and one native Save event/one storage write. Its receipts are
`pixel-hmr2-{before,changed,restored}.json`. Those used an earlier native APK;
the retake binding the complete bundled SDK and disk-bound APK is recorded as
`pixel-final-hmr-*.json`. Those files explicitly identify APK SHA-256
`9aaa215d7bd2ce977de47685bc0c9de92f4fba2a5a99d308d9201bc99e2c6181`.
The later storage-only NUL validation change has separate artifact hashes and
native round-trip tests; the refresh receipts do not claim that later APK was
rerun. Do not attribute the first failure solely to the React warning: the
fresh-entry condition changed too.

Temporary source edits are restored using a captured SHA-256 and conditional
overwrite. `build-assets.json` records the expected original Compose source
hash, SDK hash and final packaged asset-manifest hash. No speed advantage or
edit latency benchmark is claimed by these functional checks.

## Important fixes and retained failures

- Android's default AAPT asset filtering omitted `_next`; the build now retains
  it and verifies all asset bytes in each APK.
- iOS custom-scheme fetch initially returned status zero. Explicit response
  status and real Next route/document continuity checks fixed this gate.
- Stale iOS async completion could remove a replacement document's pending
  request with the same ID. Admission/session ownership is now checked first.
- Native deep links now share `spahost://app/<route>` and preserve trailing
  slashes; real warm/cold OS delivery exposed and verified the iOS fix.
- Next history mutation during insertion effects exposed synchronous React
  updates. History bookkeeping stays synchronous, but React notifications are
  deferred/coalesced with cleanup guards; development navigation has no such
  console warnings after the fix.
- macOS process-group teardown briefly returned EPERM during disappearance.
  Bounded retries require a fresh ESRCH before accepting absence; persistent
  permission errors fail. Eight subprocess cases and 160 stress repetitions
  passed after the fix; the reproduced failure was not ignored.
- Device fixture failures from startup navigation races, restored-route
  assumptions, and SDK cancellation before native admission were corrected
  without weakening their acceptance assertions. Failed reports are retained.
- Storage generic validators initially rejected embedded NUL. The underlying
  Swift SQLite C-string calls would also truncate it if called directly. Storage
  now opts into valid NUL/non-BMP strings on both hosts, with explicit byte-length
  Swift binding/reading and actual SQLite/WebView regressions. Other string
  restrictions stay intact. This was an unsupported storage input at the host
  boundary, not a demonstrated externally reachable key-collision exploit.

## Remaining acceptance gates

- Attended real photo capture, preview/delete, permission denial/cancellation,
  and camera activity/process interruption on both physical devices. Native
  implementation exists; no simulated image is presented as a real capture.
- Perceived haptic output. Automated native API invocation proves dispatch only.
- Exhaustive keyboard/IME, interactive gestures, text scaling/accessibility,
  browser renderer recovery, and deep-link/restoration permutations.
- Release runtime execution and production signing/distribution. Successful
  Release compilation and exclusion checks are narrower evidence.
- Controlled startup, memory, frame behavior and development/build performance
  comparisons. Functional build timings are not a comparative benchmark.

See the [iOS guide](../hosts/ios/README.md),
[Android guide](../hosts/android/README.md), [protocol](../protocol/CONTRACT.md)
and [implementation plan](../PLAN.md) for repeatable commands and scope.

## Handoff state

Physical iPhone normal packaged app restored, PID 1868; Pixel packaged home
restored, PID 28212. Native screenshots were inspected. Temporary Compose edits
are restored to the source hash in `build-assets.json`. Owned development and
preview HTTP ports 18795/18796 are closed; no owned Android forwards/reverse
remain. Pre-existing Android reverse 18791 was preserved. No commit or push.
Independent source review found no remaining blocking findings after the narrow
storage fix; review is not a substitute for the remaining hardware gates above.
