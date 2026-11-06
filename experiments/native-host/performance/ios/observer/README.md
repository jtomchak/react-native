# Independent iOS accessibility observer

This XCTest runner has no target app dependency or host. It observes either
`dev.nativehost.prototype` or `com.meta.RNTester.localDevelopment` through public
XCTest accessibility and system coordinate/input actions. It remains alive when
the observed app is terminated and relaunched by the external orchestrator.

Create a private, ignored JSON configuration containing `platform: "ios"`, a
random `token` of at least 24 characters, `port` (default 19846), and
`timeoutSeconds` (30–7200). Do not commit or print the token. Then run:

```sh
NH_SIMULATOR_ID=<dedicated-uuid> bash experiments/native-host/performance/ios/observer/start.sh <private-config.json>
```

The server binds to loopback only. Each connection must first send
`session.authenticate` with `{token}`. Requests are newline-delimited JSON
`{id,method,params}`; replies are `{id,result}` or `{id,error:{code,message}}`.
`session.describe` supplies capabilities, runner PID and measurement limitations.
`session.close` ends the test successfully. Expiration fails the test. The parent
must not simultaneously run another UI driver on this simulator.

UI methods require `params.package` selecting one allowed bundle identifier.
Use `params.selector` with an exact `testID`, `resourceID`, `label`, or `text`.
`ui.find` returns a normalized node or `{exists:false}`; `ui.waitFor` also accepts
`timeoutMs`. `ui.text` preserves empty text-field values. `ui.tap`, `ui.type`
(`text`, optional `clear`, default true), `ui.scroll` (`direction: "up"|"down"`),
`ui.dismissKeyboard`, and `ui.snapshot` perform real native observation/actions.
`ui.screenshot` returns the public `XCUIApplication.screenshot()` PNG as base64,
with byte length and MIME type. PNG data is capped at 4 MiB before encoding.
Scroll uses XCTest's default swipe duration; it does not implement a requested
`durationMs`. No app launch/terminate endpoint is exposed: use the same external
simctl process control for both targets.

Snapshots are bounded to 4096 named/labeled elements. Visibility means frame
intersection with the application window, not pixel visibility or ancestor
clipping. Screenshots and visual inspection are still required to detect clipping
or occlusion defects. Accessible image geometry alone does not prove pixels were
decoded. Timestamp fields use monotonic DispatchTime uptime; wait durations include
XCTest queries and IPC, and are **not** compositor presentation timestamps.
The runner services its run loop during polling so XCTest's asynchronous app-state
updates continue after an external target restart.

Generated Xcode projects and build/results are ignored. `NH_OBSERVER_NO_BUILD=1`
uses `test-without-building` only after the matching observer has been built.

With the shared workload already visible, run the actual keyboard regression:

```sh
python3 experiments/native-host/performance/ios/observer/keyboard-regression.py <private-config.json> <ignored-results.json>
```

It clears/types six different values using XCTest without per-character or
inter-action sleeps, and checks both native input value and the React text echo.
Use `--package com.meta.RNTester.localDevelopment` for the same reference check.
This is functional race regression coverage, not a performance measurement or a
claim that every keyboard/IME/composition behavior is supported.

The physical Refresh validation reuses this Swift observer source through the
isolated `platforms/ios/refresh-observer.yml` project and the already-authorized
prototype UI-test runner identity. See `platforms/ios/REFRESH.md`; no separate
performance-observer signing identity is required for that path.
