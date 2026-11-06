# WebView documents across native Refresh

This fixture keeps two real native WebViews mounted while actual Rolldown/React
patches run through the dedicated development API. Each browser creates its own
random document nonce. Native buttons use the normal WebView `postMessage` ref
method; document code reports its nonce, form value, JavaScript counter, scroll
position and history state through the normal `onMessage` event. The external
OS observer reads the resulting native Text nodes. Fresh request numbers prevent
an old report from passing a later probe.

The physical Pixel test verifies:

- A revision edit preserves both documents and native counter state.
- A component-body edit preserves the documents and replaces the live message
  handler, proven by a new handler tag on fresh browser responses.
- An explicit key change replaces browser A, resetting its document state while
  browser B stays intact. A subsequent Refresh preserves both current documents.
- Process/generation and the installed APK remain unchanged during patches.

The browser form/history/scroll mutations run inside the actual browser in
response to a native command. They are not claims about browser keyboard input,
DOM selector automation, cookies/storage policy, navigation cancellation, browser
process crashes or background recovery. Those acceptance gates remain separate.

From `experiments/native-host`, with the external observer already running:

```sh
node testing/refresh/webview-android.mjs --serial 805KPFX1843819 \
  --observer /absolute/private-observer.json --close-observer
```

Use `--close-observer` only when this test owns that observer session. By default
only the client socket closes. Publisher and Rust transport processes use the
shared bounded process-group owner. Source restoration is compare-and-swap;
forward/config cleanup and a fresh healthy prior-fixture receipt are required
for a passing report. No native rebuild occurs within this packet.

Latest verified run: `build/refresh-webview/1793908731175-42899/report.json`,
three actual patches and three behavior checks passed. Earlier successful evidence
at `1793908066874-27791` predates the shared publisher cleanup helper; it is kept
separately. This is Android correctness evidence, not an iOS result or timing
benchmark.

## iOS Simulator result

The simulator variant uses the same unmodified document and React fixtures:

```sh
node testing/refresh/webview-ios.mjs \
  --simulator D942F30F-EB29-4921-892E-5F3160A038A3 \
  --observer /absolute/private-ios-observer.json --close-observer
```

Run `build/refresh-webview-ios/1793909311294-61792/report.json` **failed before
any Refresh patch** on the iOS 26.5 simulator. Both real WKWebView documents
answered fresh request 3 with their original distinct nonces, counter 1, seeded
form values, scroll position 120, and URL hash `#state-1`. However, both reported
`historyStep: 0` and `historyLength: 1`, despite the fixture calling
`history.pushState({step: 1}, '', '#state-1')`; `error` remained null. The test
requires state 1 and at least two history entries and was not relaxed.

The current iOS adapter loads inline HTML with
`loadHTMLString:baseURL:NSBundle.mainBundle.bundleURL` in
`platforms/ios/NativeHost/main.mm`. That file-origin loading path is a candidate
explanation, not an established root cause. No native API, document origin,
fixture, or browser assertion was changed to obtain a passing result. The three
iOS refresh-preservation cases therefore remain unverified.

The report retains fresh browser messages, OS-accessibility failure snapshot,
fixture hashes, installed launcher/debug-dylib/Hermes/bundle hashes, and
`failure.png`. Installed artifacts were unchanged. Cleanup completed: publisher
stopped with no pending patches; owned development configs were removed; a fresh
healthy packaged fixture was observed through XCTest; the separate observer
closed and its `test-without-building` run exited successfully. No physical
iPhone was used, and no native application build was performed.
