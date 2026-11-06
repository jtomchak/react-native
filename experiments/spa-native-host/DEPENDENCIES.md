# Isolated prototype dependencies

Status: runtime dependencies approved by the user on 2026-11-05 for this isolated
prototype. No root React Native dependency changes.

| Package | Exact version | Purpose |
| --- | --- | --- |
| next | 16.4.5 | Static-export SPA and development compiler/server |
| react | 19.3.1 | React UI, compatible with Next's published peer range |
| react-dom | 19.3.1 | Browser renderer |
| androidx.webkit:webkit | 1.12.1 | Origin-aware browser messaging, early injection, local assets |
| androidx.activity:activity | 1.10.1 | Activity Result camera capture and back handling |
| Kotlin standard library | 2.1.21 | Kotlin Android host runtime |

Development tools: Android Gradle Plugin 8.13.1, Kotlin Gradle Plugin 2.1.21,
Playwright Test 1.65.0. The first application uses JavaScript/JSX and needs no
TypeScript compiler. Xcode/Swift/UIKit/WebKit and system SQLite
provide iOS integration without third-party runtime packages.

Initial targets: iOS 16+, Android API 26+ with compile/target API 35. WebView
early-script/message support is feature-detected, failing closed when absent.
No Capacitor, Tauri, Hermes, Yoga, or React Native runtime dependency.

## Hosted content, native chrome and native interactions — proposed additions

Status: additions below explicitly approved by the user on 2026-11-05. The user
chose push adapters now and provider/delivery configuration later.

| Package | Exact version | Purpose |
| --- | --- | --- |
| com.google.android.material:material | 1.13.0 | Actual Android BottomNavigationView/native chrome with platform accessibility and selected state |
| com.google.firebase:firebase-messaging | 26.0.1 | Android FCM registration, token refresh and notification delivery callbacks |

Both versions were verified against Google's published Maven metadata/POMs.
FCM 26.0.1 uses the already approved Kotlin standard library 2.1.21. No Analytics
module or iOS Firebase SDK is selected. iOS notifications, sharing and biometrics
use system frameworks; Android sharing and API28+ biometrics use platform APIs.
Firebase project configuration is a separate explicit input; no production
Firebase project, provider credential, or sender secret is inferred or embedded
in browser assets. No server deployment or cloud project creation is implied.

## Embedded analytics

Uses platform SQLite, Foundation/URLSession and Android platform networking;
the collector and adapter mappings use Node built-ins. No additional runtime
dependencies were added. Firebase Messaging remains distinct from Firebase
Analytics. Third-party delivery defaults to collector adapters; no analytics
vendor SDK or provider credentials are installed by this prototype.

## Native authentication — approved

Isolated additions approved by the user for OAuth/OIDC verification, WebAuthn verification,
and Android's native credential/browser interfaces. No CocoaPods or Apple
third-party runtime is required; iOS uses AuthenticationServices and Keychain.

| Package | Exact version | Purpose |
| --- | --- | --- |
| openid-client | 6.8.9 | Server-side standards-based OAuth/OIDC discovery, PKCE and ID-token validation |
| @simplewebauthn/server | 14.0.3 | Server-side passkey challenge generation and credential verification |
| androidx.credentials:credentials | 1.5.0 | Native Android passkey prompts |
| androidx.credentials:credentials-play-services-auth | 1.5.0 | Credential Manager provider integration on supported older Android devices |
| androidx.browser:browser | 1.8.0 | Android Custom Tabs for external OAuth authorization |

Provider credentials, production origins and website associations are separate
configuration inputs. Local verification uses an isolated test identity provider;
it must not enable a development identity provider in production.

## Single-package plug-in extraction — 2026-11-06

Auth is now the first-party `@nativehost/auth` package, with the shared first-party
`@nativehost/plugin-api` peer (both version0.1.0). These replace direct source
coupling; no additional third-party runtime dependencies were added. Auth owns the
same previously approved OIDC/WebAuthn npm dependencies and Android Credentials/
Browser Maven dependencies. The application uses local file dependencies and
selects native integrations through `configuration/plugins.json`. SwiftPM builds
the iOS library; Gradle builds the Android library. Nothing was published to npm.
