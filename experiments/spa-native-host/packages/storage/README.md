# @nativehost/storage

The second single-package native plug-in. Its JavaScript facade, SwiftPM library,
Gradle library and conditional integration tests ship in this one package. It
depends only on the matching first-party `@nativehost/plugin-api` peer and system
SQLite. There is no React or server adapter because these operations run on the
device.

Install the package in a host that supports the plug-in API, then select it once:

```json
{"package": "@nativehost/storage", "configuration": {}}
```

The generated SDK preserves the existing API:

```js
await platform.storage.set('draft', 'hello'); // null after native commit
await platform.storage.get('draft');          // 'hello', or null when absent
await platform.storage.remove('draft');       // null
```

Every method accepts the existing final options argument with `signal` and
`timeoutMs`. Removing the selection removes the SDK namespace, native factory,
capabilities and integration-test registration. Direct calls to absent native
storage actions fail with `UNSUPPORTED`; removal never deletes stored data.

The extracted implementation uses the existing private database and table:
`root/storage.sqlite` on iOS and `getDatabasePath("platform.sqlite")` on Android,
with `kv(key,value)`. Existing data stays readable after the upgrade. The native
host supplies the application data location; web content cannot select a file
path. Storage is application-wide, shared by trusted packaged and configured
hosted documents. Authentication credentials and the analytics journal use
separate native stores. This string store does not provide encrypted secret
storage or automatic per-user partitioning.

Keys are nonempty strings up to 128 UTF-8 bytes. Values are strings up to 32,768
UTF-8 bytes, including empty strings. Embedded NUL and Unicode round-trip
unchanged. Unknown arguments and wrong types fail before accepted disk work.
The logical key/value payload quota is 1 MiB; writes roll back on quota failure.
The queue admits at most 64 operations, independently of live JavaScript
promises. Cancellation stops delivery but cannot undo a write already accepted
by SQLite. No new storage feature or data migration is introduced by extraction.

Native roots are `ios/NativeHostStorage` and `android`. Framework adapters are
optional in the manifest; importing this package never creates a server storage
endpoint. See [PLUGINS.md](../../PLUGINS.md) for installation and removal testing.
