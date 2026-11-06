# State-preserving development entry

This separate entry uses the existing `performance/workload.js` factory without
changing its bytes. `BoundPerformanceScreen.js` creates the stateful component
once. The component-only wrapper and its revision module live under
`application/`, the only updateable directory in this session.

`application/revision.js` starts as a byte-identical copy of
`performance/revision.js`. Refresh measurements edit the former; the existing
full-reload baseline continues to edit the latter. This difference in source
path must be included in measurement receipts. Edits to the shared workload,
renderer, permanent binding, or entry require a new initial bundle/session.

Start the publisher from the repository root:

```sh
node experiments/native-host/scripts/refresh-watch.mjs
```

The first `initial.ready` line supplies the bundle, map, manifest, digits-only
revision directory, and private device `session.json` path. The session file has
exactly six keys: `schemaVersion`, `port`, `token`, `sessionId`,
`initialRevision`, and `initialBundleSha256`. Port zero asks the device server
to allocate its port. Credentials are never printed in control output or the
public receipt. Keep the file private.

For the Android development build, a separate owner can stage the app and create
the desktop connection config using the existing platform helper:

```sh
python3 experiments/native-host/scripts/connect-refresh-android.py \
  --serial DEVICE_SERIAL \
  --session /absolute/session.json \
  --revision-directory /absolute/revisions/DIGITS_REVISION \
  --output /absolute/private-desktop.json
```

Send this JSON line to the still-running publisher's stdin after staging:

```json
{"method":"connect","config":"/absolute/private-desktop.json"}
```

The desktop file adds loopback `host` and the forwarded port. The publisher
checks it is a nonsymlink regular file, private, at most 16 KiB, and bound to the
initial session. It then launches
`dev-refresh/target/release/native-host-refresh-transport`. Override the path
with `--transport /absolute/executable` when using another build.

Wait for `connected` before editing application sources. A source change between
initial compilation and connection invalidates that initial session; the
publisher checks compiler-input hashes as well as pending compiler events.
Stage a fresh initial bundle instead of connecting a newer graph to stale code.

For each change, actual Rolldown patches are retained in immutable directories.
The publisher emits `patch.preparing`, `patch.sent`, and finally `patch.applied`.
It sends at most one patch at a time and retains at most sixteen pending patches;
it does not coalesce them. Native attempt sequences are independent of compiler
sequences. The applied base and next attempt advance only after an exact native
acknowledgment of evaluation, Refresh, and synchronous mount submission. This
acknowledgment is not a compositor-visible endpoint; measurements must still
observe the marker through the operating system.

Syntax errors are reported without replacing the running application. A native
failure, incompatible boundary, full-reload request, or queue overflow stops
updates explicitly. There is no automatic fallback disguised as Refresh.

Send `{"method":"quit"}` to finish a session. Stopping during preparation is
reported as cancellation; stopping during delivery requires an explicit reload
because native completion may be unknown. Source maps, payload digests, native
terminal receipts, and the final report remain under `build/refresh-publisher/`.
`running.json` without a final `report.json` means the session did not finish.

The publisher itself performs no device commands. The caller owns staging,
device processes, forwarded ports, and cleanup using the platform helper.

## Checks

```sh
node --test experiments/native-host/testing/refresh/react/publisher.test.mjs
```

These six tests use real Rolldown compilation and an explicitly mocked transport.
They cover ordered patches, syntax error/fix, stale initial graph rejection,
bad acknowledgment identity, cancellation, FIFO/symlink/oversized configs, and
shutdown during a delayed file write. They do not establish device behavior.
The separate native-ingress gate executes real patches with test hooks disabled.

Android paired default-development measurements use the separate
[`measure-refresh-android.mjs` runner](../measure-refresh-android.mjs).
See [measurement ownership, timing, and commands](MEASUREMENT-ANDROID.md).
