# Prototype verification — 2026-11-05

This is an evidence ledger for a prototype, not a compatibility or performance
certification. Physical-device results are recorded explicitly below. No native
build or end-to-end development speed improvement is claimed.

## Environment and version boundaries

- Reference RN checkout: `fe398e511d7b4cfa22baf5b449e256ff9b7d66c4`, detached
  worktree at `build/reference`. Its installation changed only the expected
  Hermes placeholder and lockfile in that separate worktree.
- Candidate React `19.3.0`, reconciler `0.34.0`, Rolldown `1.3.0`, Playwright Test
  `1.64.1`. These prototype dependencies were approved by the user.
- Candidate Hermes bootstrap artifact `250829098.0.16`, matched headers/VM;
  reference uses a newer Hermes family. Results are not version-equivalent.
- Xcode 26.6, iOS simulator 26.5; Android 36 arm64 task-owned emulator; Java 17;
  initial setup Node 24.19.0; later tooling/performance runs Node 26.7.0; Rust
  1.93.0. Each run's manifest is authoritative. Native production packaging is
  still platform-specific.

## Observed checks

| Lane | Command / evidence | Observed result |
| --- | --- | --- |
| Rust service core | `cargo test --manifest-path core/Cargo.toml --all-features` | 21 passed: cancellation/completion races, shutdown, generations, bounded resources, copied buffer lifetime, reentrancy and wrong-thread rejection |
| Native host, test hooks enabled | `ctest --test-dir build/headless --output-on-failure` | 1 contract executable passed |
| Native host, test hooks disabled | `ctest --test-dir build/headless-release --output-on-failure` | 1 contract executable passed; arbitrary evaluation rejected |
| Real Hermes/JSI/C/Rust | `python3 runtime/test_services.py -v` | 9 passed, including asynchronous native error delivery and persistent runtime errors |
| Candidate React contracts | `npm test` | 22 passed, including atomic layout-effect publication, keyed identity, cleanup, committed handlers, recovery, submit dispatch, command-queue recorder cases and TextInput acknowledgement/stale-event behavior |
| Native driver transport | `npm run test:driver` | 2 passed, including a Unicode code point split across TCP chunks and strict action/health results |
| Shared case-level differential contracts | `npm run test:contracts` | 2 exact matches: layout-effect geometry/effect ordering and keyed state/public host-ref preservation; same component source in both runtimes |
| Differential comparator rejection checks | `npm run test:contract-comparator` | 12 passed; empty/missing/extra cases and observation/order/identity differences fail |
| Original RN reference | selected Timers/ShadowTreeBranching/UIConsistency/EventDispatching Fantom suites | Jest reports 32 passed, 2 skipped across 4 suites; **UIConsistency logs two failed assertions despite a green result** |
| Original RN primitive reference | View/Text/TextInput/Pressable/ScrollView/Image/Dimensions/Network Fantom suites | 605 passed across 8 suites; no assertion/component errors in the log; 2 display-metric warnings |
| Android instrumentation | `platforms/android/.cache/instrumentation-reviewed.log` | 24 assertions passed, including malformed WebView messages, native input, identity preservation, overlay hit blocking and two WebViews |
| Android shared Playwright scenario | `test-results/android-mobile-results.json` | 1 passed, 2.3s test duration, system input and healthy native runtime at teardown |
| iOS XCTest smoke | `platforms/ios/artifacts/ui-20261105-085130.xcresult` | 1 passed, 15.693s; native typing/taps, Rust echo, two WebViews and cover hit testing |
| iOS shared Playwright scenario | `test-results/ios-mobile-results.json` | 1 passed, 26.2s test duration; system input, both WebViews, overlay blocking, native health and immutable accessibility snapshot |
| Android injected runtime failure | `platforms/android/.cache/health-fault-evidence.json` | Healthy → injected async failure → unhealthy; acknowledgement preserves sticky failure; a new Activity/runtime restores health |
| iOS injected runtime failure | platform XCTest log/xcresult | Intentional asynchronous failure makes native health unhealthy and stays sticky after a successful native action |
| Independent external Maestro | `build/maestro-ios.xml`, `build/maestro-android.xml` | 1 flow passed on each platform, 9s iOS / 12s Android; no connection to embedded test hooks |
| Rust supervisor and real watcher | `npm run test:dev` | 4 Rust tests and 5 watcher integrations passed, including transform failure/recovery, burst edits, matched artifact pairs, deployment coalescing and descendant shutdown |
| Actual app source-write bundling probe | `node scripts/probe-app-watch.mjs` → `build/app-watch-evidence.json` | Two controlled runs measured 79.744ms and 79.530ms to a published immutable revision; source restored and supervisor exited cleanly; no statistical speed claim |
| Probe failure cleanup | `npm run test:probe` | 2 passed, including source disappearance while a real child process is running and preservation of multiple cleanup errors |
| iOS actual watcher revision reload | `platforms/ios/artifacts/ios-reload-evidence.json` | Original heading/Count1 → changed heading/Count0; new PID/runtime epoch; native binary hash unchanged; corrupt clone rejected before Hermes |
| Android actual watcher revision reload | `platforms/android/.cache/watch-reload/report.json` | Changed native heading/Count0 observed before instrumentation launch; new PID/session, old host destroyed; installed APK hash unchanged |
| Release override isolation | platform release verification evidence | Actual iOS and Android release apps ignored development overrides; Android run-as rejected; test transport excluded |
| Physical iPhone 12 | `platforms/ios/artifacts/iphone12-evidence.json` | Final source on iOS 26.1: 2 XCTest UI/failure tests passed in 24.061s, 1 explicitly skipped driver-only method, 0 failures; actual native input/Rust echo/two WebViews/overlay and sticky runtime fault |
| Physical Pixel 2 XL | `platforms/android/.cache/physical-pixel2xl/evidence.json` | Android 11/API 30: native instrumentation 24 assertions, shared Playwright 1/1 and independent Maestro 1/1 |
| Native-command ABI v1 | CTest in `build/headless-commands` and `build/headless-commands-release` | Hooks ON/OFF pass: capabilities/schema/generation/committed-target/arguments/ownership/wrong-thread/reentry; existing 9 service tests still pass |
| iOS native commands | `test-results/ios-commands-results.json` | Simulator: 1 passed, 92.5s, 0 skipped/flaky; native input focus/blur/clear, scrolling, browser commands, same-URL/path/query history, source/key replacement and remount |
| Android native commands | `platforms/android/.cache/physical-commands/evidence.json` | Physical Pixel: expanded commands including reload after same-URL/path/query history and fresh message delivery passed 1/1, 3.789s, 0 skipped/flaky |
| Android source replacement race and request scope | `platforms/android/.cache/physical-commands/` | Final native white-box test: 13 assertions passed, two stale evaluation callbacks dropped, only C messages delivered; B superseded before platform navigation began; actual DOM fetches of current/arbitrary/stale synthetic URLs all rejected as subresources |
| Matched tooling experiment | `build/tooling-benchmark/2026-11-05T16-55-44.067Z/report.json` | 65 artifacts passed same-Hermes semantic/map validation; warm 20-sample medians Metro 82.76ms / Rolldown 82.27ms; fresh-process 5-sample medians 288.16ms / 82.73ms |
| Full RNTester baseline | `performance/android/`, `performance/ios/` setup reports under `build/performance` | Android and iOS Simulator Debug/Release source builds passed; full app graph retained; setup timings include uncontrolled concurrent work and are not comparative benchmarks |
| RNTester shared-screen route | `build/reference-performance-route-evidence.json` | 8 tests passed across iOS/Android configurations: actual full RNTester graph, first-render route, updates/unmount, original menus and invalid-route rejection |
| Shared performance workload | `build/performance/workload-check.json` | Real-Hermes synthetic preflight passed; a forced native-process failure correctly invalidated the latest evidence before a successful rerun |
| Android external performance observer | `build/performance/android/*functional-preflight.json` | Both apps passed actual OS input/100 rows/reorder/scroll/unmount/remount; observer process/TCP survived target force-stop; decoded image inspected in screenshots; reference Release packaged marker also observed |
| Android workflow harness exercise | `build/performance/android-edits/1793901887608-2754/result.json` | One pair passed source write → full process reload → unique native accessibility marker; installed APK hashes unchanged and sources restored; exploratory only, insufficient samples for acceptance |
| Measurement failure handling | `node --test performance/process.test.mjs performance/paired-run.test.mjs` | 8 passed: stale/non-OS markers rejected, warmups excluded, failed pairs and failed state-preservation checks retained, full stdout captured, actual descendant stopped on timeout, overflow rejected |
| Reference Fast Refresh fixture | `build/reference-refresh-boundary-evidence.json` | Actual Metro loader/Refresh runtime tests: old mixed-export adapter resets state; split component boundary preserves counter/input across two edits; physical state/process preservation subsequently passed the repeated default-workflow packet below |
| Real AppState service | `platforms/android/.cache/app-state-evidence.json`, `platforms/ios/artifacts/app-state-evidence.json` | 1/1 physical test passed on each phone: actual Home/foreground transitions, Rust asynchronous snapshots, ordered callbacks, same process/generation, unsubscribe with independently advancing snapshot sequence |
| Controlled native text input | `platforms/android/.cache/physical-text-input/evidence.json`, `build/performance/ios/candidate-input-guard-functional-preflight.json` | Android queued-edit test: 8 assertions/two stale writes rejected; 3 actual OS key bursts/394 assertions; iOS simulator: 6 rapid real keyboard replacements preserve exact native and React text |
| iOS shared-screen visuals and observer | `build/performance/ios/candidate-input-guard-functional.png` and preflight evidence | Actual image decode, default input border and scroll clipping visually verified; independent XCTest runner survives target termination/relaunch; full RNTester functional screen also exercised |
| Android repeated default workflow | `build/performance/android-edits/1793903624832-39064/result.json` | 30 measured pairs + 3 warmups, zero failures: median RNTester 824ms / candidate 2152ms; reference preserves state/process, candidate resets; initial idle iOS process concurrency caveat retained |
| Android repeated full reload | `build/performance/android-edits/1793903847601-43567/result.json` | 30 measured pairs + 3 warmups, zero failures: median RNTester 3890ms / candidate 2237ms; installed APK/workload hashes unchanged; accessibility-observation endpoint |
| Native patch compiler feasibility | `build/refresh/2026-11-05T19-10-54.052Z/report.json` | 8 actual Rolldown patches run in Hermes, including imports/CJS/error-fix; no browser runtime; source adaptation rejects unsupported lazy loading |
| Compiler gate cleanup fault | `build/refresh/2026-11-05T19-10-54.588Z/report.json` | Deliberate SIGKILL after all 8 successful checks correctly exits 1 and records failed cleanup |
| React Refresh semantics | `build/refresh/react-2026-11-05T19-08-32.665Z/report.json` | 17 checks through test evaluation: state/input/ref/node identity, handler/effect replacement, service continuity, signatures/boundary rejection; physical behavior not established |
| React through dedicated native ingress | `build/refresh/ingress-2026-11-05T19-10-52.322Z/report.json` | 8 checks passed with native test evaluation disabled; genuine compiler patches, state preservation, preparation failure and recovery, remount/poison behavior; pinned binary and loaded Hermes hashes recorded |
| Native development boundary | `build/dev-ingress-matrix.json` | Four builds cover ingress ON/OFF × test hooks ON/OFF; bounded queue/integrity/lifetime/reentry, duplicate delivery, watchdog, AppState continuity and production guard checks passed |
| Ordered desktop Refresh transport | `cargo test --offline --manifest-path dev-refresh/Cargo.toml` | 11 library/mock-TCP + 1 real CLI test passed; exact replay after lost acknowledgements, identity/order checks, bounded frames, private configuration and process restart refusal; Clippy/format/release build passed |
| Refresh publisher recovery | `testing/refresh/react/publisher.test.mjs` | 6 actual-compiler/mock-transport tests passed, including stale pre-connect sources, compile error/fix, invalid acknowledgements, FIFO/config bounds and cancellation during patch preparation |
| iOS development transport | `platforms/ios/artifacts/refresh-transport-hooks-off.json` | 16 simulator checks passed with test hooks disabled: framed authentication, schema/bounds, exact UTF-8, actual native apply/replay, cancellation, compile rejection, poisoning and FIFO startup rejection; launcher/dylib/Hermes/bundle hashes retained |
| Android development transport | `platforms/android/.cache/dev-transport-physical.log` | 30 physical assertions passed including continuous trickle deadline, exact UTF-8 native apply/replay and queued disconnect/destroy cancellation; Debug test hooks ON; Release symbols/endpoint strings absent |
| Android layout-ready startup | `platforms/android/.cache/surface-bootstrap-physical.log` | 6 layout/cancellation assertions plus actual Activity health passed: wait for both positive dimensions, initialize once, cancel before teardown; not a simulated Doze lifecycle test |
| Physical Android Refresh | `build/refresh-mobile/1793907307105-14710/report.json` | 4 genuine compiler patches passed through Rust/native delivery; external OS input/observation confirms same PID/generation, counter/input/focus/caret and visible scroll geometry, syntax error/fix, component-body edit and working interaction; installed APK hash unchanged; source/fixture/forward cleanup verified |
| Refresh deployment rollback | `python3 testing/refresh/connect-android.test.py` | 5 tests passed: config-write rollback, independent cleanup errors, actual descendant termination on timeout/SIGTERM, and macOS permission-race handling only after a missing-group probe |
| Owned publisher teardown | `node --test testing/refresh/publisher-process.test.mjs` | 6 real-process checks passed: clean/nonzero exit, hanging parent and descendant, parent already exited, missing close event and root interruption; forced cleanup never reports success |
| iOS actual Refresh | `build/refresh-mobile-ios/1793907947835-25715/report.json` | Simulator, test hooks OFF: four genuine patches preserve actual keyboard text, counter, PID/epoch/generation and visible scroll geometry; compile error/fix and component-body change pass; installed launcher/dylib/Hermes/bundle unchanged |
| Android WebView Refresh | `build/refresh-webview/1793908731175-42899/report.json` | Physical Pixel: three real patches preserve two browser nonces/form/history/scroll states, replace message handlers, and preserve browser B across explicit A replacement; fresh browser responses observed through native Text; APK/process/generation unchanged |
| Physical iPhone Refresh | `build/refresh-mobile-ios/1793909239599-60054/report.json` | Four real patches preserve keyboard text/counter/PID/epoch/generation/visible scroll geometry; error/fix and body change pass; observer 1/1 passed; native bundle hashes captured once at opening match signed local build; owned processes/forwards closed |
| iOS inline browser history | `build/refresh-webview-ios/1793909311294-61792/report.json` | FAILED before any patch: fragment changed, but history state remained 0 and length 1 after pushState; all three Refresh browser checks remain unverified; cleanup/artifact checks passed |

Headless `app.event` is synthetic input. Only Android UiAutomation and iOS
XCTest coordinate input establish actual platform hit testing. Android DOM
evaluation is instrumented browser execution; iOS does not advertise a DOM
evaluation or browser-protocol adapter. There is no claim of Playwright `Page`
compatibility or generic cross-platform DOM selectors.

The reference harness's after-commit layout-effect assertion expects scrollTop
100 but reports 0 in both feature-flag variants. The test process still exits
successfully. Treat that behavior as unresolved baseline evidence, not an
assertion that the candidate matches RN. Logs/results and source locations are
preserved in `build/reference-fantom-evidence.json`.

## Failures retained and fixes

- Original Android launches failed on JSI/fbjni packaging. Matched native
  dependencies fixed them; attempt history remains in the platform evidence file.
- First Android shared-driver attempt connected before instrumentation was
  ready and disconnected. Preserved at `build/android-mobile-attempt1.json`;
  the subsequent run began after explicit readiness and passed.
- Review found swallowed native errors, a null Android WebView document crash,
  an unsupported submit event, an iOS tap-result mismatch and unsafe TCP UTF-8
  chunk decoding. Fixes were implemented with targeted checks; final mobile
  health-fault verification is tracked separately.
- iOS driver selection initially selected zero tests; this was rejected as
  evidence and corrected to the XCTest class selector.
- First iOS shared scenario completed its UI assertions, then snapshot teardown
  failed by querying a changing live WebKit accessibility tree. A single immutable
  XCTest snapshot fixed it; the complete retry passed. Original report remains
  at `build/ios-mobile-attempt1.json`.
- One parent invocation passed a binary path as a Python unittest selector and
  failed before running any tests. The documented `test_services.py -v` command
  subsequently ran all 9 tests successfully.
- An automatic WebView package update killed the physical Pixel app during the
  first Maestro attempt. The unchanged retry passed; the failed attempt and OS
  kill reason remain in the physical evidence, rather than being hidden as a retry.
- The matched benchmark invalidated a run after a concurrent native rebuild
  changed its runtime binary. The verified rerun used a private executable and
  Hermes framework with hashes checked before and after every measurement lane.
- Initial iOS command tests found a driver empty-text observation bug and invalid
  inline-HTML/history assumptions. The driver preserves empty native text values;
  history entries now originate from real browser taps. The same-document token
  invalidation defect was fixed with actual document handshakes and synchronous
  source invalidation; the expanded simulator command suite passes. See
  `CAPABILITIES.md` for the different iOS/Android source-loading test boundaries.
- Review found Android inline HTML reload after path/query history changes
  returned HTTP 410. The current source now serves its exact base URL plus one
  native-observed current-document alias for main-frame requests. The physical
  reload/readiness/fresh-message regression passes; independent review found no
  remaining blocker in this fix.
- Two final iPhone reruns timed out enabling XCTest automation before executing
  tests. Their logs are retained separately from prior passing physical results;
  a new attempt after the user's unlock/Home-screen confirmation passed both
  tests on the final source. Command-specific iOS assertions remain simulator-only.
- Full RNTester performance preflight exposed candidate iOS ScrollView content
  drawing outside its viewport. Native default clipping was fixed and visually
  retested; headless geometry alone did not detect this defect.
- Rapid iOS typing exposed stale controlled-value echoes overwriting newer native
  edits. Per-node native event counts and renderer acknowledgements now reject
  stale writes. Android's forced queued-edit case exercises the rejection guard;
  both platforms additionally pass real keyboard scenarios. Programmatic clear
  remains silent and same-value commits preserve selection.
- The first RNTester Refresh fixture recreated its stateful component on module
  replacement. Splitting the component boundary fixes that test-induced state
  loss; the default-workflow measurement verifies process/counter preservation.

## Acceptance gates still open

- Case-level differential comparisons against RN for the supported public API;
  two shared contracts now match, while the remaining API surface is unvalidated.
- Rich native text measurement, complete input/IME/selection and accessibility,
  ref methods beyond the selected command subset, scroll/gesture arbitration and image events.
- Broader WebView navigation/history, frame trust, cookies/storage policy, process loss,
  background/foreground, replacement and repeated teardown resource tests.
- Broader real-device acceptance beyond the passing smoke/fault/AppState runs,
  and external automation expansion beyond the independently passing Maestro
  smoke flow. AppState is the first real platform service beyond echo; its
  replacement-generation rejection remains CTest rather than physical evidence.
- Full process reload from immutable revisions is verified on both platforms.
  Native Refresh compiler/React/C ABI gates and physical Android state/focus/
  selection/scroll checks pass. Actual iOS simulator Refresh and Android browser
  document continuity pass. Physical-iPhone staging/Refresh also passes, with
  final code review of the latest staging/artifact additions pending. iOS browser
  continuity and the new repeated performance comparison remain open. Native
  typography and complex gestures need broader cases.
- Matched cold/warm build, edit-to-visible p50/p95, release startup, memory and
  frame-time comparisons. A faster standalone bundle is not an end-to-end win.

Architecture acceptance remains open until the behavior and measured-benefit
gates in the parent plan are satisfied.

The source-write probes are individual samples from already-running watchers. Each starts
at the parent process's file-write call and ends when that process observes the
published revision. It excludes device transfer, process restart, UI observation
and compositor display. `watcherEventToBundleMs` starts later, at the compiler's
change notification, and must not be substituted for source-write latency.
