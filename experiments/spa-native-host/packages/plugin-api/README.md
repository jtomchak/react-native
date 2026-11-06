# @nativehost/plugin-api

Shared native SPI for trusted installed plug-ins. The Swift package lives at
`ios/NativeHostPluginAPI`, and the Android library at `android`.

NativePlugin exposes owned actions/events, invocation, cancellation and applicable
platform lifecycle hooks. PluginAction declares foreground/stale/fresh-context
policy. PluginEnvironment and PluginCallContext inject process services and the
calling scene/activity, document owner and public configuration. PluginFailure
carries bounded typed failures to the host.

The host owns native presentation, lifecycle dispatch, transport identities,
capabilities, session epochs and document-retirement barriers. Native plug-ins
are trusted application code; this SPI is not a sandbox for untrusted SDKs.
Version0.1.0 corresponds to hostApiVersion1 and is an exact peer of auth.
