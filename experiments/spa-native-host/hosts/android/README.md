# Android SPA host

The native semantic analytics extension is owned by `HostApplication`, so its
SQLite journal and uploader survive Activity/WebView recreation. User KV storage
remains separate. See the [analytics guide](../../ANALYTICS.md) and
[current analytics receipts](../../evidence/ANALYTICS-VERIFICATION.md).

Standalone Kotlin Android application; no React Native, Hermes, Yoga, Capacitor,
or Tauri. Build only this Gradle project, after the parent web export/sync step:

```sh
bash experiments/spa-native-host/hosts/android/build.sh assembleDebug assembleDebugAndroidTest
adb -s DEVICE install -r experiments/spa-native-host/hosts/android/app/build/outputs/apk/debug/app-debug.apk
adb -s DEVICE install -r experiments/spa-native-host/hosts/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s DEVICE shell am instrument -w dev.spahost.prototype.test/dev.spahost.prototype.HostInstrumentation
```

`build.sh` uses the generated Gradle 8.14.3 wrapper with the distribution's
published SHA-256 pinned; `SPA_GRADLE` can select another explicit compatible
executable. Set `ANDROID_HOME` if needed. Native
projects target API 35, support API 26+, and feature-detect WebView document-start
scripts and origin-aware messaging. Missing support fails closed.

The private HTTPS-style `https://appassets.androidplatform.net` origin serves
packaged assets with a native request handler. Unknown paths return local 404;
they never fall back to the internet. Path traversal and filesystem access are
rejected. HTTPS API/image requests outside the asset origin use ordinary browser
networking and CORS; they do not receive bridge grants. Only actual main-frame, exact-origin WebMessageListener messages are
accepted. JavaScriptReplyProxy binds replies to the originating browser frame.
The transport and bundled framework-neutral SDK are installed before document
application scripts. `/injected.html` has no SDK script tag and exercises this
injection contract independently of Next.

The host implements native toolbar controls, Back coordination, a native demo
dialog, vibrator impacts, asynchronous SQLite storage, and Android Activity
Result still capture. Camera delegates to an installed camera application, which
owns its camera permissions; it does not claim this app has a continuous camera
session. Capture returns only validated JPEG handles. Photos remain private,
are previewed through a scoped native path, and survive relaunch until removed.
Abandoned temporary capture files are removed on startup. A destroyed document
cannot receive an old capture result. After activity recreation/process death,
an old capture promise is abandoned and output is not silently resurrected.

Debug development mode allows one explicit loopback server origin:

```sh
adb -s DEVICE reverse tcp:18796 tcp:18796
adb -s DEVICE shell am start -S -n dev.spahost.prototype/.HostActivity --es spa.dev.url http://127.0.0.1:18796
```

The root web command must serve Next on that port. Only Debug reads the extra;
Release does not accept development URLs, permit cleartext HTTP, or enable
WebView inspection. Remove only the owned reverse when finished. The baseline runner uses packaged content. The separate extension suite can
exercise the production Next server through the explicitly configured Debug
loopback origin.

Instrumentation controls the actual WebView using Android's native test APIs;
there is no public web evaluation method. Browser/SDK and real service assertions
are separate from physical camera capture and perceived haptic sensation.
See the parent evidence ledger for actually executed cases and remaining gates.

The device verification runner includes a targeted force-stop and a second
instrumentation process to verify a unique, acknowledged storage checkpoint:

```sh
python3 experiments/spa-native-host/hosts/android/verify-device.py --serial DEVICE --install
```

Reports retain APK hashes, exact assertions, process IDs and failures under
`evidence/`. Each Debug/Release assembly verifies all staged manifest hashes
against the actual APK, including Next's underscore-prefixed runtime directories.


## Hosted content and native shell

The bundled `host-config.json` is native-owned. Defaults remain packaged content,
web navigation and standard chrome. Debug launch overrides permit an explicit
loopback origin; Release accepts only the configured HTTPS origin.

```sh
adb -s DEVICE reverse tcp:18797 tcp:18797
adb -s DEVICE shell am start -S -n dev.spahost.prototype/.HostActivity \
  --es spa.content hosted --es spa.hosted.url http://127.0.0.1:18797 \
  --es spa.navigation native --es spa.chrome tabs
adb -s DEVICE shell am instrument -w -e mode extensions -e source hosted \
  dev.spahost.prototype.test/dev.spahost.prototype.HostInstrumentation
adb -s DEVICE reverse --remove tcp:18797
```

Native visits create dedicated WebViews in bounded per-tab stacks (8 live
surfaces, depth 4 by default), including native modal sheets. Material native
bottom tabs retain each tab's document. Toolbar registrations and appearance
belong to the originating surface. Background documents cannot change foreground
UI. Popped owners lose pending replies and subscriptions. SQLite, camera and
presentation leases belong to the Activity. Hosted `/hosted/**` routes can be
added by the server without changing a native route enum; packaged routes remain
finite. Exact origin, canonical path and document/session guards apply in both
modes. Hosted failures offer native Retry and an explicit packaged fallback.

The AndroidX Back callback animates the native WebView during system predictive
Back, restores it on cancellation, and commits a native pop. The callback is
disabled at an app root so Android owns back-to-home. The physical API30 device
proves system Back; API36 emulator gesture injection separately exercises actual
OS predictive callbacks. This does not imply physical predictive gesture testing.

## Additional native services

`share.present` uses Android's chooser and managed FileProvider JPEG handles;
`presented` reports presentation, never receiver delivery. Biometric auth uses
the platform BiometricPrompt on API28+, returning native availability and typed
unavailable/cancellation errors; no credential or authentication-success result
is synthesized. Camera/share/biometric/permission presentations share admission.

FCM registration, token refresh, foreground receive and notification-tap adapters
are implemented. Firebase options must be supplied in native configuration;
auto-init is disabled. Without configuration registration returns `UNAVAILABLE`.
No Firebase project, credential, provider delivery, or fake token is created by
this prototype. Runtime notification permission is independent of provider
configuration; denied status is retained after an actual OS denial.

`spahost://app/...` uses the same canonical native route coordinator. HTTPS App
Links are accepted only for the exact configured hosted HTTPS origin. Optional
`-PspaAppLinkHost=owned.example` creates an autoVerify manifest declaration only
when it matches that configured origin. Default builds declare no HTTPS domain.
A real owned domain, deployed `assetlinks.json`, signing-certificate association
and OS verification are separate configuration gates.

Extension instrumentation feature modes are `gestures`, `permissions`, `share`,
`biometrics`, `offline`, and `links`; use `-e mode extensions -e feature MODE`. These
control real native services/windows. Permission tests reset only this app's
notification permission on the owned test emulator. The biometric fixture proves
unavailable behavior when no biometrics are enrolled; it does not prove successful
user authentication. Exact execution receipts are retained in `evidence/`.
