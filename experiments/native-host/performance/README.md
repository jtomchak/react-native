# Native product comparison

Current measured findings and limits: [RESULTS.md](./RESULTS.md).

This phase uses **the full RNTester application**, as requested, built from the
pinned reference checkout. Its module lists and existing examples stay present.
`NativeHostPerformanceExample` adds the byte-identical `workload.js` component
factory also used by the candidate. The native launch route selects it on the
first render, without first rendering RNTester's home screen.

There are two different comparisons:

1. **Product build and development workflow:** full RNTester versus the candidate
   host. RNTester's larger graph and broader native feature set are intentionally
   included. A smaller candidate build is not proof that Rust alone is faster,
   nor that this host can already run all RNTester examples.
2. **Shared-screen runtime behavior:** the same 100-row screen, fixed geometry,
   image, controlled input, update/reorder and unmount/remount actions. RNTester's
   native shell and retained full application graph remain overhead. Actual
   platform input and observations must pass before collecting timing samples.

The prior same-graph Metro/Rolldown benchmark remains separate evidence. This
comparison must not relabel different-sized graphs as a compiler-only result.

## Frozen workload and endpoints

`workload.js` is copied byte-for-byte into the reference app. Install evidence
records both SHA-256 hashes. `revision.js` holds a unique per-edit marker. Only
that marker changes between latency samples. `candidate-entry.js` renders the
same factory through the new renderer. `verify-workload.mjs` checks it in real
Hermes with explicitly synthetic input; native image decoding, typography,
scrolling and hit testing require the platform preflight.

- **Native builds:** distinguish dependency acquisition, empty project outputs
  with warm dependency caches, warm no-op, common-runtime source edit and
  platform-adapter source edit. Never delete global caches. Record all commands,
  cache policy, compiler parallelism and artifacts. Setup builds under concurrent
  development load are setup evidence only.
- **Edit-to-native-observation:** host monotonic time immediately before source
  write through receipt of an exact, unique marker from the same external OS
  accessibility observer for both applications. Report source write, bundle,
  transfer/restart and observation boundaries when actually observed. This is
  not a compositor-present timestamp. Retain polling/transport latency.
- **Full reload versus Fast Refresh:** pair equivalent process-reload runs, then
  measure each product's default development workflow separately. Record whether
  component state and browser documents survive. Restart is not Fast Refresh.
- **Release startup:** process launch through the same useful marker; separate
  OS launch timing from useful content. No arbitrary evaluation/debug transport
  inside measured release apps. An external automation process is permitted and
  must be the same for both applications.
- **Memory and frames:** use the same OS tooling, idle/interaction phases,
  settling interval and scripted actions. Record process memory categories and
  frame distributions, not only one RSS value or average FPS.
- **Teardown:** repeat runtime and surface creation/destruction with host resource
  counts and OS memory. Browser teardown is a separate workload and remains open
  until it has real browser/process evidence.

Use three warmups and at least thirty successful measured edit/startup samples
per lane, paired in alternating order. Failures stay in the report and invalidate
an acceptance claim; do not silently retry or discard them. First setup/preflight
runs and smaller samples are exploratory. Native clean builds may use fewer
samples because of cost, with that limitation explicit. No concurrent native
builds or unrelated task workloads during measured runs.

## Decision rules fixed before measurement

The working product criterion is at least a 20% median improvement in a primary
native-build or development workflow, supported by the raw paired samples and
tail results, without a greater than 10% regression in release startup, sustained
frame misses or steady workload memory. These are experiment decision thresholds,
not user-approved service-level objectives. Borderline/noisy results are
inconclusive. Behavioral failures cannot be traded for speed.

The final decision must be **proceed**, **revise a measured bottleneck**, or
**reject the speed hypothesis for this design**. A positive decision requires
the declared behavioral/lifecycle gates and runtime budgets, not merely a fast
build of a much smaller app. Unsupported primitive/browser behavior and the
different Hermes/toolchain versions remain explicit limits. The prototype is not
a wholesale RN replacement until its selected compatibility contract is met.

## Current execution

Platform setup and source builds live in `android/` and `ios/`; reference JS
installation lives in `reference/`. Debug/Release baselines and shared-screen
functional checks have passed. Reports and artifacts stay under ignored `build/`;
dependency/bootstrap/build failures remain in those reports.

`measure-android.mjs --serial <id> --observer <private-config>` runs alternating
paired samples against an already-running external observer and Metro. Its
`--mode full-reload` compares process restart on both sides;
`--mode default-development` edits RNTester through stock Fast Refresh while the
candidate publishes/deploys/restarts. In the latter mode, foreground selection
and seeded state occur before timing; post-observation PID/counter checks occur
after timing. Reference state/process preservation is required, and candidate
reset is explicitly recorded. `--count 1 --warmups 0` is a harness exercise,
not an acceptance sample. The runner closes its observer and watcher, restores
only its own source edits and verifies installed APK/workload hashes.

Read `result.json` as the overall outcome, including cleanup and identity checks;
`samples.json` alone is not sufficient. Any retained concurrency note also bounds
interpretation. The first repeated Android workflow comparisons are recorded in
`RESULTS.md`; release startup, memory, frames, controlled native-build comparisons
and the equivalent iOS workflow measurements remain open.
