# Android default-development Refresh measurement

`performance/measure-refresh-android.mjs` compares full RNTester Metro Fast
Refresh with the prototype's state-preserving native Refresh on the same
100-row workload. It is separate from `performance/measure-android.mjs`, whose
existing full-process-reload and older default-development results are unchanged.

The caller must reserve the Pixel and a quiet measurement interval, install the
frozen Debug APKs, start full RNTester Metro on port 18791 with its device reverse
mapping, and start the external OS observer. Pass the observer's private JSON
configuration; the runner neither installs APKs nor starts/stops those external
launchers. It requires an awake, unlocked device. Coordinate exclusive ownership
of the reference RNTester revision module with any iOS work before launching.
The run's lock file protects cooperating Android runners; it cannot prevent
another editor from changing shared sources.

From `experiments/native-host`:

```sh
# One-pair functional exercise. This is not an acceptance-size measurement.
node performance/measure-refresh-android.mjs \
  --serial 805KPFX1843819 --observer /absolute/private-observer.json \
  --count 1 --warmups 0

# Default: three warmup pairs, then 30 measured pairs, alternating lane order.
node performance/measure-refresh-android.mjs \
  --serial 805KPFX1843819 --observer /absolute/private-observer.json
```

Optional `--metro-port` defaults to 18791. Optional `--transport` selects an
already-built Rust transport executable; the runner copies it to a run-private,
read-only executable and records its digest. It does not rebuild it. Setup stages
one initial candidate bundle, connects its authenticated native session, and
launches the full RNTester performance route before sampling. Subsequent samples
only foreground the existing processes; a restart makes the run fail.

The candidate graph lives in the run's ignored `build/performance/android-refresh/`
directory. Only the canonical wrapper and revision module are copied byte for
byte; generated permanent binding/entry modules use absolute imports of the
unchanged renderer and workload. The canonical Refresh application sources are
never written, allowing independent iOS functional work on those files. Such
work must still stop before a quiet performance run, and neither platform may
concurrently edit the shared RNTester reference revision. The report records
both edited source paths, copied source hashes, and initial publisher artifacts.

Before each sample, real OS input increments the counter and seeds unique input
text. The observer confirms stable focus and selection, and the runner records
PID and state. These preparations are outside the timer. The measured endpoint
is the host source-write invocation through the exact visible OS accessibility
marker response. Both lanes begin the OS wait immediately after the write. The
candidate does not wait for a native acknowledgment before observing its marker.

After the timer stops, both lanes must preserve PID, counter, input, focus, and
selection. The candidate must additionally produce exactly one matching applied
patch acknowledgment with the same runtime generation, expected sequence/base,
matching payload digest, `mount-submitted` phase, and no reload requirement.
A late or invalid acknowledgment fails the sample even if its marker appeared.
No failed pairs are silently retried or replaced.

Publisher event receipts are timestamped on the same host monotonic clock.
Source-to-preparing, preparing-to-sent, and sent-to-applied intervals are diagnostic
milestones, not isolated compiler or native execution durations. Applied events
also include publisher bookkeeping after the native acknowledgment. Accessibility
observation includes IPC and observer polling and does not prove compositor
presentation. Different full app graphs, Hermes/toolchain versions, native
capabilities, and shared host/device conditions limit attribution of differences.

`result.json`, `samples.json`, immutable patches and terminal receipts remain in
the run directory. Target and observer/test APK identities, workload/source
hashes (including the measurement driver), runtime/compiler versions and
observer identity are recorded. Every warmup and all 30 measured
pairs must pass to satisfy the existing sample-count gate. That gate is not a
statistical-significance claim. Failed verification is preserved; the common
collector's failure duration can include postchecks and must not be interpreted
as a valid edit-to-marker latency.

Cleanup uses the shared process owner to quit the publisher and Rust child,
bound shutdown time, handle harness interrupts, and reject forced termination.
It checks for pending work,
removes only the owned development forwarding/session configuration, restores
the prior candidate fixture with a fresh healthy startup receipt, and restores
the reference source only if it still equals this run's last write. Source/APK
mutation or cleanup failure invalidates the result. The observer TCP client is
closed without `session.close`, leaving the caller-owned observer and Metro
launchers available. Private credentials are not included in public results.

Local checks, which use explicit fake observations and are not device evidence:

```sh
node --check performance/measure-refresh-android.mjs
node --test performance/refresh/measurement.test.mjs performance/paired-run.test.mjs
```
