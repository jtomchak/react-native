# @nativehost/plugin-api

Shared native SPI for trusted installed plug-ins. The Swift package lives at
`ios/NativeHostPluginAPI`, and the Android library at `android`.

NativePlugin exposes owned actions/events, invocation, cancellation and applicable
platform lifecycle hooks. PluginAction declares foreground/stale/fresh-context
policy. PluginEnvironment and PluginCallContext inject process services and the
calling scene/activity, document owner and public configuration. PluginFailure
carries bounded typed failures to the host.

Results are JSON-compatible values, including scalar strings and null, rather
than being restricted to object envelopes. The Swift environment supplies the
native application data root for persistent plug-ins; Android provides the
application context. Neither is chosen by a page request.

The host owns native presentation, lifecycle dispatch, transport identities,
capabilities, session epochs and document-retirement barriers. Native plug-ins
are trusted application code; this SPI is not a sandbox for untrusted SDKs.
Version 0.1.0 corresponds to hostApiVersion 1 and is an exact peer of auth and
storage. These packages are unpublished prototype APIs and must be built
together; the scalar-result expansion is not an ABI promise to older binaries.
