# Ordered desktop refresh transport

This separate Rust development tool pushes immutable patches to an explicitly
configured loopback native development listener. It does not link into the app,
Rust service core or existing full-reload watcher. Its only dependency is the
desktop-only pinned `serde_json = 1.0.145`. It spawns no subprocesses and
performs no device, installation, forwarding or full-reload actions.

Build and run from the repository root:

```sh
cargo build --offline --release --manifest-path experiments/native-host/dev-refresh/Cargo.toml
experiments/native-host/dev-refresh/target/release/native-host-refresh-transport \
  --config /absolute/private-desktop-config.json
```

The configuration must be a regular nonsymlink file with mode `0600`, at most
16 KiB. The desktop config contains exactly:

```json
{
  "schemaVersion": 1,
  "host": "127.0.0.1",
  "port": 18790,
  "token": "<64 lowercase hex>",
  "sessionId": "<32 lowercase hex, not all zero>",
  "initialRevision": "initial",
  "initialBundleSha256": "<64 lowercase hex>"
}
```

These placeholders are not working credentials. The matching native session must
already have loaded/verified the initial bundle and opened the C ABI dev session.
The port is an explicit desktop-forwarded loopback port. Device config/port
allocation and startup are owned by platform tooling; desktop `host` is not a
field to copy blindly into a strict device config.

Wire frames are a four-byte big-endian byte length followed by UTF-8 JSON, capped
at `8 MiB + 16384` bytes. Authenticate first with
`{method:"authenticate",token:...}`, then use only `dev.status`, `dev.enqueue`,
and `dev.drain`. Each frame has an absolute five-second read/write deadline;
partial reads do not restart it. The native execution watchdog is separate.
Errors never print authentication/config contents or entire remote responses.

Startup requires enabled/opened version 1, a positive generation, the configured
session and initial digest/revision, sequence zero, no pending patch and no
reload requirement. A new desktop process refuses unknown native history rather
than guessing how to resume it. On success stdout emits:

```json
{"event":"ready","generation":1,"revision":"initial","sequence":"1"}
```

Write one bounded JSON line per patch to stdin:

```json
{"method":"patch","sequence":"1","baseRevision":"initial","targetRevision":"next","payloadSha256":"<64 lowercase hex>","payloadFile":"/absolute/immutable-patch.js"}
```

Control lines are at most 16 KiB. Source files must be regular/nonsymlink,
nonempty UTF-8 without NUL, at most 4 MiB. They are read once into owned memory;
size/mtime/ctime changes during reading reject the patch. The native C ABI
independently recomputes SHA-256 against the claimed digest. This tool does not
add a second crypto library or present hashes as authentication.

The client validates sequence and current base before any patch network request.
It holds one patch at a time; it never coalesces dependent updates. Native queued
ACKs must match sequence/base/target/hash. Terminal ACKs additionally require the
same generation, correct applied revision, phase and reload flag. Output is:

```json
{"event":"patch.terminal","result":{"status":"applied","sequence":"1","baseRevision":"initial","targetRevision":"next","payloadSha256":"...","generation":1,"appliedRevision":"next","phase":"mount-submitted","reloadRequired":false,"message":""}}
```

Applied updates advance sequence and base. Preparation rejection consumes the
sequence but retains the previous base; the publisher decides whether to halt
and report a compiler error. Evaluation failure emits the native reload-required
terminal, then stops with nonzero exit. No automatic full reload occurs.
`{method:"quit"}` or stdin EOF closes the socket and exits normally. Fatal local,
protocol or unresolved I/O errors emit `{event:"fatal",message:...}` and exit 1.

## Lost acknowledgements

Only I/O failures permit one reconnect. Reauthenticate, query native status, and
verify the same session, generation and initial digest. Compatible states are:

- Request not accepted: previous sequence, previous base, no pending update.
- Queued: current sequence, previous base, pending update.
- Applied: current sequence, target revision, no pending update.
- Preparation rejected: current sequence, previous base, no pending update.

Resend the exact captured source/envelope. Native deduplication returns the
pending queued ACK or cached terminal. A cached terminal is consumed directly;
there is no second drain of an already completed patch. Conflicting identity,
unknown sequence/base, poisoning, malformed responses or a second I/O failure
stop the client. A lost failure ACK from an already-poisoned host requires
explicit recovery; the transport does not fabricate a terminal success.

## Checks

```sh
cargo test --offline --manifest-path experiments/native-host/dev-refresh/Cargo.toml
cargo clippy --offline --manifest-path experiments/native-host/dev-refresh/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path experiments/native-host/dev-refresh/Cargo.toml -- --check
```

Eleven library/mock-TCP tests cover ordered rejection/application, lost queued,
applied and preparation ACKs, exact replay, one retry, identity/history changes,
restart refusal, invalid terminal metadata, poisoning, malformed frame bounds,
and private/file/control limits. One real CLI subprocess test verifies two ordered
patches, EOF socket closure, output ACKs and absence of tokens in stdout/stderr.
These transport tests use a mock native endpoint; physical end-to-end evidence is
collected separately against platform listeners and real compiler output.
