# External Android observer

This test-only app uses Android Instrumentation/UiAutomation to inspect OS
accessibility nodes and inject real touch/key events. It has no dependency on
React Native, Hermes, the candidate runtime or either app's test endpoint. Its
separate `dev.nativehost.observer` process can remain running while either target
app is stopped/restarted. The authenticated server exists only in its test APK.

Build with Gradle 8.13, AGP 8.13.1, JDK17 and SDK35:

```sh
gradle :app:assembleDebug :app:assembleDebugAndroidTest
```

After device coordination, install both generated APKs in this directory's
`app/build/outputs/apk/`. Generate a fresh random token of at least 32 alphanumeric
characters, and store `{ "port": 18792, "token": "..." }` in a private ignored
file. Start with `python3 ../start-observer.py /absolute/private/config.json
--serial 805KPFX1843819`. The launcher forwards only that port, prints no token,
and removes the forward after the observer exits. The client closes via
`session.close`. No target installation, process restart or data clearing is
performed by this launcher.

The protocol is NDJSON `{id,method,params}` with `{id,result}` or
`{id,error:{code,message}}` responses. First call
`session.authenticate {token}`. Supported methods:

- `session.describe`: observer/OS mechanism, clock and polling metadata.
- `session.close`: stop this instrumentation server.
- `ui.snapshot {package}`: flat actual accessibility nodes, bounded to 10,000.
- `ui.find {package,selector}`: current visible matching node, or `{exists:false}`.
- `ui.waitFor {package,selector,timeoutMs}`: poll actual accessibility every 20ms,
  returning the first exact visible match (default timeout 15s, maximum 60s).
- `ui.text {package,selector}`: actual `{text,label}` from OS accessibility.
- `ui.tap {package,selector}`: fresh lookup, enabled/visible bounds check, system
  coordinate down/up; it does not call a component handler or accessibility click.
- `ui.type {package,selector,text,clear:true}`: tap, system Ctrl+A/Delete, system
  character key events. Unsupported keyboard characters are reported explicitly.
- `ui.scroll {package,selector,direction:"down"|"up",durationMs:300}`: actual
  system swipe within target bounds.
- `ui.dismissKeyboard {package}`: system Back only while an IME window is present.

Only `dev.nativehost.reference` and `dev.nativehost.experiment` are accepted target
packages. `selector` supports exact `text`, `label` (content-description),
`resourceID`, and `testID`; supplied fields combine with AND. `testID` matches an
observed resource ID or exact content-description, since the two prototypes
expose these differently. No private app tags or semantic tree are consulted.
For portable actions prefer explicit labels such as `Update`, `Reorder`, and
`Performance input`; readiness uses the exact `Revision: ...` text/label.

A node result includes `exists`, `text`, `label`, `resourceID`, `className`,
`package`, `visible`, `enabled`, `clickable`, `scrollable`, input `focused`,
`selectionStart`, `selectionEnd` (the OS returns -1 when unavailable), and physical-pixel
`bounds:{x,y,width,height}`. Wait/find/snapshot also report device monotonic time;
`ui.waitFor` adds `waitDurationNanos`. Android elapsed realtime must not be
subtracted from host-machine timestamps. Accessibility visibility is an OS
observation, not proof that a frame has reached the display or a performance
measurement without an agreed sampling/timing protocol.

Every fetched node is refreshed through the OS connection before matching or
serializing, rather than relying on cached accessibility text. Traversing and
refreshing nodes adds observer overhead; an observed wait is not isolated app
render time. Physical functional preflight verified input, scrolling and
visibility for both target apps and the same observer process/TCP session
surviving their force-stop/relaunch. No performance comparison has been derived
from that preflight.
