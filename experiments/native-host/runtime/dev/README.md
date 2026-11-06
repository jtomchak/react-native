# Development update ingress

This directory implements the owner-thread C ABI in `../host.h`. It is compiled
only with `NH_DEV_UPDATES=1`, independently of `NH_TEST_HOOKS`. It does not provide
a network transport, a browser HMR client, or React Refresh itself. The compiler
and permanent JavaScript bootstrap supply the actual module/Refresh semantics.
The canonical `native-host` executable and its protocol gain no update method;
`runtime.eval` retains its existing test-only restriction.

`NH_PRODUCTION_ARTIFACT=ON` rejects `NH_DEV_UPDATES=ON` in CMake; the public header
also rejects both preprocessor definitions together. Mobile build wiring must
apply the same explicit configuration policy. `NH_DEV_UPDATES` defaults OFF.
A CMake Release optimization setting alone does not identify a production app:
optimized development/test binaries are supported by the four-way test matrix.

## Owner thread and lifetime

The host is created, updated, pumped and destroyed on one owner thread. Calls
inside any current public execution task or native callback reject reentrancy.
Native networking must schedule copied bytes through a cancellable session token;
it must not hold JSI values or dereference a destroyed host. `enqueue` copies the
source before returning. `drain` is a separate explicit owner-thread task and
processes at most one pending patch. It does not pump timers or Rust services.
Successful updates retain generation, host, root, timers and subscriptions.

Open one session per host, identifying the generation, nonzero 16-byte session ID,
initial revision and SHA-256 of the exact originally loaded bundle. Opening does
not execute JavaScript and cannot replace an existing session. Revision strings
are 1–64 ASCII letters, digits, `.`, `_` or `-`; sequence numbers are native u64.
There is one pending patch, capped at 4 MiB, and one cached terminal identity.
Transient enqueue hashing may hold a second bounded copy. The source cannot
contain NUL bytes; bytecode ingress is not supported. The independent SHA-256
check is payload integrity, not transport authentication or permission to execute.

Require the session/generation, next sequence, exact current base revision,
different target revision, source length and digest. Schema/digest rejection does
not consume a sequence. Once queued, a sequence is consumed even if preparation
fails; the next patch uses the next sequence and the unchanged applied base.
An identical repeat of the pending or latest completed patch replays its result;
conflicting identity/hash rejects. Patches are not coalesced. Producers assign
immutable, unique target revisions and retain source maps keyed to payload hashes.

## Completion and failure

The initial supported payload is a synchronous script: actual compiler module
updates followed by `globalThis.__nhApplyDevUpdate(metadata)` as its final
expression. The permanent bootstrap implements that function. The evaluation
result must be a plain object whose `status` is `applied`; a Promise, including
one decorated with that property, is rejected. Native code validates this
completion contract, not the internal honesty of trusted development code.
TLA, lazy compilation and asynchronous patch completion are outside this version.

The phases are:

1. `prepareJavaScript`: parse/compile without execution. Failure returns terminal
   `status: rejected, phase: prepare`; application state and applied revision are
   untouched by the patch. No timers, services or microtasks run on this path.
2. Evaluate the prepared patch, validate its completion, drain microtasks and call
   the existing `__nhFlushMount`. Only then advance the applied revision and return
   `status: applied, phase: mount-submitted`.
3. Any execution/completion/microtask/mount exception sets sticky
   `status: reload-required`. Keep the previous applied revision and failure phase;
   earlier module/native side effects are not rolled back. Reject further updates,
   events, pumping and AppState ingress. Native-only dev status and destruction
   remain available. Full reload creates a new host/generation/session.

Hermes's microtask count is only a hint; the pinned runtime did not stop an
infinite queue at 10,000. A development-only Hermes execution watchdog covers
patch evaluation, completion checks, microtasks and mount JS with a 1-second
limit. Both infinite script and infinite microtask tests terminate as poisoned.
This is not a hard deadline for parsing or a blocking native callback. Promise
rejections caught by JS/VM machinery are not automatically native exceptions.

Terminal acknowledgement means Refresh completed and the synchronous native
commit callback returned. It does not prove compositor visibility, native browser
completion or subsequent asynchronous application health. Keep OS-observed marker
acknowledgements separate. Exceptions retain no Hermes objects beyond host lifetime.

## Isolated NDJSON driver

`native-host-dev-driver --bundle /absolute/initial.js` starts without unsolicited
output. Each input line receives one JSON response. Development envelopes have
flat unescaped ASCII string fields; binary source travels as lowercase hex.
Lines are bounded; no second JavaScript runtime parses control input.

```json
{"method":"dev.status"}
{"method":"dev.open","generation":"1","sessionId":"01000000000000000000000000000000","initialRevision":"base","initialBundleSha256":"<64 lowercase hex>"}
{"method":"dev.enqueue","generation":"1","sessionId":"01000000000000000000000000000000","sequence":"1","baseRevision":"base","targetRevision":"next","payloadSha256":"<64 lowercase hex>","payloadHex":"<source as lowercase hex>"}
{"method":"dev.drain"}
```

`dev.status` supplies the real generation and initial digest. Enqueue returns
`result.status: queued`; drain returns the terminal acknowledgement. Sequence
fields in responses are decimal strings. Standard existing protocol requests
are forwarded unchanged and remain subject to their normal test-hook restrictions.
`dev.hash` is a driver-only digest crosscheck, not a host protocol/API method.

## Verification

From repository root, using an existing matched-Hermes cache for toolchain paths:

```sh
python3 experiments/native-host/runtime/dev/test-matrix.py \
  --seed-cache experiments/native-host/build/headless-commands/CMakeCache.txt
```

The script creates isolated `build/dev-ingress-<dev>-<hooks>` directories, runs
existing host contracts in all four combinations, new ingress contracts in both
development combinations, checks symbols/ingress strings absent when disabled,
and verifies forbidden production configuration fails. It uses the ordinary Rust
core archive, not the service test-hook feature. Evidence is
`build/dev-ingress-matrix.json` with individual `matrix.log` files.

Ingress tests cover owned buffers/teardown, bounds, bad hashes, stale identity,
sequence/base conflicts, pending/terminal duplicate handling, queue saturation,
wrong-thread/native-callback reentry, actual compile preservation, successful
same-generation updates, no timer/service pumping within drain, AppState
subscription continuity/unsubscribe, execution/mount failure, Promise rejection,
execution watchdogs, poisoned access and fresh-host recovery. SHA tests include
standard empty/abc/multiblock/million-a vectors and 13 independent Node crypto
crosschecks through the driver, including binary padding boundaries and 4 MiB.
These C ABI fixtures do not by themselves prove React state preservation; that
requires the compiler/bootstrap integration and later physical marker tests.
