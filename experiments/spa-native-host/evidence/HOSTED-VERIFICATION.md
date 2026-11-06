# Hosted mode and native shell verification — 2026-11-05

This records the hosted/native-shell acceptance snapshot before the iOS 27
scene migration and heading-spacing rebuild. For the latest iOS source, staged
assets and Xcode.RC artifacts, use [IOS27-VERIFICATION.md](IOS27-VERIFICATION.md).
Android figures below refer to their retained earlier APKs; they were not rerun
as part of the subsequent iOS task.

The isolated prototype supports packaged static content and a separately built
production Next.js server, opt-in native visits, native tabs and an adaptive iPad
sidebar/detail shell. The framework-neutral injected SDK exposes native actions
to React and ordinary HTML. The hosts are Swift/UIKit/WKWebView and
Kotlin/Android WebView. These hosts do not link React Native, Hermes, Yoga, Rust,
Capacitor or Stimulus. Native builds still use Xcode and Gradle.

This is functional prototype evidence, not a performance comparison or a claim
of production readiness. The earlier [baseline ledger](VERIFICATION.md) retains
its own runs and artifact identities.

## Implemented scope

| Boundary | Result |
| --- | --- |
| Content | Independent packaged and hosted builds; production Next rendering, HttpOnly cookie and Server Action; dynamic `/hosted/item/[id]/` screens |
| Navigation | Explicit push/replace/modal native visits; ordinary Next links retain web navigation; route-owned WebViews with bounded per-tab stacks |
| iOS chrome | UIKit navigation/tab controllers; iPad split-view native destination list; surface-owned appearance and interactive edge pop |
| Android chrome | Material bottom tabs, independent stacks, predictive Back progress/cancel/commit; root Back delegates to the OS |
| Hosted trust | Exact configured origin; HTTPS required in Release; explicit Debug loopback override; native retry/packaged fallback |
| Push | Authorization/status, APNs/FCM registration/receive/open adapters and typed unconfigured result; provider setup deferred by user |
| Deep links | Canonical custom scheme, warm/cold routing and configured HTTPS handling; association-file templates supplied |
| Sharing | Actual platform share UI, managed-photo support and iPad popover anchoring |
| Biometrics | Platform availability/enrollment, authentication/cancellation adapters; successful user presence remains attended acceptance |
| Existing services | Camera, managed photo files, haptics and durable native SQLite retained |

Defaults remain packaged content, web navigation and standard chrome. The demo
launches explicitly select native navigation and tabs/adaptive chrome. See
[HOSTED.md](../HOSTED.md), [configuration](../configuration/README.md) and the
[extension contract](../protocol/EXTENSIONS.md) for operation and API boundaries.

## Actual results

Counts below refer to their own test category. Instrumentation assertions,
browser cases, fixed in-app probes and OS gestures are separate evidence.

| Check | Result | Receipt |
| --- | --- | --- |
| Node contracts/tooling | 41 tests passed | [node-tests.log](hosted/node-tests.log) |
| Packaged browser | 9 cases passed; 4 hosted cases intentionally skipped in this configuration | [browser-results.json](browser-results.json), [log](hosted/packaged-browser.log) |
| Production hosted browser | 4 cases passed: request-time rendering, cookie/action, dynamic IDs, assets/health/injection fixture | [hosted-browser-results.json](hosted-browser-results.json) |
| Packaged asset build | 40 hashed assets; independently retained when hosted build runs | [manifest](../build/web/asset-manifest.json) |
| iOS phone simulator | 19 XCTest cases passed against real WK/native services and shell | [log](../hosts/ios/build/hosted-final-tests.log) |
| iPad simulator | 19 XCTest cases passed | [log](../hosts/ios/build/hosted-ipad-tests.log) |
| Physical iPhone 12 | 9 fixed native/WK checks plus 2 storage checks after SIGKILL/relaunch; PID 1909 → 1915 | [summary](../hosts/ios/build/evidence/hosted/physical-final/summary.json) |
| Physical Pixel 2 XL, API30 | Packaged extension 56 assertions; hosted extension 77; baseline 47 plus 6 after process restart | [Android report](../hosts/android/evidence/hosted-extensions-final/report.json) |
| Android API36 OS gestures | 13 assertions; actual injected touchscreen predictive progress/cancel/commit and root delegation | Android report and retained per-feature logs |
| Android API36 OS integrations | Actual chooser 6; permission denial 9; biometric unavailable 4; offline retry/fallback 7 | Android report and retained per-feature logs |
| Android custom link | 7 assertions using actual OS warm custom-scheme dispatch on Pixel | Android report, `links.log` |
| Native builds | iOS Debug simulator/device and Release simulator; Android Debug/test/unsigned Release and lintRelease passed | Host build logs; provenance below |

Browser native-action tests explicitly mock the transport. Hosted tests use the
real production Next server over Debug loopback HTTP; they do not prove a public
HTTPS deployment. iOS physical checks are fixed Debug-only in-app probes, not
independent physical OS touch automation. Android API30 system Back evidence is
separate from API36 predictive gesture evidence.

## OS-level iOS interaction evidence

Phone simulator native push followed by a short cancelled edge swipe preserved
the native stack; a committed edge swipe returned to the retained root. The
cancel video/contact sheet and final pop receipt are retained:
[push](../hosts/ios/build/evidence/hosted/phone-native-push.json),
[cancel video](../hosts/ios/build/evidence/hosted/phone-pop-cancel.mp4),
[contact sheet](../hosts/ios/build/evidence/hosted/phone-pop-cancel-contact.png),
[committed pop](../hosts/ios/build/evidence/hosted/phone-pop-commit-final.json).

The iPad native sidebar selected Compose in the detail pane, exposed native Save,
and hid/showed through the native control. A real anchored UIActivity share
popover opened. See [sidebar selection](../hosts/ios/build/evidence/hosted/ipad-sidebar-compose.json),
[sidebar visibility](../hosts/ios/build/evidence/hosted/ipad-sidebar-hide.json),
[share popover](../hosts/ios/build/evidence/hosted/ipad-share.png) and
[final native sidebar](../hosts/ios/build/evidence/hosted/ipad-final-sidebar.png).

## Artifact identity and review

The [hosted build receipt](../build/hosted-build.json) records the lockfile,
bootstrap, copied public/static resources and staged server graph (excluding
Next's runtime-generated `route-cache/` responses):
163 files, aggregate SHA-256
`2567ab38dc4c66fc8a21540e0011e8c8371578aad0aff32214f3bd2bc9114894`.

The bundled SDK SHA-256 is
`59ea5a73826af2fc66ab04d9ca818673e946ff7ca7c9aebf9d30e2d2a46798bb`;
bundled configuration SHA-256 is
`9442ab308c8652326a9200233cb0eabb1c7b3d78ffa3db4318a7c8e1142338f8`.
[iOS provenance](../hosts/ios/build/evidence/hosted/provenance.json) binds source
hashes and these resources to Debug simulator, Release simulator and Debug
device bundles. [Release guards](../hosts/ios/build/evidence/hosted/release-guards.json)
verify Debug launch flags and ATS exceptions are absent and push entitlements
remain opt-in.

The final Android Debug APK SHA-256 is
`db6c5e61152608c89597c47e4a202ddcb97a1b9a4c0e08a71b63fb7742b7acef`;
unsigned Release is
`135f847d6218c398270671001433c9ec47978be1b33d1a3f40d0aba06872a0fb`.
The Android report records source-manifest and per-log hashes. All final runtime
receipts use this same Debug app APK. The last links fixture changed only the
test APK, whose differing hashes are recorded per row. Both native asset gates
verified all 40 packaged files. Android Release compiled but was not executed.

Independent review found and prompted fixes for cross-surface presentation
ownership, camera cancellation leases, inactive chrome writes, source fallback,
initial routing, appearance restoration, quota/tab atomicity, notification-denial
state and root predictive Back registration. Follow-up checks verified the fixes.

An initial Android packaged instrumentation run stopped before assertions with
`Process crashed` and no crash-buffer entry. The identical app/test APK rerun
passed 56, followed by baseline 47+6. Its failure log remains retained; no cause
or corrective runtime change is inferred from the successful rerun.

## Remaining acceptance gates

- APNs/FCM project/provider configuration and real remote delivery were explicitly
  deferred. No remote token/delivery or local-notification substitute is claimed.
  Provider acceptance must cover token rotation, foreground/background delivery,
  cold/warm taps and consistent message identity across native ingress paths.
- Universal/App Link association requires an owned HTTPS domain, deployed files
  and signing configuration. Parser/custom-scheme tests do not verify domain
  association. No public HTTPS deployment was created.
- Actual successful biometric user-presence authentication remains attended.
  The unavailable/no-enrollment path is verified; it is not successful auth.
- Share UI presentation/selection does not prove recipient delivery. Physical
  camera capture and perceived haptics remain attended checks from the baseline.
- No speed, memory or battery superiority is established by these functional runs.

## Handoff

The temporary production loopback server and owned read-only API36 emulator were
stopped. Owned Android port 18797 reverse/inspection forwards were removed; the
pre-existing 18791 reverse was preserved. No shared AVD was deleted or wiped.
Packaged native-tab demos were left launched on iPhone 12 and Pixel 2 XL; the
iPad simulator remains available with the native sidebar visible. These explicit
demo launch arguments do not change bundled defaults. No commit or push made.
