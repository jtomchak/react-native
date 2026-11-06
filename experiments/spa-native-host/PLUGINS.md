# Single-package native plug-ins

Auth is the first plug-in and native storage is the second. One npm package owns
its JavaScript facade, optional React/server adapters, Swift package and Android
library. The application selects and configures packages once in
`configuration/plugins.json`:

```json
{
  "schemaVersion": 1,
  "plugins": [{
    "package": "@nativehost/auth",
    "configuration": {
      "enabled": false,
      "origin": null,
      "providers": [],
      "rpId": null
    }
  }, {
    "package": "@nativehost/storage",
    "configuration": {}
  }]
}
```

`enabled:false` means installed but unconfigured. An empty `plugins` array means
removed: no SDK namespace/events, server registration, native factory, callback
contribution, or auth native dependency. Source `host-config.json` stores only
core settings; its `plugins:{}` is populated in the generated asset from this
single declaration. Private auth server configuration remains separate.

Removing only the storage entry retains auth and core analytics. It removes the
storage SDK namespace, capabilities, native library and tests. Stored values are
preserved for reinstallation. The storage package uses the existing system
SQLite database and adds no third-party runtime dependency. Its methods still
return strings or null through the same `platform.storage` API; see
[the storage package](packages/storage/README.md).

## Build workflow

Run from this directory:

```sh
npm ci --ignore-scripts
npm run plugins:sync
npm run plugins:check
npm run export
npm run hosted:build
npm run build:ios
npm run build:android
```

Export/hosted/native build entrypoints generate registrations automatically.
`plugins:check` checks generated content without changing it. SDK assembly is a
build step; pages cannot install or replace registry entries at runtime.

Generated, ignored `build/plugins/` contains:

- SwiftPM/XcodeGen inputs plus static Swift factories.
- Gradle project/dependency inputs plus static Kotlin factories.
- Conditional native integration-test registration.
- The selected server imports and a version/manifest-digest receipt.

SwiftPM and Gradle resolve and build native dependencies. The generator is not a
replacement dependency resolver. No CocoaPods support or fallback exists.
Auth's Credentials/Browser Maven libraries live in auth's Gradle module, and its
approved OIDC/WebAuthn npm dependencies live in auth's package.

## Package layout and exports

```text
packages/auth/
  package.json
  native-plugin.json
  configuration.mjs
  configuration.schema.json
  client/index.mjs
  react/index.jsx
  server/
  ios/NativeHostAuth/Package.swift
  ios/NativeHostAuth/Sources/
  ios/IntegrationTests/
  android/build.gradle.kts
  android/src/
  android/integrationTest/
```

Public exports are `@nativehost/auth/client`, `/react`, `/server`, `/configuration`
and `/manifest`. Client code never imports server modules. React is an optional
peer; the framework-independent facade still works with ordinary HTML.
`useAuth(platformState)` accepts the generic host context instead of importing a
particular application or Next.js router. Server exports require Node24+ and
retain the existing single-host SQLite prototype boundary.

`@nativehost/storage` exposes `/client`, `/configuration` and `/manifest`. Its
manifest omits the optional `react` and `server` fields, so it introduces neither
a React dependency nor a server storage route. When declared, framework/server
exports must resolve inside the package. The generator registers only selected
packages with a declared server adapter.

`@nativehost/plugin-api` is the host's shared native SPI. The app depends on it;
auth declares its exact matching peer. This first version supports flat npm or
Yarn Classic package layouts, with API and plug-in adjacent under the same scope.
Other layouts fail explicitly. No npm packages have been published by this work;
this checkout uses local file dependencies, and tarballs can be installed into a
host that already includes the API package.

SwiftPM derives local identities from directory names. Each iOS package root,
module and product must use its unique product name, for example
`ios/NativeHostAuth` and `ios/NativeHostPluginAPI`. Native libraries cannot import
prototype host classes. Factories receive typed host services and per-call
presentation/document context. The host retains navigation, presentation leases,
session epochs, JavaScript-realm retirement and stale-context admission.
The Swift environment supplies the native application data root; Android
supplies application context. Native invocation results can be JSON-compatible
objects, arrays, scalars or null, preserving storage's string/null contract.

## Adding another plug-in

Create a runtime package with the same public exports and a version1 manifest.
Declare owned namespaced actions/events, timeout policy, Swift product/factory,
and Android project/fully-qualified factory. Implement both native SPI adapters,
then add the package as a direct runtime dependency and select it in the one
declaration. The generator rejects unknown schema fields, reserved/colliding
names, incompatible API peers, escaped/symlinked package paths and ambiguous
Swift package identities. Native startup checks manifest/runtime agreement.

API v1 reserves core wire capacity: action/event identifiers are at most 64 ASCII
bytes, with at most 24 selected plug-in actions and 24 events. Browser client factories
must be import-free modules with one named factory export. SDK assembly preserves
cancellation, capability negotiation, document ownership and frozen namespaces.

## Testing installation and removal

```sh
npm test
npm run test:browser
npm run test:auth
npm run plugins:pack-test
```

The pack test discovers selected packages from the declaration, creates
allowlisted tarballs, installs them offline into a temporary
consumer outside the source checkout, executes client/server exports, checks the
declared React/manifest exports, resolves native paths and evaluates each
SwiftPM manifest. Storage's native-only package is exercised alongside auth.
It publishes nothing.

For a removal matrix, create a temporary JSON declaration with an empty array and
set `SPA_PLUGIN_DECLARATION_FILE` to its absolute path for every export/build/test
command. This changes ignored generated outputs only. Restore normal output by
running the ordinary commands without that override. Do not run installed and
removed native build jobs against the same generated output concurrently.

Removing selection does not uninstall npm packages or rewrite application UI.
The sample auth UI can show unavailable without native auth installed. Before
uninstalling the npm package, remove application imports of its React/server
exports as appropriate; unresolved imports fail the build clearly.

Current results: [PLUGIN-VERIFICATION.md](evidence/PLUGIN-VERIFICATION.md).
Second-package results: [STORAGE-PLUGIN-VERIFICATION.md](evidence/STORAGE-PLUGIN-VERIFICATION.md).
Authentication behavior/configuration: [AUTH.md](AUTH.md).
