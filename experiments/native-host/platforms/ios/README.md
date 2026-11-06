# UIKit host experiment

This application embeds the shared C++ Hermes host, the Rust service archive and
Yoga directly. It does not link React Native's application runtime or Fabric.
React's reconciler runs in Hermes and commits a tree through `runtime/host.h`.
UIKit mounts stable node IDs as UIView, UILabel, UIImageView, UIButton,
UIScrollView, UITextField and WKWebView objects. Two independent WKWebViews can
share a screen with native controls and a native overlay.

## Build and test

Prerequisites: Xcode, XcodeGen, Rust with `aarch64-apple-ios-sim`, and the matched
Hermes 250829098.0.16 destroot. The default Hermes path is the existing local
Tapcart CocoaPods artifact; set `NH_HERMES` to another matched destroot to avoid
that machine-specific default. Headers and runtime must come from the same
Hermes version. The framework is copied into this app by Xcode.

From `experiments/native-host`, first run `npm run bundle`, then:

```sh
bash platforms/ios/build.sh
NH_SIMULATOR_ID=<dedicated-simulator-uuid> bash platforms/ios/test.sh
```

Build output stays in `platforms/ios/build`; XCTest result bundles and screenshots
stay in `platforms/ios/artifacts`. The project is regenerated from `project.yml`.
The current build target is arm64 iOS Simulator only, with signing disabled.

`NH_CONFIGURATION=Release bash platforms/ios/build.sh` selects
`build/app.release.bundle.js` (generate it with `npm run bundle:release`) and
omits native test-hook defines and the Rust `test-hooks` feature. Debug selects
`build/app.bundle.js` and explicitly enables both native test flags. The XCTest
driver is compiled only into the separate test runner, never into the app.

## Authenticated XCTest driver

To control the real app from a Playwright/TypeScript fixture, create a private
ignored JSON configuration containing `platform: "ios"`, an unused loopback
`port`, and a random `token` of at least 24 characters. Start only the driver test:

```sh
NH_SIMULATOR_ID=<dedicated-simulator-uuid> \
  bash platforms/ios/start-driver.sh build/ios-driver.json
```

Wait for `NATIVE_HOST_DRIVER_READY 127.0.0.1:<port>`, then send newline-delimited
JSON `{id, method, params}` over TCP. Authenticate first using
`session.authenticate` with `{token}`. Responses contain the matching `id` and
either `result` or `error: {code, message}`. The token is passed through the
generated, ignored Xcode scheme and is never printed by the scripts.

Supported commands:

| Method | Parameters | Result |
| --- | --- | --- |
| `session.describe` | `{}` | Actual `ios-xctest` backend and capabilities |
| `session.health` | `{}` | Sticky native host envelope/async-error health |
| `ui.find` | `{testID}` | Native accessibility label/value/bounds/state |
| `ui.tap` | `{testID}` | System coordinate tap at element center |
| `ui.type` | `{testID, text, clear?}` | Native keyboard input, clear by default |
| `ui.dismissKeyboard` | `{}` | Native Return-key dismissal |
| `ui.text` | `{testID}` | `{text, label, value}` |
| `ui.snapshot` | `{}` | Identified native accessibility elements |
| `webview.tap` | `{testID, x, y}` | System tap at WebView-local native points |
| `session.close` | `{}` | Clean test completion |

`webview.evaluate` and application/runtime evaluation are explicitly unsupported.
WebView taps use native screen coordinates, not DOM click injection. Therefore
an overlapping native view can receive the tap. The driver binds only loopback,
caps request size at 1 MiB, rejects unauthenticated commands and expires after
180 seconds by default (`NH_DRIVER_TIMEOUT`, clamped to 30–600 seconds). Close
the session to pass the driver XCTest. Do not run this alongside another UI test
or person controlling the same simulator.

## Development revisions and full reload

Debug can explicitly select `--native-host-revision <digits>` from the app's
private `dev-revisions/<revision>` directory. It validates the canonical paths,
manifest schema/version/mode, exact string revision, bundle and source-map byte
lengths and SHA256 digests before creating Hermes. Invalid requested revisions
fail visibly and report unhealthy state; they never silently fall back. Release
compiles this selection and deliberate health-fault injection out and always
loads its packaged production bundle.

Deploy a revision published by the development supervisor without rebuilding:

```sh
NH_SIMULATOR_ID=<dedicated-simulator-uuid> \
  bash platforms/ios/deploy-revision.sh build/revisions/<digits>
```

The script validates and atomically stages the immutable directory, then
terminates/relaunches this app with the exact revision. `NH_STAGE_ONLY=1` stages
without launching. It never runs Cargo, Xcode, a bundler or an installer. Existing
different revisions are not overwritten.

To verify a staged revision through the already-built XCTest driver, add its
string `revision` to the private driver JSON and launch with
`NH_DRIVER_NO_BUILD=1`. This uses Xcode `test-without-building` and does not invoke
Cargo. Driver identity/health expose `loadedRevision`, `runtimeEpoch`, `pid` and
`runtimeGeneration`. The UUID epoch and process identity distinguish reloads even
when a process-local Rust generation starts again at one. React state resets on
the full process launch; this is intentionally not Fast Refresh or native code
hot reload.

`NativeHealthTests` launches the Debug app with a fixed intentional asynchronous
JavaScript error, checks the sticky unhealthy metadata, then verifies a later
successful UI action cannot erase it. There is no arbitrary application-side
evaluation server.

The integration test uses actual UIKit/WebKit accessibility targets and
coordinate taps. It changes React state through a native button, edits a native
text field, waits for an asynchronous Rust echo, presses a DOM button in an
embedded WKWebView, covers that same coordinate with a native button, and checks
that a second WebView receives only its own messages. Screenshots are retained
in the XCTest result bundle.

## Ownership and lifecycle

All Hermes calls and UIKit commits run on the main thread for this experiment.
Rust service completions are polled on display ticks; the weak display-link
proxy avoids retaining a destroyed controller. The host is destroyed when the
controller deallocates. Each WebView has a weak script-handler proxy and a
per-document token paired with the controller's runtime epoch. A document-start
script generates the token, and the native host verifies it against the current
WebKit document before releasing buffered startup messages. Provisional
navigation invalidates the previous token; `pageshow` re-announces restored
documents, and failed provisional navigation re-verifies the surviving document.
React source changes synchronously replace the native record and script seed,
rejecting the previous source before the next load starts. Recovery after failed
provisional navigation requires the current WKNavigation. Messages are limited
to 1 MiB; the handshake buffer holds at most 64 messages and 1 MiB total, with
overflow reported as a sticky host failure. Same-document History API changes
preserve identity regardless of URL shape.
Only current main-frame messages from the mounted WKWebView and matching
token/epoch reach React. Removal stops loading, disconnects delegates, removes scripts/handlers
and drops the token before destroying the native node.

The document-start bridge exposes `window.NativeHost.postMessage(string)` and
the `window.ReactNativeWebView` alias. Inline HTML and app-bundle file fixtures
are supported; HTTP(S) source URLs can also load. File navigation is restricted
to the app bundle. External application URL schemes are rejected.

## Explicit prototype limits

This is a bounded native host, not complete RN component compatibility. Text
uses UILabel; input uses single-line UITextField. Nested rich text, IME edge
cases, gesture arbitration, selection APIs, imperative ref commands,
accessibility parity, native animations, rotation/resize and lifecycle
conformance remain separate work. Layout comes from the shared Yoga host, whose
text measurement is not UIKit typography. Image rendering currently supports
data URIs, local files and named bundled images, not a remote image pipeline.

The production threading model is not decided here. Main-thread Hermes can
block input under heavy JS work. There is no claim that this architecture is
faster than RN; the experiment establishes a real execution/rendering boundary.
The screen-coordinate overlay test checks native hit testing, not merely
DOM-dispatched click events. Tokens reject stale deliveries but are not an
authentication boundary against the currently loaded document itself.

## Physical iPhone builds

Device and simulator builds use separate Rust targets and Xcode output directories.
An unsigned device compilation requires no provisioning changes:

```sh
NH_SDK=iphoneos bash experiments/native-host/platforms/ios/build.sh
```

To sign with an already configured development team and existing suitable profiles:

```sh
NH_SDK=iphoneos NH_DEVELOPMENT_TEAM=<team-id> bash experiments/native-host/platforms/ios/build.sh
NH_DEVICE_ID=<specific-device-udid> NH_DEVELOPMENT_TEAM=<team-id> bash experiments/native-host/platforms/ios/test.sh
```

By default these scripts do not enable provisioning updates or choose a connected
device implicitly. After explicit authorization to create development signing
assets, `NH_ALLOW_PROVISIONING_UPDATES=1` enables Xcode provisioning updates and
registration of the explicitly selected device for the selected existing team.
It does not create an Apple account. The team needs profiles for
`dev.nativehost.prototype` and `dev.nativehost.prototype.uitests.xctrunner`
that include the target iPhone and an available development signing certificate.
An unsigned build is compile evidence only; it cannot establish physical-device behavior.
Device output goes to `build-device/`, and device XCTest results use the
`artifacts/device-*.xcresult` prefix. The localhost simulator driver does not provide
a Mac-to-physical-device tunnel; use the native XCTest suite for this path.

## Native ref commands

The adapter registers TextInput `focus`, `blur`, `clear`; ScrollView `scrollTo`,
`scrollToEnd`; and WebView `goBack`, `goForward`, `reload`, `stopLoading`,
`postMessage`, `injectJavaScript` through `NHHostOptions` at runtime creation.
Responses acknowledge native submission, not asynchronous WebKit completion.
The C++ host validates command arguments and current mounted-node/runtime identity;
the UIKit adapter checks its live view and runtime generation again.

UIKit delegate events defer to the next main-queue turn and recheck view identity,
runtime epoch, and (for WebViews) document token before entering Hermes. Commands
cannot synchronously reenter the runtime from UIKit callbacks. WebView messaging
uses JSON-quoted strings, checks the captured document token in JavaScript before
execution, and discards asynchronous completions after navigation or removal.
Imperative `clear` does not synthesize `onChangeText`. Uncontrolled input
`defaultValue` initializes only at mount, so clearing it is not reversed by an
unrelated React commit; a controlled value may be reasserted by a later commit. Full compatibility and browser command
completion promises remain outside this bounded prototype.

### History fixture scope

The shared command test uses a controlled loopback HTTP document on the iOS
simulator for native back/forward validation. The inline `loadHTMLString` fixture
successfully changed its JavaScript URL with real DOM taps, but WKWebView exposed
`canGoBack == false` and an empty native back/forward list. That observation is
retained in the diagnostic artifacts; the adapter continues to call native
`goBack`/`goForward` and does not emulate those commands with JavaScript history.
Physical iPhone baseline tests use bundled inline documents and do not claim
HTTP history validation on the phone.

## Development updates

The opt-in Debug-only loopback connection delivers dedicated C ABI updates on
the main queue without XCTest. It also builds with app/service test hooks off;
Release excludes the listener and development ingress. See [REFRESH.md](REFRESH.md)
for the wire contract, initial staging limits and simulator transport evidence.
