# SPA host protocol v1 — implementation contract

One root WebView per host; app assets plus a plain HTML fixture are trusted.
Production iOS candidate origin `spa://app`; Android origin
`https://appassets.androidplatform.net`. Assets live at origin root, including
`/_next/`, `/compose/`, `/library/`, `/plain.html` and `/platform-sdk.js`.
Reject asset traversal, unknown paths, external subframes and privilege across
cross-origin navigation. iOS scheme/fetch compatibility is an actual gate.

## Injected bootstrap and wire format

Native document-start bootstrap installs immutable `window.__SPA_TRANSPORT__`
with `postMessage(jsonString)`, followed by the bundled framework-neutral
packages/platform-sdk/bridge.js installing `window.platform`. Both install before
app code, including pages without any SDK script tag. Next's public SDK script
is an idempotent fallback for browser previews, not required in the native host.
Android transport wraps the origin-restricted `__spaNative` listener;
iOS wraps `window.webkit.messageHandlers.spa`. Never use addJavascriptInterface.

SDK owns `window.__spaReceive(message)` for native replies/events; native uses a
JSON encoder to pass an object, never string interpolation of untrusted JS.
The SDK starts ready() lazily via a hello; calls before ready await it.

Request:
`{v:1,id:"unique-string",document:"client-random-document-nonce",session:null|"host-session",action:"hello"|"storage.get"|...,args:{...}}`.
Hello has session null, args {}. After native verifies actual top-frame source,
it establishes session for this document, returns capability list and platform.
Other requests require that exact session and document. JSON IDs are not source
authentication: native origin/main-frame verification is mandatory on every
message, and native full-document navigation invalidates the session/pending
callbacks. Same-document history transitions preserve session. Duplicate hello
from an established session must not rotate it; reject conflicting nonce.

Response: `{v:1,id,document,session,ok:true,result:<JSON>}` or
`{v:1,id,document,session,ok:false,error:{code,message}}`.
Hello result: `{platform:"ios"|"android",capabilities:[action names]}`.
SDK rejects replies from other document/session identities. Hello reply supplies
the first nonempty host session. Register the SDK receiver before sending hello.
Events: `{v:1,document,session,event:"toolbar.action"|"navigation.back",data:{...}}`.
Every async completion captures session/document at admission; do not reply or
mutate a replacement document. Native full navigation clears toolbar and session.

## Actions

The three storage actions belong to the optional `@nativehost/storage` package.
The default prototype selects it alongside auth. Removing its declaration
removes the `platform.storage` facade and native capabilities; raw calls then
fail `UNSUPPORTED`. Storage keeps the existing private SQLite paths, string/null
results and quotas. Its removal does not remove auth or native analytics.

- hello: {}.
- haptics.impact: {style:"light"|"medium"|"heavy"}; returns null.
- storage.get: {key}; returns string or null.
- storage.set: {key,value}; returns null after SQLite commit.
- storage.remove: {key}; returns null after commit.
- navigation.update: {path,title,canGoBack,ack?:navigation-token}; native route
  mirror, path limited to /, /compose/, /library/ with optional query. Returns null.
- navigation.back: {}; native dismisses a native modal first, else emits
  navigation.back {token} if canGoBack. Resolves after matching update ack, not
  before. Root returns null on iOS; Android native hardware root uses OS behavior.
  At most one pending back; 5 second acknowledgment deadline; never retry.
- navigation.present: {screen:"native-demo"}; returns null when presented.
- navigation.dismiss: {}; returns null after dismissal/noop.
- toolbar.set: {registration,title,actions:[{id,title}]}; <=2 actions; returns
  null. Native click emits toolbar.action {registration,id}. Route-scoped binding
  updates callbacks without leaking registrations.
- toolbar.clear: {registration}; only clears if registration still owns toolbar.
- camera.capture: {}; returns {file:"opaque-handle",mimeType:"image/jpeg"} after
  native still capture into host-owned files. One capture/presentation at a time.
- files.previewURL: {file}; returns URL string scoped to completed managed photo.
- files.remove: {file}; deletes owned photo and returns null. No arbitrary paths.
- cancel: {requestId}; returns null; removes pending delivery, suppresses late
  replies, cleans abandoned camera output. It does not undo committed storage or
  promise the external camera UI is physically terminated.

Errors: INVALID_REQUEST, UNSUPPORTED, UNAVAILABLE, UNAUTHORIZED, BUSY, CANCELLED,
TIMEOUT, QUOTA_EXCEEDED, IO_ERROR. Bound error strings; do not leak raw paths.

## Bounds and state

Wire UTF-8 <=128 KiB; request ID and nonce <=128 ASCII chars; <=64 live requests;
<=4096 seen request IDs per document, then require new document session. Track
accepted IDs and reject duplicates (no operation replay). Fields/action argument
types validated natively; reject unknown action and unexpected argument keys.
Storage key <=128 UTF-8 bytes, value <=32 KiB, total <=1 MiB, namespace fixed by
host (not a page argument). SQLite serial worker, durable transactions, errors
reported; cancelled writes may still commit.
Independent disk work is capped at 64 across cancellation and document changes;
capacity is released only when actual work completes, not when delivery cancels.
JS SDK timeout is 15 seconds ordinary, 120 seconds camera. Timeout sends
cancellation, settles once. Camera files <=
20 MiB each, completed total <=100 MiB; preserve completed across relaunch;
clean temporary output on abandoned capture/startup. Random opaque names, no
filesystem traversal. Persist route checkpoint after acknowledged update.

## SDK public interface

`platform.ready()` returns hello result; `platform.call(action,args,{signal,
timeoutMs}?)` is the shared typed/error-aware gateway. Nested helpers mirror
action names: navigation, haptics, storage, camera, files. `platform.on(event,fn)`
returns disposer. `platform.toolbar.set/clear` expose raw lifecycle registration;
React wrapper owns component registration/cleanup. `platform.dispose()` rejects
pending requests and unregisters SDK lifecycle listeners. Browser without native
transport reports UNAVAILABLE; fake transport is installed only by tests.

React navigation adapter owns a document-session route ledger, observes committed
Next pathname/query, handles native back events through router.back(), sends
matching ack after commit, and keeps one source of web history. Native app has
no second SPA stack. Normal Next Links feed this observer. Direct loaded route
has no synthetic predecessor. Native toolbar Back, web Back, hardware Back use
same native coordinator (IME handled first). Root restoration loads checkpoint
as direct entry; old browser history is not reconstructed.

## Delivery/artifacts

Web worker owns apps/web, packages/platform-sdk, packages/platform-react,
fixtures/plain-html and SDK/browser contract tests. iOS worker owns hosts/ios.
Android worker owns hosts/android. Parent owns protocol, dependencies, tooling,
integration evidence, README. No cross-owner changes without coordination.

`tooling/sync.mjs` (parent) stages Next `apps/web/out/` into `build/web/`, copies
SDK bridge.js to `/platform-sdk.js` plus ordinary fixture as `/plain.html`, then
writes sha256 asset manifest. Native workers consume `build/web/` and stage it
into their app resources. Debug assertions/test hooks must not enable arbitrary
eval from web documents. Next uses beforeInteractive SDK script; host bootstrap
transport installed at document-start. Browser test mocks are explicitly labeled.

The user approved the runtime dependencies in DEPENDENCIES.md on 2026-11-05.
Initial bundle IDs:
`dev.spahost.prototype` iOS and `dev.spahost.prototype` Android; simulator signing
disabled. Physical iOS uses the explicitly authorized Jesse Tomchak individual
team and existing certificate. The user approved this app's provisioning on
2026-11-05. Do not reuse the previous native-host application ID or provision
another team, certificate, or app identifier without authorization.
