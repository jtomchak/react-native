# iOS SPA host

The native semantic analytics extension uses a separate bounded SQLite WAL
journal through the shared application services. It records native outcomes
independently of WebView reply lifetime and applies origin-bound server export
policies. See the [analytics guide](../../ANALYTICS.md) and
[current analytics receipts](../../evidence/ANALYTICS-VERIFICATION.md).

Standalone Swift/UIKit/WKWebView host. It links only Apple frameworks and system
SQLite; React Native, Hermes, Yoga, Capacitor, and a Rust runtime are absent.

`SceneDelegate` owns the single scene's `UIWindow(windowScene:)`, UI activation,
and cold/warm URL and browsing-activity entry. `AppDelegate` owns app service and
APNs setup. This supports the scene lifecycle required by SDK 27 without enabling
multiple independent application scenes.

For the installed Xcode.RC toolchain, select it per command without changing the
machine's global Xcode selection:

```sh
DEVELOPER_DIR=/Applications/Xcode.RC.app/Contents/Developer \
SPA_IOS_DESTINATION='platform=iOS Simulator,id=YOUR_IOS_27_SIMULATOR_UDID' \
  bash experiments/spa-native-host/hosts/ios/build.sh test
```

The installed RC is Xcode 27.2, build 27B48. Actual phone, iPhone Duo and iPad
iOS 27.2 tests/layout checks and Release builds are recorded in the
[iOS 27 ledger](../../evidence/IOS27-VERIFICATION.md). The simulator remains a
runtime validation target; the unsigned device build is compilation evidence.

From the repository root, stage the Next export with the parent tooling, then:

```sh
bash experiments/spa-native-host/hosts/ios/build.sh build
bash experiments/spa-native-host/hosts/ios/build.sh test
CONFIGURATION=Release bash experiments/spa-native-host/hosts/ios/build.sh build
```

The default destination is the already available prototype simulator. Override
`SPA_IOS_DESTINATION` to select another simulator. Tests use actual packaged Next
assets and WKWebView, native SQLite and UIKit sheets; they do not fake services.
A controller recreation storage assertion is distinguished from the separate
physical process-termination probe below.

## Asset and transport boundary

`spa://app` is served by `Assets.swift`. Resource paths are decoded once, bounded
by the bundle/photo directory and symlink checks, with explicit MIME and HTTP
response status. No file URL or inline HTML document is used as the app origin.
Actual WK fetch, Next client route payloads, document continuity, and reload are
covered by app-hosted tests. Unknown resources fail instead of fetching from an
external host.

Native message handling verifies the actual WebKit security origin, top-frame
provenance, protocol types, source nonce, current native session, IDs and argument
schemas. Pending completion ownership is checked before removing a request,
including after document replacement. The SDK and immutable transport bootstrap
are installed at document-start, main-frame only. Native events are JSON encoded.

SQLite operations execute on a serial worker, acknowledge durable transactions,
and enforce the protocol byte quota. A separate 64-job bound remains in force
after JavaScript cancellation, until disk work actually completes. Camera capture uses native consent/capture
UI and returns random file handles. Captured JPEGs are persisted and previewed
through the scoped scheme loader. Simulator camera/haptics return UNAVAILABLE.
No simulator image is substituted for a real capture.

## Development

Debug builds accept the explicitly selected origin as a native launch argument:

```sh
xcrun simctl launch --terminate-running-process SIMULATOR_ID dev.spahost.prototype \
  --spa-dev-url http://127.0.0.1:18796
```

Both native origin authentication and navigation policy bind to that exact
scheme/host/effective port. Development flags, inspectability, the development
ATS exceptions, and fixed smoke probes are excluded from Release configuration.
The packaged asset loader stays available for managed photo previews.

## Authorized physical app builds

This prototype uses `dev.spahost.prototype`. The user explicitly authorized the
Jesse Tomchak individual team `NSLC4354J7`, existing development certificate
SHA1 `32ABABC99A946F8387A717249FE79FBAA3F23D96`, and this app's development
provisioning. The script preflights that identity, limits automatic provisioning
to this team, and verifies the resulting signing leaf before accepting a build.
It does not run physical tests or request any additional test app identifier.

```sh
SPA_IOS_DESTINATION='platform=iOS,id=DEVICE_UDID' \
SPA_ALLOW_PROVISIONING=1 SPA_DEVELOPMENT_TEAM=NSLC4354J7 \
  bash experiments/spa-native-host/hosts/ios/build.sh build
```

Installation is explicit through devicectl:

```sh
xcrun devicectl device install app --device DEVICE_UDID \
  experiments/spa-native-host/hosts/ios/build/DerivedData/Build/Products/Debug-iphoneos/SPAHost.app
xcrun devicectl device process launch --device DEVICE_UDID \
  dev.spahost.prototype
```

The physical build script checks the resulting signing certificate leaf against
the authorized SHA1 before reporting success. Simulator tests sign nothing.
 Do not enable provisioning for an
unapproved team or create another certificate to work around a signing failure.

## Fixed physical smoke probe

A Debug app can run predetermined, local probes with `--spa-smoke write|read|dev`
and a bounded `--spa-smoke-token`. These are compiled native scripts, not an
arbitrary evaluation API or network listener. Reports are written to Documents.
The supplied runner requires an installed Debug app; it runs a write phase,
SIGKILLs the reported process, relaunches, and validates the same unique token
against persisted SQLite data with a changed PID:

```sh
python3 experiments/spa-native-host/hosts/ios/tools/smoke-device.py \
  --device DEVICE_UDID --output /absolute/owned/evidence-directory
```

These probes demonstrate actual WK-to-native invocation, UIKit presentation,
SQLite, client navigation, and process persistence. They do not represent an
independent OS touch observer or physical camera capture. Haptic API invocation
is distinct from an attended check that vibration was perceived.

Latest local evidence is under ignored `build/evidence/`; parent integration
reports record the verified results and limitations. Camera capture/permission
UX, interactive gestures, exhaustive process recovery and accessibility still
require their corresponding device acceptance cases.

## Verified acceptance coverage

The final staged 40-asset export passes eight simulator XCTest cases: packaged
Next fetch/routing/document continuity/reload; plain HTML with no SDK tag using
actual document-start injection; the shared `/injected.html` early-ready proof;
native argument/subframe rejection; native SQLite and UIKit presentation;
canonical deep-link/traversal validation; storage-quota transaction rollback;
and actual SQLite/bridge preservation of embedded null characters and emoji
without prefix-key collisions.
See `build/evidence/simulator-final-tests.log` and its referenced xcresult.

Real simulator OS URL delivery exercised warm `spahost://app/compose/` and cold
`spahost://app/library/` entry. `URLComponents.path` preserves the canonical
trailing slash (unlike `URL.path`); malformed origins/routes remain rejected.
Native Compose and Back controls were separately tapped through RocketSim and
observed through accessibility changes. The packaged home was restored afterward.
These UI observations do not certify full DOM accessibility or gesture coverage.

Debug development-origin probing passed against an actual Next server. Source
HMR is parent/browser/Android evidence, not an iOS source-edit timing claim.
Physical camera capture/permission UX and perceived haptics remain unverified;
the iPhone smoke report explicitly distinguishes native haptic invocation from
perceived output. Release checks inspect both the executable and Info.plist for
absence of Debug smoke/development markers and ATS exceptions.

## Hosted source and native shell extension

The bundle owns `host-config.json`; web content cannot select a new trusted
origin. Release accepts an exact HTTPS origin. Debug alone can explicitly select
loopback HTTP for the local production Next server:

```sh
xcrun simctl launch --terminate-running-process SIMULATOR_ID dev.spahost.prototype \
  --spa-content hosted --spa-hosted-url http://127.0.0.1:18797 \
  --spa-navigation native --spa-chrome tabs
```

Use `--spa-chrome adaptive` for a real iPad `UISplitViewController` with a native
UITableView destination sidebar; phones use native tabs. `standard` and web
navigation remain the defaults. These Debug flags do not exist in Release.
Production content/source/shell choices come from the staged bundle config.

Each native tab has its own navigation stack; native visits allocate dedicated
WKWebViews, bounded by eight total surfaces and four screens per stack. The
shared services own SQLite, serialized photo persistence, presentation leases
and native event buffering. There is no WebView pool. Native activation refreshes
SDK host metadata; hidden owners cannot invoke foreground UI or mutate another
screen's bar/gesture state. Registered toolbar titles retain ownership until a
matching clear; tab labels remain independent of page titles. UIKit container
controllers forward status bar appearance to the visible native surface.

Hosted mode shares the normal WKWebsiteDataStore cookie jar. It allows canonical
`/hosted/*` paths in addition to the three packaged application routes, so a new
server page does not require another native route enum. External origins do not
receive bridge grants. Native load failure offers Retry or an app-wide Use
Packaged reset that invalidates all old source owners while retaining storage.
Managed photo previews keep their separate native `spa://app` origin.

The deep-link coordinator handles custom scheme URLs and HTTPS browsing
NSUserActivity for the exact configured origin. HTTPS Associated Domains is
opt-in and still requires an owned domain, deployed AASA, and matching Apple
profile. Build with `SPA_ENABLE_ASSOCIATED_DOMAINS=1` and
`SPA_ASSOCIATED_DOMAIN=YOUR_CONFIGURED_HTTPS_HOST` only when those exist. No domain
verification is implied by the custom scheme tests.

UNUserNotificationCenter/APNs permission, registration, received and opened
callbacks are implemented. Default builds report push `configured:false` and
registration `UNAVAILABLE`. Later, explicit `SPA_ENABLE_PUSH=1` plus bundled
notification enablement compiles registration and generates the APNs entitlement;
`SPA_APNS_ENVIRONMENT` selects development or production. Existing default
provisioning remains usable without these flags. No APNs delivery/provider,
entitlement/profile change, or local-notification substitute was used in this
validation.

System sharing uses UIActivityViewController with an anchored iPad popover and
observed selected/cancelled completion. LocalAuthentication uses biometric-only
policy and returns success solely from the OS callback. Camera, authentication,
sharing and authorization are serialized by owner/request leases. Cancelling an
unrelated request cannot dismiss another native interaction.

## Hosted extension validation (2026-11-05)

All 19 app-hosted XCTest cases pass on the iPhone 17 Pro iOS26.5 simulator and
iPad Pro13 M5 iOS26.5 simulator. This includes the original eight packaged
regressions plus actual WK/UIKit native-shell tests. The hosted test contacts a
production-built Next server on18797, opens the dynamic `/hosted/item/42/`
server page in a native visit, verifies Item42 toolbar ownership and invokes
native storage. It explicitly skips when that server is absent.

```sh
bash experiments/spa-native-host/hosts/ios/build.sh test
SPA_IOS_DESTINATION='platform=iOS Simulator,id=0FB0C378-3090-45B4-863B-38E2C54E0E90' \
  bash experiments/spa-native-host/hosts/ios/build.sh test
CONFIGURATION=Release bash experiments/spa-native-host/hosts/ios/build.sh build
```

Logs: `build/hosted-final-tests.log`, `build/hosted-ipad-tests.log`,
`build/hosted-release-build.log`. Additional cases cover retained tab documents,
hidden UI denial, shared SQLite, native push/pop, chrome restoration, actual
share-sheet request-scoped cancellation, native sidebar/detail composition,
status forwarding, unconfigured push, biometric availability, exact-origin links,
encoded traversal/separator rejection, initial path and app-wide fallback.

RocketSim OS interaction receipts/screenshots in `build/evidence/hosted/` show
native sidebar selection/hiding, native phone tabs, web link -> native Compose
push, cancelled edge pop then committed edge pop to the retained original page,
and the actual iPad share popover opened from the hosted page. The cancellation
video is `phone-pop-cancel.mp4`; its contact sheet shows the underlying original
page during the gesture and Compose restored afterward. This evidence does not
claim a share recipient received content, successful biometric authentication,
real push delivery, physical camera capture or perceived haptics.

Final physical iPhone12 validation of the same runtime source passed nine write
and two read checks across PID1909 ->1915. The final demo launch explicitly uses
`--spa-content packaged --spa-navigation native --spa-chrome tabs` (PID1919),
recorded in `build/evidence/hosted/physical-final/demo-launch.json`. These are
Debug demo options; the bundled default remains packaged/standard/web. Hosted
HTTPS on a physical device, real APNs delivery and attended biometric success
remain separate acceptance gates. Final SDK/config hashes match staged assets
in Debug simulator, Release simulator, and Debug physical bundles; see
`build/evidence/hosted/provenance.json`. Release executable/Info.plist guards are
recorded in `release-guards.json`.
