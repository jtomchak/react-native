# Development-loop evidence — 2026-11-05

The current prototype improves full-process reload latency in this local product
comparison, but loses to RNTester's default state-preserving Fast Refresh workflow.
The next architecture action is **revise the development loop**, not declare a
general speed win or replace more native subsystems without measurement.

Each run used the physical Pixel 2 XL, the full RNTester app, and the same
100-row React screen rendered by each host. The interval starts immediately
before the source-write workflow and ends when the external OS accessibility
observer returns the exact unique revision marker. It includes relevant build,
deployment/restart and observation overhead. It is not a displayed-frame time.

| Workflow | RNTester median / p95 | Candidate median / p95 | State/process behavior |
| --- | ---: | ---: | --- |
| Each stack's default development path | 824 / 1340 ms | 2152 / 2524 ms | RNTester preserves counter/process; candidate resets/restarts |
| Full process reload on both stacks | 3890 / 3983 ms | 2237 / 2706 ms | Both restart |

Both runs completed three warmup pairs and thirty measured pairs, alternating
order within each run, with zero failed samples. In the default-workflow run,
all thirty measured RNTester updates preserved seeded counter state and process
identity; all thirty candidate updates reset state and changed process. These
checks occur after the latency endpoint. Foreground selection and state seeding
occur before timing. The candidate median was 2.61 times the RNTester default
median, while its paired full-reload median was approximately 42.5% lower.

Raw evidence:

- Default workflow: `build/performance/android-edits/1793903624832-39064/`.
- Equivalent full reload: `build/performance/android-edits/1793903847601-43567/`.
- Read each directory's `result.json` for overall cleanup/identity status and
  `samples.json` for all raw observations. A complete sample-count flag is not
  architecture acceptance.

Installed APK hashes remained unchanged within each run. Shared workload hashes
matched and remained unchanged. Revision sources were restored after each run;
the owned watcher and external observer exited. Earlier one-pair harness exercises
remain separate evidence and are not included in these summaries.

## Interpretation limits

- RNTester deliberately retains its larger JS/native graph, normal menus and
  module initialization, including example prefetch behavior. The candidate does
  not implement that entire feature set. These results cannot isolate compiler,
  language or renderer efficiency, or establish that the candidate can run all
  RNTester examples.
- This is a local shared-machine experiment. No native compilation ran during
  these samples. The first default-workflow run initially had an idle iOS observer
  and iOS Metro server present; they were stopped after the initial warmups and
  first measured pairs. `concurrency-note.json` records this. Every sample is
  retained; this is not isolated acceptance evidence. The subsequent full-reload
  run began after those processes stopped.
- Accessibility query/IPC and polling costs are included, and native tree sizes
  differ. Android polling is 20 ms, but a query itself can take longer. The shared
  source is not evidence of pixel-identical native typography or a compositor
  timestamp.
- Candidate and reference Hermes/toolchain versions differ. Phase order was
  default workflow followed by full reload; device thermal/background conditions
  and OS caches were not globally controlled. The native source-build setup
  durations are not cold-build benchmarks.
- The earlier same-graph Metro/Rolldown benchmark found warm artifact publication
  effectively tied at about 83 ms. Faster artifact creation alone does not remove
  the candidate's process restart and state-loss costs.

## Remaining decision packet

Implement and verify a state-preserving candidate update path, then repeat this
packet with the same correctness checks. Keep full reload as an explicit fallback
for incompatible/native changes. Controlled native-build measurements, release
startup, memory, frame behavior, repeated WebView/runtime teardown and equivalent
iOS workflow measurements remain open. Release runtime comparisons must first
package the same performance workload in the candidate; its current standard
Release APK contains the demo and ignores development overrides as designed.
