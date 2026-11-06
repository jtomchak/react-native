# Xcode.RC and iOS 27 verification — 2026-11-05

This is the scene/layout acceptance snapshot. The subsequent analytics extension
has separate current source/artifact hashes and tests in
[ANALYTICS-VERIFICATION.md](ANALYTICS-VERIFICATION.md); it does not imply a rerun
of every geometry case below with the analytics-enabled artifact.

The current prototype builds with `/Applications/Xcode.RC.app`: Xcode **27.2**,
build **27B48**, iPhoneOS/iPhoneSimulator SDK **27.2**. Global `xcode-select`
remains unchanged. All runtime checks below used owned iOS/iPadOS **27.2**
simulators, including the separate iPhone Duo runtime.

## Changes required

The initial SDK 27 build compiled but failed to launch with UIKit's
`UIScene life cycle is required for apps built with this SDK` assertion.
The host now declares a single scene in both Debug and Release manifests.
`SceneDelegate` creates `UIWindow(windowScene:)`, handles cold/warm URLs and
browsing activities, and forwards activation. `AppDelegate` retains shared
service/APNs setup. Canonical origin/path validation is retained. Cold
notification responses use the actual request identifier for existing dedup.
See Apple's [scene migration guide](https://developer.apple.com/documentation/uikit/transitioning-to-the-uikit-scene-based-life-cycle).

The iPad landscape check also reproduced joined words when responsive CSS hid a
heading's line break. Literal spaces fix the home, Compose and Library headings;
a wide browser test checks rendered spacing and horizontal overflow on all three.
No new dependencies, signing changes or broad native-shell rewrite were needed.

## Final results

| Check | Result | Evidence |
| --- | --- | --- |
| iPhone 18 Pro, 27.2 | 20 XCTest cases passed, zero failures | [phone log](../hosts/ios/build/evidence/ios27/phone-tests.log) |
| iPhone Duo, 27.2 | 20 XCTest cases passed, zero failures | [Duo log](../hosts/ios/build/evidence/ios27/duo-tests.log) |
| iPad Pro 13-inch M5, 27.2 | 20 XCTest cases passed, zero failures | [iPad log](../hosts/ios/build/evidence/ios27/ipad-tests.log) |
| Release simulator | Build passed with SDK 27.2 | [build log](../hosts/ios/build/evidence/ios27/release-simulator-build.log) |
| Release device | Unsigned build passed with iPhoneOS 27.2 SDK; not installed/executed | [build log](../hosts/ios/build/evidence/ios27/release-device-build.log) |
| Packaged browser | 10 passed; 4 hosted cases intentionally skipped here | [log](../hosts/ios/build/evidence/ios27/browser-tests.log) |
| Hosted production Next | 4 passed against independently rebuilt production server | [log](../hosts/ios/build/evidence/ios27/hosted-browser-tests.log) |
| Node contracts/tooling | 41 passed | [log](../hosts/ios/build/evidence/ios27/node-tests.log) |

The suite uses real WKWebView/native SQLite and UIKit, including scene ownership,
native tabs/visits/chrome, presentation ownership, injection and hosted routes.
Browser native interactions remain explicit mocks, separate from native tests.

## Layout and actual OS interaction

- **Phone:** packaged native-tab layout rendered with SDK 27.2. Real warm OS
  custom-scheme delivery selected Compose/Save; after process termination, a cold
  custom-scheme delivery opened Library/Capture through scene connection options.
  The system's Open confirmation was accepted during the first dispatch.
  [Phone layout](../hosts/ios/build/evidence/ios27/phone-final-tabs.png),
  [warm link](../hosts/ios/build/evidence/ios27/phone-scene-warm.json),
  [cold link](../hosts/ios/build/evidence/ios27/phone-scene-cold.json).
- **Duo:** closed outer and book/open inner display layouts rendered and resized.
  A typed unsaved draft survived folding; native Save committed
  `Duo fold draft 27` to the real SQLite store. The saved draft remained available
  after the final asset rebuild and relaunch. UIKit owns its native tab/rail
  adaptation; this does not add an iPad sidebar to the phone idiom.
  [Closed](../hosts/ios/build/evidence/ios27/duo-final-closed.png),
  [book](../hosts/ios/build/evidence/ios27/duo-final-book.png),
  [open Compose](../hosts/ios/build/evidence/ios27/duo-final-open-compose.png).
- **iPad:** actual native sidebar selection, detail/Save and Hide/Show Sidebar
  worked in portrait (1032×1376) and landscape (1376×1032). An OS window resize
  to **905×877** retained Compose and saved state. The final rebuilt bundle was
  retaken windowed with sidebar visible and hidden; wide heading spacing is fixed.
  [iPad report](../hosts/ios/build/evidence/ios27/ipad-layout-report.json),
  [windowed handoff](../hosts/ios/build/evidence/ios27/ipad-handoff.png).

Duo pose commands sometimes returned confirmation timeouts even though subsequent
independent hinge reads confirmed `closed`, `partiallyOpen` or `openFlat` and
the corresponding display geometry. Those error receipts remain alongside hinge
and screenshot evidence; command success is not inferred from the request.

## Provenance and retained failures

[report.json](../hosts/ios/build/evidence/ios27/report.json) records native/test/UI
source hashes, test-log hashes and actual Debug/Release binary hashes. Every
Debug simulator, Release simulator and unsigned Release device bundle matched
all **40** staged asset hashes, including the corrected headings. Their asset
manifest SHA-256 is
`af9c8639b851691692fce66442f7fd59f9e6fbfb63c8a05becdce15367474d27`.
Both Release bundles contain the scene manifest, exclude Debug launch switches,
and have no Debug ATS exceptions.

The initial scene assertion is retained in `pre-scene-launch-failure.log`.
Initial post-migration tests exposed a title-hydration race and share assertions
using fixed sleeps; bounded actual-state observation preserves those assertions.
The phone's notification-status check also timed out, and a direct native OS
query received no callback. After restarting only the owned phone simulator,
the final full suite passed. No runtime notification change or APNs delivery fix
is inferred from that recovery. First/focused failure logs remain retained.
Independent final source/evidence review found no verified defect.

## Reproduce

From the repository root, with staged assets and production server on 18797:

```sh
DEVELOPER_DIR=/Applications/Xcode.RC.app/Contents/Developer \
SPA_IOS_DESTINATION='platform=iOS Simulator,id=SIMULATOR_UDID' \
  bash experiments/spa-native-host/hosts/ios/build.sh test
```

Use `CONFIGURATION=Release` and `build` for simulator Release compilation.
The device compile used `xcodebuild build -configuration Release -sdk iphoneos
-destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO` with the same
project/scheme and RC toolchain. It did not provision or install a device app.

## Limits and handoff

No physical iOS 27/Duo hardware run is claimed. Further compact iPad window
widths, every windowing mode and every accessibility setting were not verified;
the observed window resize is 905×877. The earlier platform-service acceptance
gates remain: actual biometric presence, camera/haptics and configured remote
push delivery. This run does not reverify Android with the changed web assets.

The temporary Next server is stopped after testing. The three owned simulators
remain booted with packaged native demos; earlier simulators and physical-device
installations are preserved. No commit or push made.
