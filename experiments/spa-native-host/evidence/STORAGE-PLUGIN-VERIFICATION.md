# Native storage as the second plug-in — 2026-11-06

`@nativehost/storage` now ships its JavaScript facade, native implementations,
SwiftPM/Gradle inputs and conditional integration tests in one package. The
application selects it alongside `@nativehost/auth` in `configuration/plugins.json`.
No third-party runtime dependency or CocoaPods integration was added.

The existing `platform.storage.get/set/remove` API and private SQLite data paths
are preserved. Keys remain limited to 128 UTF-8 bytes, values to 32,768 bytes,
and logical key/value payload to 1 MiB. Accepted disk work retains its queue slot
after cancellation. Auth credentials and analytics retain independent native
stores. See [the package contract](../packages/storage/README.md).

## Verification matrix

| Check | Auth + storage | Auth only, storage removed |
| --- | --- | --- |
| Clean npm installation | `npm ci --ignore-scripts --no-audit --no-fund` passed | Same installed packages; selection changed only |
| Node contracts/tooling | 84 passed | Removal and optional-adapter cases included |
| Client browser | 27 passed, including missing-storage UI regression | Staged removal SDK regression passed without SDK interception |
| Production Next browser | 4 auth and 4 hosted tests passed | Auth session route and anonymous SSR retained; storage route 404 |
| Packaged export / hosted build | Both passed | Both passed |
| iOS / Xcode.RC / iPad simulator iOS 27.2 | 35 tests passed; additional registry namespace check passed | 3 hosted auth/privacy + 27 retained tests passed |
| Android / physical Pixel 2 XL, API 30 | Storage 63, host 47, process restart 2, registry 8, auth 31 and live OAuth/session 27 assertions passed | Registry 13, analytics 53, auth 31 and live OAuth/session 27 assertions passed |
| Native artifact inspection | Two plug-in libraries and SDK namespaces registered | Storage library, test contribution and capabilities absent; auth retained |
| npm tarball consumer | API, auth and storage installed offline outside checkout | Storage declares no React/server adapter |

iOS coverage includes legacy SQLite continuity, plug-in recreation, malformed
arguments, Unicode/NUL round trips, quota rollback and the 64-operation queue
bound after cancellation. It also includes retained auth and analytics suites,
actual JavaScript capability/namespace checks and hosted-document retirement.

Android's focused storage tests use an isolated database for destructive quota
and legacy-schema fixtures. The installed app's existing data is preserved.
The host persistence check force-stopped the app between native processes
29445 and 29653 and verified the saved test value in the second process.

The auth-only runtime checks exercise the real transport: the storage namespace
and capabilities disappear, raw `storage.get` fails with `UNSUPPORTED`, and auth
and analytics still respond. Android's retained live test uses actual Custom
Tabs, the native callback, Keystore, HttpOnly cookie handoff, authenticated Next
rendering, server-session revocation and the React sign-in/sign-out helpers.
Its identity provider is an isolated loopback fixture.

The browser removal regression verifies Compose, Library and Overview remain
usable, with persistence-dependent controls disabled and no storage or camera
dispatch. It first runs against an explicitly assembled auth-only SDK, then
against the staged auth-only export without intercepting that SDK. The native
transport in this browser test is a test double; device evidence is separate.

Both removal matrices use an ignored temporary declaration, leaving the authored
two-package selection unchanged. Restored selected-build checks are recorded
with the native receipts below. SQLite itself remains in the host for analytics;
removal inspection checks the storage plug-in, not all SQLite code.

Final restoration passed on both platforms. The iPad's registry test confirms
both SDK namespaces and native registrations; the Pixel's registry test passes
eight assertions with two plug-ins. Both restored apps match all 40 staged asset
hashes and sizes, and the selected app/test APKs are installed on the Pixel.

## Reproduction

Run from `experiments/spa-native-host`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run plugins:pack-test
npm run export
npm run hosted:build
npm run plugins:check
npm run test:browser
npm run test:auth
```

For the four hosted tests, start the owned local production fixture with
`node tests/fixtures/auth-device-server.mjs`, then run
`SPA_HOSTED_TEST_URL=http://127.0.0.1:18803 npm run test:hosted`.
Stop the fixture afterward. Production OAuth provider configuration is not used.

Android native builds, from the repository root:

```sh
bash experiments/spa-native-host/hosts/android/build.sh :app:assembleDebug :app:assembleDebugAndroidTest :app:dependencies --configuration debugRuntimeClasspath
```

Install the matching app/test APKs before running instrumentation. Modes are
`storage` (focused suite), `storage-host` (host regression),
`storage-persistence` (second-process verifier), `plugins`, `analytics`, `auth`
and `auth-live`. `hosts/android/verify-device.py --serial DEVICE_SERIAL` runs
the host/restart sequence. Registry example:

```sh
adb -s DEVICE_SERIAL shell am instrument -w -e mode plugins -e expectedPlugins 2 dev.spahost.prototype.test/dev.spahost.prototype.HostInstrumentation
```

For removal, create an ignored declaration containing just the unchanged auth
entry. Set `SPA_PLUGIN_DECLARATION_FILE` to its absolute path for every export,
hosted build and native build command. Run the registry test with
`-e expectedPlugins 1 -e absentAction storage.get`. Run the staged removal browser
check with:

```sh
SPA_STORAGE_REMOVED_BUILD=1 npm run test:browser -- --grep 'storage removal keeps' --reporter=line
```

iOS used `DEVELOPER_DIR=/Applications/Xcode.RC.app/Contents/Developer`, ad-hoc
simulator signing, and the simulator destination and exact `-only-testing`
selectors preserved in its receipts. Restore the normal graph with ordinary
export/build commands without the declaration override. Native selected and
removed builds must not race against the same generated output.

## Evidence and limits

- [Selected iOS tests](storage-plugin-ios-selected-tests.txt), [selected namespace check](storage-plugin-ios-sdk-registry-tests.txt)
- [Removed iOS auth/privacy tests](storage-plugin-ios-auth-only-surface-tests.txt), [retained suites](storage-plugin-ios-auth-only-retained-tests.txt)
- [Removed iOS artifacts](storage-plugin-ios-auth-only-artifact.json), [restored artifacts](storage-plugin-ios-restored-artifact.json), [restored runtime](storage-plugin-ios-restored-runtime-tests.txt)
- [Selected Android storage](storage-plugin-android-selected.txt), [registry](storage-plugin-android-selected-runtime.txt), [process restart](storage-plugin-android-process-restart.json)
- [Selected Android auth](storage-plugin-android-auth.txt), [live session](storage-plugin-android-auth-live.txt)
- [Removed Android artifacts](storage-plugin-android-auth-only-artifacts.json), [registry](storage-plugin-android-auth-only-runtime.txt), [analytics](storage-plugin-android-auth-only-analytics.txt)
- [Retained Android auth](storage-plugin-android-auth-only-auth.txt), [live session](storage-plugin-android-auth-only-live.txt)
- [Android consolidated selected/removal/restored results](storage-plugin-android-results.json)
- [Production server removal checks](storage-plugin-removed-server.json), [tarball consumer](storage-plugin-package-consumer.json)

Independent source review found no remaining actionable defects after fixing
the missing-storage Compose crash. Review covered native ownership and storage
semantics, optional adapters, package boundaries and removal behavior. All native
checks used Debug builds; no Release benchmark, production identity
provider, physical iOS run, or real-device passkey enrollment is asserted here.
An exploratory Android DevTools scalar probe was inconclusive and is excluded
from acceptance results; the passing instrumentation suites verify scalar results.
