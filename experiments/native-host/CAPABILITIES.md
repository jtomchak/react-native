# Prototype behavior contract

This is a supported-subset ledger, not an RN API compatibility declaration.
Reference-derived contracts, headless behavior and actual device observations
are distinct lanes in [VERIFICATION.md](./VERIFICATION.md).

| Primitive | Implemented surface | Important gaps |
| --- | --- | --- |
| View | Native container, test/accessibility labels, Yoga geometry and the documented style subset | Full accessibility roles/states, dynamic dimensions/font scaling and complete pointer/gesture semantics |
| Text | Native plain text display, basic font/color/alignment, flattened child text | Native intrinsic shaping/measurement, independently styled nested runs, full wrapping/selection compatibility |
| Image | Sized native image widget; candidate platform source-loading subsets | Matched remote loading/cache policy, load/error events, cancellation and content-mode compatibility |
| Pressable | Native actionable container, `onPress`, disabled state, native overlay hit testing | Pressability state machine, press-in/out/long-press and responder arbitration |
| TextInput | Single-line text, controlled `value`, mount-only `defaultValue`, change/focus/blur/submit events; focus/blur/clear commands | Multiline, selection/composition/IME contracts, full keyboard/accessibility props |
| ScrollView | Vertical native scrolling and content extent, scroll event, scrollTo/scrollToEnd commands | Nested gesture arbitration, momentum/event batching, horizontal and keyboard interaction parity |
| WebView | Independently mounted platform browser, HTML/platform URL-source subset, message/navigation events, imperative commands | Unified navigation/frame-trust/storage policy, complete load/error ordering, content-process recovery and repeated teardown/resource acceptance |

Unknown or untested props are not implied by the presence of a primitive name.
The supported Yoga style subset is listed in [runtime/README.md](./runtime/README.md).

## Platform lifecycle service

`getAppState()` captures the host's latest native lifecycle observation and
completes asynchronously through Rust; `subscribeAppState()` delivers ordered,
generation-scoped changes and supports unsubscribe. iOS reports native
active/inactive/background transitions. Android currently reports foreground and
background for the selected single-Activity host. Headless reports this capability
unsupported. This is a new host service, not the complete React Native AppState API.
[Physical tests](./testing/APP_STATE.md) verify actual Home/foreground cycles,
stable runtime identity and no callbacks after unsubscribe on both phones.

## Native command ABI v1

`NHHostOptions` installs commit/command callbacks and a capability map before
the application bundle is evaluated. The older creation entry point remains
valid with no native command backend. `session.describe.nativeCommands` and
`__nhCommandCapabilities` identify what an attached backend advertises.

| Target | Commands | Completion meaning |
| --- | --- | --- |
| TextInput | focus, blur, clear | Synchronous UI operation submitted; observe native focus/value separately |
| ScrollView | scrollTo({x,y,animated}), scrollToEnd({animated}) | Native scrolling requested; observe offset/events separately |
| WebView | goBack, goForward, reload, stopLoading, postMessage(string), injectJavaScript(string) | Browser operation submitted; navigation/script completion is asynchronous |

The [TextInput](https://reactnative.dev/docs/textinput#methods) and
[ScrollView](https://reactnative.dev/docs/scrollview#scrollto) public APIs and
[react-native-webview methods](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md)
are references for these selected semantics. Clear empties native text without
synthesizing a user change event; a subsequent controlled-value commit can
reassert the React value. Scroll methods use logical coordinates and default to
animated movement; the test fixture requests nonanimated movement explicitly.

Commands validate schema, runtime generation, committed target/type, capability
and bounded arguments. Platform callbacks return owned JSON and may not reenter
the host. Native delegates enqueue events for a later UI-thread turn and
revalidate the target/runtime/document before delivery. The renderer postpones
layout-effect commands until the final native mount and drops commands targeting
a node or source replaced before that mount. It bounds pending command count
and retained string size. The headless backend rejects actual platform commands.

The React command-queue tests use an explicit recorder to isolate sequencing;
they do not prove native focus or browser execution. CTest validates the ABI
with real Hermes. `testing/mobile-commands.spec.mjs` uses system input to invoke
React refs and then observes native fields, offsets and browser messages.

## History fixture constraint

The history fixture creates entries through real taps inside the browser.
WebKit deliberately skips history entries created without user activation when
traversing through its native back/forward API; injected `pushState` was an
invalid cross-platform expectation in the first test attempt.
[WebKit issue 241885](https://bugs.webkit.org/show_bug.cgi?id=241885)

Same-document navigation must preserve the browser document identity, including
same-URL and path/query history changes. A URL-fragment heuristic alone cannot
prove a new document was created. The shared command scenario now observes native
back/forward traversal and working message delivery across these changes on the
iOS simulator and physical Pixel 2 XL.

The iOS history fixture loads real HTTP documents from a simulator-only loopback
server. `WKWebView.loadHTMLString` did not create the native history entries this
fixture needed; inline-HTML history compatibility is not established. Android
serves inline HTML through a unique synthetic HTTPS URL scoped to the current
source. These different source-loading paths are explicit test boundaries, not
evidence of identical browser behavior. Neither scenario proves process recovery,
storage isolation or cancellation of an in-flight navigation.
