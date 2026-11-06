# SPA native host prototype

Auth is now the first single-package native plug-in, with SwiftPM and Gradle
integration generated from one declaration. See [PLUGINS.md](PLUGINS.md) and
[PLUGIN-VERIFICATION.md](evidence/PLUGIN-VERIFICATION.md).

Native OAuth/passkeys and the Next.js HttpOnly session handoff are described in
[AUTH.md](AUTH.md), with current results in
[AUTH-VERIFICATION.md](evidence/AUTH-VERIFICATION.md). Live providers remain opt-in.

The embedded native analytics engine records semantic events locally and applies
server-controlled export filters. See [ANALYTICS.md](ANALYTICS.md) and its
[verification ledger](evidence/ANALYTICS-VERIFICATION.md).

The iOS host now adopts the scene lifecycle required by SDK 27. Current
Xcode.RC/iOS 27.2 build and phone/Duo/iPad layout results are in
[IOS27-VERIFICATION.md](evidence/IOS27-VERIFICATION.md).

Hosted Next.js, opt-in native visits, native tabs/iPad split view and the new
native interaction APIs are described in [HOSTED.md](HOSTED.md). Their current
acceptance ledger is [HOSTED-VERIFICATION.md](evidence/HOSTED-VERIFICATION.md).

Next.js static-export SPA, independent iOS/Android hosts, and a framework-neutral
injected platform SDK. The hosts own WebView messaging, native toolbar/modal
presentation, haptics, still-photo capture, managed files and SQLite storage.
No Capacitor, React Native, Hermes, Yoga, or Stimulus runtime is required.

Working prototype. See [PLAN.md](PLAN.md),
[protocol/CONTRACT.md](protocol/CONTRACT.md) and
[DEPENDENCIES.md](DEPENDENCIES.md) for boundaries and approved versions. Verified
initial results are recorded in the historical
[baseline ledger](evidence/VERIFICATION.md). Use the
[hosted/native-shell ledger](evidence/HOSTED-VERIFICATION.md) for current results.

Run commands from this directory, independently of the React Native workspace:

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run export
npm test
npm run test:browser
npm run build:ios
npm run build:android
```

`export` prepares the public SDK/HTML fixture, builds the Next application, and
stages hashed assets in `build/web/`. Native builds consume this directory.
`sync` restages an already built export; it does not compile changed application
source. No generated Next output should be hand-edited.

For a normal browser preview of the packaged application:

```sh
npm run serve
# http://127.0.0.1:18795
```

The browser preview reports native services as unavailable. Browser tests use an
explicit fake transport and are not evidence of real camera/haptics/navigation.
The ordinary HTML fixture at `/plain.html` uses the same SDK without React.
The `/injected.html` fixture contains no SDK script tag: native hosts inject the
bundled SDK before the page's own code; a normal browser reports no host injection.

For web development:

```sh
npm run dev -- --port 18796
```

Native host configuration, installation and device verification are described in
the [iOS guide](hosts/ios/README.md) and [Android guide](hosts/android/README.md).
Development origins must be explicitly selected and
authorized in Debug; packaged Release must operate without a development server.

In the default web-navigation mode, Next owns SPA routes/history and the host
mirrors committed route state for toolbar controls. Opt-in native navigation adds
native visits with route-owned WebViews and independent tab stacks. Back first
resolves transient UI and acknowledged local web history, then the native stack.
See [HOSTED.md](HOSTED.md) for mode selection and native shell behavior.

The SPA renders DOM content; the toolbar, presentation, haptics, camera and
storage integrations are native. The browser SDK requires no React or Stimulus.
For example, in a hosted document:

```js
await window.platform.ready();
await window.platform.haptics.impact({style: 'light'});
await window.platform.storage.set('draft', 'Saved through native SQLite');
```

Camera capture is implemented with platform-native still capture and opaque
managed photo handles. Real capture, permission UX and perceived vibration remain
attended hardware acceptance checks; automated invocation is not a substitute.

Production dependencies are isolated in this prototype and were approved on
2026-11-05. Native toolchains remain Xcode and Gradle. Physical iOS signing must
use explicitly authorized identifiers/profiles; simulator builds need no signing.
