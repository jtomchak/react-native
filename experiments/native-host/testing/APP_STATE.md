# Physical AppState acceptance fixture

`app-state-entry.jsx` imports the real `getAppState` and `subscribeAppState`
services. It exposes native text for captured snapshots, transition records,
subscription state, errors and a per-runtime fixture identity. It never injects
a lifecycle event. Publish it with the existing development supervisor:

```sh
cargo run --manifest-path dev/Cargo.toml -- --entry testing/app-state-entry.jsx
```

Record the emitted immutable revision directory, then type `quit`. The ordinary
application source and packaged development bundle need not be changed.

## Android

Install the candidate and its test APK, stage the exact revision with
`platforms/android/deploy-revision.py --stage-only`, and start the authenticated
instrumentation driver with a private config containing that revision. A device
may have only one active UiAutomation owner: coordinate existing performance or
other instrumentation sessions first.

```sh
NH_DRIVER_CONFIG=/absolute/private-config.json \
NH_MOBILE_REPORT=test-results/android-app-state-results.json \
node_modules/.bin/playwright test --config testing/playwright.app-state.config.mjs
```

The test-only `lifecycle.background` command launches the system Home intent and
waits for the actual Activity-stopped callback. `lifecycle.activate` reorders the
existing Activity to the foreground and waits for resumed/window-focus evidence.
It rejects a finished/destroyed Activity. Tests require unchanged process,
runtime generation and fixture identity, so a replacement launch cannot pass.
The instrumentation lifecycle observer is test-only and detached on teardown.

## iOS

The shared driver supports actual Home-button and existing-process activation
commands. The dedicated `NativeHostUITests/AppStateTests` XCTest performs the
same assertions without requiring device loopback forwarding.

For an already staged revision, set `NH_DRIVER_REVISION` to its digit identifier
when generating the Xcode scheme. Alternatively, package the exact immutable
fixture through the existing Xcode `NH_BUNDLE_NAME` build setting:

```text
NH_DRIVER_REVISION=packaged:<revision>       # scheme environment at xcodegen time
NH_BUNDLE_NAME=revisions/<revision>/app.bundle.js   # xcodebuild setting
-only-testing:NativeHostUITests/AppStateTests/testRealApplicationLifecycleAndUnsubscribe
```

This packaged fallback is a native test build, not evidence of no-build device
reload. Record the fixture manifest and actual packaged bundle hash. Existing
signing credentials suffice; do not change Auto-Lock or provisioning settings.
Physical devices must be unlocked for XCTest automation.

The dedicated test waits for a hittable target with stable geometry after
activation. `runningForeground` alone can precede completion of the system
activation transition; an immediate tap was lost in the preserved first actual
test attempt. No service event is synthesized to make the test ready.

## Assertions and evidence limits

Both lanes check:

- A native capability and an asynchronous, native-captured active snapshot.
- A real Home/activate cycle producing background then active transitions, with
  strictly increasing sequence numbers in the same runtime/process. iOS may also
  deliver inactive transitions.
- Unsubscribe followed by another actual OS cycle: the event log stays unchanged
  while a new snapshot's sequence advances, proving transitions occurred without
  another subscription callback.
- No service error and no replacement fixture instance.

Playwright attaches the transition/snapshot records and native identity. XCTest
attaches `AppState-physical-evidence` JSON to its result bundle. Retain failed
attempts and infrastructure timeouts separately. Generation-replacement and late
callback rejection are covered by the real-Hermes CTest boundary tests; these
physical scenarios do not claim to exercise every stale-pointer or reload race.
