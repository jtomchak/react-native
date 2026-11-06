# Native semantic analytics — prototype contract

User confirmed semantic events only. This is additive to wire v1. No replay,
DOM text, input values, labels, bridge arguments/results, URLs/queries, tokens,
photo handles, or arbitrary user properties are automatically recorded.

## Native configuration and ownership

Optional native bundled `analytics` config (missing field uses these defaults):
`{enabled:true, origin:null, destinations:["recording"], maxEvents:10000,
maxBytes:8388608, retentionSeconds:604800}`. Collection is local; origin null
means no network. The independent exact HTTPS origin is native-owned. Debug-only
`--spa-analytics-origin http://127.0.0.1:18797` / Android `spa.analytics.origin`
may select explicit loopback, following existing Debug origin rules. Remote
policy cannot change origin, local collection enablement, fields or disk bounds.
Use a separate native SQLite WAL journal, outside user KV quota, an app-owned
single writer and native-generated persistent installation UUID and per-process
session UUID. No UI-thread disk/network work. Bounded pending admission (128),
count/byte/TTL eviction, dropped counters, parameterized SQL. Business actions
must succeed independently of analytics failure; manual track acks only committed
records. Pending/in-flight work must not retain Activity/WebView lifetimes.
The byte budget measures serialized event payloads; SQLite pages, indexes and
WAL files add bounded storage overhead. It is not an exact filesystem-size cap.

## Event

`{schemaVersion:1,id:UUID,installId:UUID,sessionId:UUID,timeMs:integer,
platform:"ios"|"android",source:"native"|"web",category,name,properties}`.
Native generates all envelope fields. Categories: lifecycle, navigation, bridge,
interaction, custom. Names use `[a-z][a-z0-9_.]{0,63}`. Custom names must start
`custom.`; web cannot impersonate native lifecycle/navigation/bridge events.
Max event JSON 4096 bytes. No nested properties. Allowed properties only:

- `screen`: overview/compose/library/hosted/unknown. Native maps all `/hosted/**`
  routes to hosted; never store raw paths, dynamic IDs, queries or fragments.
- `action`, `control`, `tab`, `code`: semantic ASCII tokens
  `[A-Za-z0-9_.:-]{1,64}`; no other text. `control` is explicit developer-supplied
  data-analytics-id, never DOM id/name/value/label/href/text.
- `kind`: button/link/input/select/form/other.
- `outcome`: ok/error/cancelled/unavailable.
- `durationMs`: integer0..600000; `count`: integer0..1000000000.
- `state`: started/foreground/background/selected/committed/failed/disposed.
- `presentation`: push/replace/modal/pop/web.

Native automatic events: app.started/foreground/background, navigation.screen,
navigation.tab, bridge.completed (safe action/outcome/duration only), optional
native control events using fixed semantic IDs. Record committed transitions,
not speculative/cancelled navigation. Bridge instrumentation excludes hello,
cancel, events.subscribe/unsubscribe and all analytics.* calls, to avoid loops.
Do not emit a second bridge outcome for duplicate requests or stale callbacks.

## SDK actions

- analytics.track `{name:"custom.example",properties?:{...allowed safe fields}}`.
- analytics.observe `{type:"click"|"submit"|"change",kind,control?}`. Only the
  foreground trusted main-frame document can submit web observations/track.
- analytics.status `{}`: local counts/bytes/drops, enabled/configured state,
  policy revision/expiry and delivery counts; never expose raw journal/IDs.
- analytics.flush `{}`: explicit bounded refresh+upload; no endpoint/selector args.

SDK helpers analytics.track(name,properties), status(), flush(). Framework-neutral
capture-phase DOM hooks record semantic click/submit/change, explicit safe
control IDs or only kind; ignore synthetic events, any `[data-analytics=off]`
ancestor and input types password/hidden/file. Never read text/values/labels,
DOM id/name, href, dataset properties other than analytics-id/off. Installation
is idempotent, guarded without DOM, bounded, and listeners clean up on dispose
and correctly resume BFCache. No analytics dependency or React effect loop.

Analytics RPCs use a separate monotonic request lane: ID is
`<document>-a<sequence>` where sequence is canonical decimal1..9007199254740991.
After ordinary origin/session/document authentication, native admission requires
strictly increasing telemetry sequence per document, while preserving shared
pending limits. These IDs do not consume the ordinary lifetime4096 seen-ID set.
Analytics cancellation uses that same lane and targets its analytics request.
That ID namespace is reserved: ordinary actions cannot use it. A lane cancel
must target a canonical same-document analytics ID with a smaller sequence.
Duplicate/stale telemetry IDs are rejected. Session invalidation resets native
lane state; SDK sequence may continue increasing. This prevents automatic
observations from exhausting business-action lifetime capacity.

## Remote policy

GET fixed `/api/analytics/policy/` on configured origin, bounded64KiB response,
no redirect follow to a different origin and no TLS bypass. JSON:
`{schemaVersion:1,revision:positiveInt,expiresAtMs:integer,enabled:boolean,
categories:[...],names:["*"|exactNames],properties:{safeKey:scalar},
sampleBasisPoints:0..10000,lookbackSeconds:0..604800,destinations:[nativeAllowedIds]}`.
All arrays bounded (categories<=5,names<=32,destinations<=8); properties<=8 known
keys and validated safe values. Unknown keys, invalid values or destinations,
stale revisions and expired/over24h expiry fail closed for that refresh. Persist
validated cache and revision floor. Same revision may renew expiry only if
selectors are unchanged. A still-valid cached policy may serve a network outage;
an expired policy never uploads. Invalid/mismatched same revision cannot replace
it. No downloaded code/eval/regex. Server policy can disable exporting without
turning local retention off. Filter ANDs category/name/properties/time/sample.
Sampling: unsigned FNV1a32 UTF8 event UUID, modulo10000 < sampleBasisPoints.

## Transport and retention

POST fixed `/api/analytics/batch/` on same native-owned origin:
`{schemaVersion:1,destination:ID,policyRevision:N,events:[canonicalEvents]}`.
At most100 events and256KiB per batch, single-flight bounded HTTP timeout.
Only exact requested event IDs in successful response
`{schemaVersion:1,accepted:[UUID...]}` are marked acknowledged for that destination;
partial ACK retains other records. Unknown ACK IDs/malformed/oversized responses
must not discard data. Retain journal independently of per-destination ACKs;
changing filters can select retained previously excluded events. Acknowledged
pairs are never resent merely because a policy revision changes. New destination
can receive retained events. Expired/evicted events cannot be recovered.
Failed/no ACK retries with stable event IDs and bounded backoff. No exactly-once
network claim; collector deduplicates `(destination,event.id)` durably. Policy
refresh happens on foreground, explicit flush and bounded periodic/debounced
work while active. Background lifecycle is recorded; durable OS background
transfer is not claimed. Never upload without fresh-enough native-approved policy.

## Collector and adapters

First collector is an explicitly enabled local-development endpoint, backed by
a durable file journal. Operator-controlled policy file changes revision and
selectors without rebuilding native apps. No unauthenticated public production
admin endpoint or third-party calls. Reject unconfigured production ingestion.
Adapters consume canonical events with stable IDs/time and per-destination ACK
semantics. Own collector durability ACK is distinct from vendor delivery.
Server adapter SPI + payload mappings for PostHog/Mixpanel/GA4 are tested without
real credentials/network. Native SDK adapters can implement the same boundary
when installed; Firebase app stream needs an actual Firebase SDK app-instance ID,
not our installation UUID. SDK/dependency addition requires separate approval.
