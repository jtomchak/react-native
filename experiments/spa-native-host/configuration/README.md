# Native host configuration

`host-config.json` is native build input. `npm run export` / `npm run sync`
validate it and package it with the app. It is never downloaded from the hosted
page, and no bridge method grants a new origin.

Select and configure native plug-ins in `plugins.json`. Auth is the first
single-package plug-in; its public settings are generated into the bundled
host configuration. See [PLUGINS.md](../PLUGINS.md) for SwiftPM, Gradle and
installation/removal checks. Private server credentials stay outside both files.

The default remains packaged content, web history and standard native toolbar.
To select an owned production HTTPS server and native chrome for a build:

```sh
npm run configure:host -- --origin https://YOUR_OWNED_HOST --content hosted --navigation native --chrome adaptive
npm run export
npm run build:ios
npm run build:android
```

Replace the example host. `configure:host` rejects insecure origins, credentials,
paths, query and fragments. The configured server must actually be deployed by
the operator; these commands build native clients, not cloud infrastructure.
Selecting packaged again preserves the configured HTTPS origin for a later
native source selection without granting arbitrary external origins:

```sh
npm run configure:host -- --content packaged --navigation web --chrome standard
```

For local integration tests, Debug hosts accept explicit loopback HTTP launch
configuration. Release uses the bundled HTTPS source policy. See host READMEs.
Production Next builds and packaged exports use separate application/build roots.

## Native integrations

The initial four additions are notifications, deep links, native sharing and
biometrics. Camera, haptics and SQLite storage remain available through the same
bridge. `notifications.enabled` defaults to false and Firebase configuration to
null because the user deferred provider setup. Registration must fail explicitly
when unavailable; local/simulator notifications do not prove remote delivery.

Android FCM needs only client FirebaseOptions here: `projectId`, `applicationId`,
`apiKey`, `senderId`. Never place a service-account JSON file, private key or
provider sender credential in this file. iOS APNs additionally needs the correct
app capability/entitlement/profile. Provider sending credentials stay server-side
and are not created by this prototype.

When configuring actual delivery, test foreground/background/cold notification
taps and token rotation. iOS currently deduplicates the identifiers delivered by
each native ingress, but cross-ingress correlation is not proven: legacy launch
payload handling, UIApplication delivery and UN response callbacks use different
fallback IDs. Decide one canonical bounded provider message ID (or one modern
opened-route ingress) and validate it with real APNs delivery before accepting
cross-callback exactly-once routing. Do not use whole-payload hashing, which can
collapse separate identical notifications.

## HTTPS deep links

The `.example.json` files are deployment templates, not active verified domains.
Use the actual signing identity/fingerprint and an owned HTTPS host, deploy
`apple-app-site-association` and `assetlinks.json` under its `/.well-known/`, and
configure native associated-domain/app-link declarations for that host. Verify
OS association on real devices. Custom `spahost://app/...` tests alone cannot
prove Universal Links or Android App Links.
# Analytics configuration

`analytics` is an optional native-owned configuration block. Its staged defaults
enable local semantic capture with `origin:null`, destination `recording`,
10,000 retained events, an 8 MiB serialized-payload budget and seven-day TTL.
With a null origin there is no analytics network transport. User KV quota is
independent.

`npm run configure:host -- --analytics-origin https://YOUR_COLLECTOR` selects an
exact HTTPS origin in the native bundle; `--analytics-origin none` returns to
local-only recording. Re-export/sync and rebuild after native configuration
changes. Debug alone supports an explicit loopback origin override. Server
policy revisions can change export filters without rebuilding; they cannot
change capture fields, endpoint grants or resource ceilings. See
[ANALYTICS.md](../ANALYTICS.md) for the policy operator and adapter boundary.

