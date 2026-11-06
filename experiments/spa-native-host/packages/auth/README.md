# @nativehost/auth

Single-package OAuth/OIDC and passkey plug-in for the native host prototype.
Contains an import-free browser installer, optional React hook, server adapter,
iOS Swift package and Android Gradle library. Depends on the shared exact-version
`@nativehost/plugin-api` peer. No CocoaPods integration.

Select this package in the host's `configuration/plugins.json` and run
`plugins:sync`, export, and the native builds. Public configuration contains only
enablement, the exact service origin, approved provider IDs and RP domain. Never
put server secrets in that declaration. The private server config is supplied
through `SPA_AUTH_CONFIG_FILE`.

Exports:

- `/client`: `installAuth(hostClient)`; the generator installs `platform.auth`.
- `/react`: `useAuth(platformState)`; accepts the host context and owns session
  read coalescing, cancellation, sign-in/cookie-sync ordering and rollback.
- `/server`: authentication service, persistence, verification and HTTP adapter.
- `/configuration`: public client configuration validator.
- `/manifest`: native/build registrations.

The server export requires Node24+; SQLite is a single-host prototype store.
Native sessions stay in Keychain or Keystore-backed encrypted storage. Hosted
Next.js uses a separate linked HttpOnly cookie. Native hosts own old-document
retirement and permission/presentation admission. Native passkey registration
requires an authenticated account and configured website associations.

The existing wire protocol is documented in CONTRACT.md. OAuth uses an external
system authentication browser; no OAuth secrets or refresh credentials are
exposed through the page bridge. Live provider/domain setup remains explicit.
