# Matched development artifact benchmark

From `experiments/native-host`, with its headless host and the isolated reference
checkout dependencies already built:

```sh
node scripts/benchmark-tooling.mjs
```

This macOS harness compares Metro 0.87.2 and Rolldown 1.3.0 on the **same copied
candidate React app graph**, not RNTester versus a smaller application. It uses
the candidate's React 19.3.0, reconciler 0.34.0, and scheduler packages. Metro is
loaded from the existing reference checkout; no dependencies are installed.

The generated report records source hashes, compiler/runtime versions, thread
settings, raw samples, artifact hashes/sizes, prior failed attempts, and semantic
validation results. Output is isolated under a timestamped
`build/tooling-benchmark/` directory. User app sources are never edited.

## Correctness before timing

The executable and the entire non-system Hermes framework are copied privately.
Only the copied executable's rpath and ad-hoc signature change. Both hashes are
checked again at the end, so concurrent native development cannot silently
replace the runtime between samples. System libraries remain supplied by macOS.

Both preflight bundles, and then every measured or warmup artifact, run in fresh
processes of this pinned Hermes host. Exact semantic snapshots, numeric ids,
props, geometry, counter/input updates, layout-effect observations, and keyed
state/ref identity must match. Each edited heading must be visible, and its exact
source must occur in the source map. Only the deliberately edited heading is
normalized for cross-sample semantic comparison. Validation is outside the
artifact latency interval. Native widget or browser behavior is not inferred.

Metro's indexed v3 maps and Rolldown's flat v3 maps are both accepted. Both tools
produce development, non-minified, eager full bundles with external source maps
including sources. Metro uses Android resolution and no RN runtime prelude or
polyfills; the existing RN Babel transformer compiles JSX and replaces the same
test-only constant as Rolldown. Babel config discovery and inline requires are
disabled. Tool-specific module-loader/helper code remains part of each artifact.

## Measurement definitions

- **Warm source-write to artifact:** three warmups followed by twenty measured
  edits per tool, retaining the watcher and dependency graph. Timing starts
  before writing the source and ends when the worker reports that both output
  files are written. Detection and build durations are also recorded separately.
  Rolldown retains its watcher and uses a declared 35 ms build delay. Metro uses
  its persistent HTTP bundle path, which updates the retained graph, then obtains
  the external map. Its metric includes loopback transfer of both files.
- **Fresh-process completion:** five new processes per tool with already warmed
  OS caches; Metro retains its transform/file-map disk caches. Five additional
  Metro processes each receive unique empty cache directories. Rolldown has no
  configured persistent transform cache: its `fresh-warm-cache` phase label means
  the warmed environment, not a nonexistent Rolldown transform cache. `wallMs`
  ends at successful process exit; `artifactReadyMs` ends at the artifact signal.
- Worker build durations include full serialization and writing, not only
  compiler transforms. Metro's fresh build API also shuts its server down before
  returning. They are diagnostic components, not interchangeable pure-compiler
  timings. Summary quantiles use the nearest-rank method. With five samples,
  fresh-process p95 is effectively the observed maximum and not a stable tail
  estimate.

Metro is bounded to four workers; Rolldown gets `RAYON_NUM_THREADS=4`. Those are
different concurrency models. The machine is not isolated from other development
work and OS caches are not flushed. Tool phases run sequentially in the declared
order; this is a local exploratory measurement, not a randomized performance
study. Errors terminate the run; there are no hidden sample retries.

## Verified run

`build/tooling-benchmark/2026-11-05T16-55-44.067Z/report.json` passed 65 artifact
validations with unchanged private executable/framework hashes:

| Artifact completion metric | Metro | Rolldown |
| --- | ---: | ---: |
| Warm median, 20 samples | 82.76 ms | 82.27 ms |
| Warm p95, 20 samples | 86.74 ms | 84.43 ms |
| Fresh process median, 5 samples, warmed environment | 288.16 ms | 82.73 ms |
| Fresh process median, 5 samples, empty Metro disk caches | 1516.36 ms | Not applicable |

Warm artifact latency was effectively tied in this run. Fresh-process results
favor Rolldown for this small graph. Neither establishes faster native builds,
React Native Fast Refresh, state-preserving HMR, simulator startup, or
edit-to-visible UI latency.

Earlier attempts remain recorded: explicit Metro file-map root configuration,
indexed source-map support, and worker teardown needed fixes. One otherwise
successful run was invalidated because another worker rebuilt the shared host
binary. Its report is marked `invalidated-mutated-benchmark-binary`; only the
private-runtime run above is the verified matched-runtime evidence.
