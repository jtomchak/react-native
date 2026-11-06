# Native service core

Dependency-free Rust service prototype with a polling C ABI. This is one part of
the [native-host experiment](../README.md), not an implementation of React,
Hermes, native controls, or a complete mobile end-to-end test environment.

## Boundary

Include [native_host.h](./include/native_host.h) and link
`target/debug/libnative_host_core.a` (or the corresponding target/release build).
The header is the authoritative C ABI. Create the runtime on its VM executor
thread; submit, cancel, publish, unsubscribe, poll, and destroy on that same
thread. A wrong-thread call is rejected. Valid pointer lifetimes remain the
caller's responsibility; destruction cannot race another ABI call.

One condition-variable worker per runtime completes delayed byte echo requests.
No JS values cross the worker boundary. Request and runtime IDs are process-wide
monotonic identifiers. Explicit generation checks reject calls from an older
runtime. Delay is bounded to 60 seconds; each payload to 1 MiB; retained payloads
to 16 MiB; outstanding requests/messages and subscriptions are bounded separately
by configured capacity (at most 1024).

Every request reserves space for its terminal event until that event is polled.
Cancelling and completing contend on the same state lock. Winning cancellation
emits `NH_CANCELLED`; losing cancellation leaves success/error intact. Polling
returns an owning `NhEvent`, including independently owned copied result bytes.
Call `nh_event_free` after processing, even if the runtime was destroyed. The
embedding bridge translates terminal statuses into JS promise outcomes.

Subscriptions enqueue copied messages. Unsubscribe discards all undelivered
messages for that ID and is idempotent. Events already polled are caller-owned.
No host callbacks execute under a Rust lock: polling returns before the bridge
dispatches to JS, allowing callback reentrancy.

Destroy invalidates the state, drops pending/results/subscriptions, wakes and
joins the worker. It never waits for a request's delay. Output buffers already
returned by poll are still owned by the caller.

## Build and verify

Run these commands in this directory:

```sh
cargo fmt --check
cargo test --all-features
cargo clippy --all-targets --all-features -- -D warnings
cargo build --features test-hooks
cc -std=c11 -Wall -Wextra -Werror -DNH_TEST_HOOKS -Iinclude tests/abi_smoke.c target/debug/libnative_host_core.a -lpthread -ldl -lm -o target/abi-smoke
./target/abi-smoke
```

The C link command above is verified on the development macOS host. Other
platforms may need the target's native system libraries. Do not link a macOS
archive into an iOS or Android binary; cross-compile with the corresponding
Rust target.

`test-hooks` exports `nh_test_submit_error` for injected native failures. The
default build does not export this function. A production build must omit the
feature. No network server or test-control transport is provided by this crate.

Rust tests exercise concurrent cancel/complete races, the actual worker,
shutdown and retained payload release, stale generations, queue/byte bounds,
subscription teardown, reentrancy, schema validation, and the unsafe FFI boundary.
The linked C smoke checks the ABI independently. These results do not prove
Hermes integration, UI-thread affinity, platform behavior, or physical-device
end-to-end correctness; those belong to the consuming hosts.
