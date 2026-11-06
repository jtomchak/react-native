# Android execution evidence — 2026-11-05

Final packaged gate: `1793914635236611000/report.json` and its two logs.
The physical Pixel 2 XL (API 30, WebView 156.0.8078.47) passed 47 assertions plus
six assertions after targeted force-stop and restart into a different process
(27955 → 28089). Reports bind both APK SHA-256 values. Cases include actual
WebView/Next routing with document nonce and session continuity; native Back
acknowledgment; native toolbar/dialog/vibrator dispatch; SQLite get/set/remove;
duplicate/invalid/wrong-type request rejection; an actual same-origin subframe
native-message attempt denied; old-document session denial; ordinary HTML; and
SDK injection before inline application code in HTML with no SDK script tag.
Embedded NUL and emoji keys/values round-trip exactly, remain distinct from a
plain prefix key, and survive process restart. The generic text validator now
allows embedded NUL only for storage keys/values; other argument restrictions
remain unchanged. Android's SQLite binding already preserves explicit lengths.

The disk-work stress fixture holds the actual serial worker from instrumentation,
admits 64 storage reads and delivery cancellations, checks rejection at capacity,
replaces the web document, checks rejection remains in force, then releases the
worker and observes capacity recovery. There is no production web test hook.

Pre-storage-validation-fix development check: `pixel-final-hmr-report.json`, with before/changed/
restored raw observations. The actual Next heading changed and reverted while
the draft, document nonce, host session/document and native PID 27200 stayed
constant. One physical native Save button tap produced exactly one native event
and one storage write of the current draft. Draft entry used browser DOM input
events, not a physical keyboard. The report binds APK `9aaa215d...e2c6181`.
The later storage-only validator change produced a new APK and passed the full
packaged gate above; HMR was not rerun after that unrelated change. Current
Debug APK is `28ee512c...fc6c03b`, recorded fully in `artifacts.json`.

`artifacts.json` records final Debug, test and unsigned Release APK hashes.
Both native assemblies and Release vital lint passed; every one of the 40 staged
web asset hashes was checked against the actual APK. `pixel-final-home.png` and
`.xml` show the final packaged home after stopping development mode. Owned USB
forwards and reverse port 18796 were removed; pre-existing reverse 18791 remains.

Failures are retained:

- `pixel-instrumentation-1793912858.log`: initial Next hydration remained at its
  fallback because Android asset packaging excluded the `_next` directory.
  Explicit packaging rules and APK hash validation fix and guard this case.
- `1793913485637618000/report.json`: Back fixture wrongly assumed a home entry
  after the host restored an earlier compose checkpoint. The suite now starts
  through an explicit canonical root deep link before asserting the transition.
- `pixel-hmr-changed.json`: first development edit did not change the actual
  heading. After React history subscriber notifications were deferred out of
  insertion/commit processing, fresh-document checks and the final-APK check
  observed the changed and restored headings. This sequence does not alone prove
  the earlier warning was the sole cause.
- `1793914083536131000/report.json`: first disk-limit fixture cancelled SDK calls
  before native admission. The corrected fixture sends valid raw protocol
  requests/cancellations using the negotiated native document/session.
- `1793914564122937000/report.json`: the valid embedded-NUL storage regression
  initially failed because the generic argument validator rejected NUL. The
  narrow storage-only allowance and exact round-trip/restart assertions now pass.

`pixel-dev-probe.json` also records a real HTTPS API fetch returning 200 and a
real native storage round trip in the earlier Debug development build.

No camera capture/permission-flow validation, perceived haptic sensation,
Release execution, controlled performance result, or complete lifecycle/security
coverage is implied. Camera is implemented but needs attended hardware
validation. Release output is unsigned. No new source changes followed the final
packaged gate. Earlier HMR changed/restored only web development source and is
bound to its historical APK, not presented as a current-APK execution.
