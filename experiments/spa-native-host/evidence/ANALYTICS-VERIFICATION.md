# Native semantic analytics verification — 2026-11-05

This extension adds a native-owned local event journal, semantic web capture,
versioned export selectors, a development collector and provider adapter hooks.
The user confirmed semantic events only and collector adapters by default.
No vendor SDKs, credentials or external vendor requests were added.

[Operation and API guide](../ANALYTICS.md) · [wire/schema contract](../protocol/ANALYTICS.md).

## Final checks

| Check | Result | Receipt |
| --- | --- | --- |
| Node SDK/core/policy/tooling | 57 tests passed | [node log](analytics/node-tests.log) |
| Browser | 12 passed; 4 hosted cases intentionally skipped in packaged configuration | [browser results](browser-results.json) |
| Production hosted Next | 4 passed separately | [hosted log](analytics/hosted-browser-tests.log) |
| iOS 27.2 native suite | 31 passed, zero failures/skips; two live HTTP phase cases run separately | [iOS report](../hosts/ios/build/evidence/analytics/report.json) |
| iOS SDK 27.2 builds | Debug simulator, Release simulator and unsigned Release device compiled; 40 staged assets match | iOS report and build logs |
| Android native suite | 53 analytics assertions, plus baseline47 and process-restart6 passed on the final APK | [Android report](../hosts/android/evidence/analytics-final/report.json) |
| Android builds | Debug/test/unsigned Release and lintRelease passed; 40 assets match; installed app/test hashes match built artifacts | Android report |

Browser service cases use the explicit mock transport. Native suites exercise
real native SQLite/bridge ownership, disk admission, retention, privacy and
selection; the HTTP phases additionally use actual platform networking and the
real production Next collector. These categories are separate evidence.

The SDK's telemetry lane test sends **4,100** observations before a normal storage
request still succeeds using ordinary request capacity. Native tests cover the
same separation, plus origin/session rejection and inactive surface rejection.

## Real server flag change and retained-history upload

Two semantic events are created per platform: `custom.analytics_keep` and
`custom.analytics_later`. The first policy selects only the first event. After
process restart, the next policy selects the previously excluded second event:
iOS uses revisions1→2; final Android uses revisions3→4. The native app is not
rebuilt between its phases. Stable event IDs and original timestamps remain.

| Platform | Initially selected event | Initially excluded, later selected event |
| --- | --- | --- |
| iOS final pair, revision1→2 | `29b4b5c8-22c4-43c6-b0f0-cde3408027de` | `57b64c38-a203-4b5a-acd3-fb9ff428286e` |
| Android final pair, revision3→4 | `3f6c3a1c-f79f-4efd-944f-86301968d3cc` | `c671341f-adcc-44db-b1f7-f4d8b579ea04` |

The iOS pair uses PID **55890→57657**, ACK count **1→2**, and retained count2.
The newly eligible event is ACKed once; the first event is not resent. iOS native
readback preserves IDs, installation/session IDs and times across the restart.

The final Android pair uses PID **28119→28344**, with 6 record-phase and 4 replay-
phase assertions on the same final APK. Foreground automatic flush uploaded the
second before the manual probe, so that manual flush reports accepted0 while
the native receipt count advances3→4. The earlier two receipts belong to an
initial revision1→2 pair; both final UUIDs are independently present in the
collector. No custom event is recreated during replay. The final APK includes
the atomic origin-rebind correction and actual SQLite-abort rollback regression.

[Policy revision1](analytics/policy-v1.json), [revision2](analytics/policy-v2.json),
[revision3](analytics/policy-v3.json), [revision4](analytics/policy-v4.json),
[collector receipts](analytics/collector-receipts.json), native reports above.
The collector also retains one earlier iOS pre-review fixture event
`63e5a354-844d-4f18-9863-7aaeed565355`; it is historical and not part of the final
pair. The earlier Android pair uses `47855fe1-c610-4d1e-8738-d1df3f55d513` and
`f2d5e951-1f9e-4d1d-8b0f-d66501ef9134`. These historical records have distinct
event identities, rather than being duplicate resends of the final pairs.

## Important implementation verification

- Native envelope fields and semantic properties are validated before journal
  admission. Actual storage values/keys and rejected private properties are not
  present in the native journal. Browser tests type a private draft and prove
  that its text does not enter analytics observations.
- A separate SQLite WAL database avoids consuming user KV quota. Native event
  count, serialized payload bytes, TTL and all queued journal work are bounded.
  Cancelled web requests do not free disk-work quota before the work finishes.
- Event/destination ACKs are retained independently from event retention. Tests
  cover partial/unknown ACKs, retries, restart, retained excluded events, expired
  policies and deterministic sampling.
- Persisted policies are bound to the native-approved collector origin.
  Android also checks configuration generation across asynchronous GET/POST.
  Origin rebinding must reset its cache/floor atomically to survive interruption.
  The Android regression aborts the second metadata write with a real SQLite
  trigger, proves all binding fields roll back, and checks recovery/floor behavior.
- Native operation completion capture is independent of a live reply owner.
  A real storage write completing after document retirement produces one safe
  outcome event, while stale replies and duplicate callbacks remain suppressed.
- Navigation dedup uses internal surface/transition identity; distinct hosted
  screens are counted while their exported screen name stays redacted.
- The recording collector fsyncs immutable event records and directory publication
  before ACK. Stable IDs deduplicate after collector recreation. A hard child
  process exit leaves staging data; it is counted against quotas on restart.
- Operator policy updates use writer exclusion, validation, increasing revision
  and atomic publication. Concurrent writers cannot publish inconsistent selectors
  under one revision.

## Artifact identity

The iOS report hashes native sources, test logs and **linked implementation code**.
Xcode Debug uses a launcher plus `SPAHost.debug.dylib`; the launcher's hash alone
is insufficient to identify the implementation. Both are included. The final
live pair has no SwiftCompile/Ld steps or source edits between phases.

The staged 40-asset manifest SHA-256 is
`9638216427db2324098499533b93b065cc144d0a33ec2c48346ad96736648708`.
SDK SHA-256 is
`0dd41f4bf5951166d72aa73fa5bedd58f106c003e5c9fc4dba154b22d0bb79d2`.
Both native reports bind their resources to those staged values. Release excludes
Debug analytics-origin overrides; iOS Release also excludes Debug ATS exceptions.
Android Release is built/linted, not executed. Unsigned iOS device compilation is
separate from simulator execution.

[Integration receipt](analytics/integration.json) independently verifies current
native source/linked artifact hashes, the server graph, and one collector record
for each of the four final event IDs. It also records server/forward cleanup.

## Limits and retained failures

The included collector is a loopback development harness, not a deployed public
authentication/control-plane service. Provider mappings and the adapter registry
are tested without actual vendor ingestion. Firebase Analytics app identity is
not fabricated from the engine's UUID. No external vendor delivery is claimed.

Capture is bounded semantic eventing, without raw form values or session replay.
The byte budget covers serialized event payloads; SQLite/index/receipt/WAL
storage adds overhead. Retention/eviction limits retrospective selection.
Guaranteed OS background transfer and performance/battery advantages are not
established by these functional tests.

Initial Android journal initialization failed because a row-returning PRAGMA
used execSQL; the targeted rawQuery correction passed subsequent native tests.
A dozing/locked Pixel rejected foreground web calls as designed. Tests continued
once the device was unlocked; no secure keyguard bypass was attempted. The iOS
hidden-window regression prompted a visibility-guard fix. Initial logs remain.
Existing iOS test teardown can unlink temporary test databases while UIKit still
retains owners; those warnings are retained, not presented as production journal
integrity failures or silently attributed to another cause.

No physical iOS analytics run, every-device layout rerun, or vendor ingestion is
claimed by this extension. Earlier geometry acceptance is recorded separately.
Independent source reviews verified the origin/generation/admission/completion/
navigation fixes and the final atomic-rebind transaction.

The temporary collector server is stopped after verification. Pixel is restored
to packaged native tabs with local-only analytics. Owned reverse18797 is removed;
pre-existing18791 is preserved. No commits or pushes were made.
