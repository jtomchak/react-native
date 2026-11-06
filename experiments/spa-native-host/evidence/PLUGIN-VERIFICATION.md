# Auth plug-in verification — 2026-11-06

Auth is extracted into `@nativehost/auth`, with the shared native SPI in
`@nativehost/plugin-api`. One declaration selects the browser, server, SwiftPM
and Gradle registrations. No CocoaPods or new third-party runtime dependency was
added by this extraction. Existing approved auth dependencies moved into the
auth package.

## Results

| Check | Auth selected | Empty selection |
| --- | --- | --- |
| Node contracts/tooling | 81 passed, including selection/removal and generator validation | Covered in the same suite |
| Browser client | 26 passed | SDK removal contract passed |
| Production Next auth flows | 4 passed against isolated local OIDC/WebAuthn fixtures | Auth route returned 404; SSR anonymous; private auth config not read |
| Static export / hosted build | Both passed; 40 packaged assets | Both passed |
| iOS Xcode.RC / iPad simulator, iOS 27.2 | 22 passed; final restored build passed | 4 core/registry tests passed |
| Android app and instrumentation APK builds | Passed with auth and shared API libraries | Passed without auth, Credentials or Browser libraries |
| Physical Pixel 2 XL generic registry | 7 assertions passed | 8 assertions passed; removed action rejected; core storage works |
| npm package consumer | Both tarballs installed offline outside checkout; JS exports and native paths resolve | Not applicable |

The selected iOS tests include 14 auth tests, three hosted-document privacy
tests, a real JavaScript handshake/capability check and four core tests. Removed
build inspection found no auth code/link contribution or auth SDK installer.
The final restored app's 40 packaged asset hashes and sizes matched the staged
export.

Removed Android inspection found no auth/Credentials/Browser classes in the app
DEX, no auth integration-test classes in the test DEX and no auth callback in the
merged manifest. Both removal matrices used an ignored temporary declaration;
the checked-in selection stayed unchanged. Generated outputs and app artifacts
were restored to the normal selected-auth configuration afterward.

The physical Android auth security run completed 28 assertions, then failed at
the next bridge admission assertion. The live session run completed two, then
timed out waiting for a foreground-dependent document refresh. The device was
observed with a secure keyguard showing. These two runs are **incomplete**, not
passing auth suites; they need an unlocked-device rerun. The generic registry
results above do not replace them. Raw assertion summaries are retained below.

Production OAuth provider configuration and real-device passkey association
remain deferred as previously requested. Local fixture success does not verify
those deployments. This task's iOS runtime results are simulator results.

## Reproduction

From `experiments/spa-native-host`:

```sh
npm test
npm run plugins:check
npm run plugins:pack-test
npm run export
npm run hosted:build
npm run test:browser
npm run test:auth
```

The package check packs both allowlisted packages, installs them in a temporary
consumer, executes client/server exports, resolves React/manifest exports,
evaluates the installed SwiftPM manifest and checks Gradle source resolution.
Its local receipt is `build/plugin-pack/report.json`; it publishes nothing.

iOS used `/Applications/Xcode.RC.app/Contents/Developer`, the iPad simulator
destination recorded in the text receipts below, and ad-hoc simulator signing.
The receipts preserve the exact `xcodebuild` invocations and test totals.

Android build, from the repository root:

```sh
bash experiments/spa-native-host/hosts/android/build.sh :app:assembleDebug :app:assembleDebugAndroidTest :app:dependencies --configuration debugRuntimeClasspath
```

After installing the matching app/test APKs on the selected device:

```sh
adb -s DEVICE_SERIAL shell am instrument -w -e mode plugins -e expectedPlugins 1 dev.spahost.prototype.test/dev.spahost.prototype.HostInstrumentation
adb -s DEVICE_SERIAL shell am instrument -w -e mode auth dev.spahost.prototype.test/dev.spahost.prototype.HostInstrumentation
adb -s DEVICE_SERIAL shell am instrument -w -e mode auth-live dev.spahost.prototype.test/dev.spahost.prototype.HostInstrumentation
```

`auth-live` additionally needs the isolated `tests/fixtures/auth-device-server.mjs`
fixture and its loopback port forwards. It never uses a production identity.
For removal, set `SPA_PLUGIN_DECLARATION_FILE` to an absolute path containing
`{"schemaVersion":1,"plugins":[]}` for every export/build command, then run the
generic test with `-e expectedPlugins 0 -e absentAction auth.status`. Restore with
ordinary export/build commands without the override. See [PLUGINS.md](../PLUGINS.md).

## Evidence and review scope

- [Selected iOS test summary](plugin-ios-full-tests.txt)
- [Removed iOS test summary](plugin-ios-empty-tests.txt)
- [Selected Android registry](plugin-android-selected-runtime.txt)
- [Removed Android registry](plugin-android-removed-runtime.txt)
- [Incomplete Android auth security run](plugin-android-selected-security.txt)
- [Incomplete Android live session run](plugin-android-selected-live.txt)
- [Browser client results](browser-results.json)
- [Production Next auth fixture results](auth-server-browser-results.json)

Independent source review found no remaining actionable defects in the plug-in
refactor, generator, new package boundaries or retained session guards. That
review compared this refactor with the staged earlier prototype; it was not a
fresh audit of every historical native-host experiment file being published.
