# Full RNTester performance-screen adapter

```sh
# From experiments/native-host:
node performance/reference/install.mjs
node performance/reference/verify.mjs
node --test performance/reference/refresh-boundary.test.mjs
```

Installation targets only the pinned detached `build/reference` worktree's
`packages/rn-tester/js` directory. It copies `performance/workload.js` and
`performance/revision.js` byte-for-byte, verifying and recording SHA256 in
`build/reference-performance-install.json`. Re-run after changing either shared
file. No Gradle, Pods, native source, dependencies, or current-checkout RN files
are changed by this adapter.

When platform owners grant a safe window but an existing revision must remain
unchanged, `install.mjs --adapter-only` updates the adapter while preserving the
exact installed workload/revision bytes. It still verifies that the workload
matches the shared source. Coordinate installation with active measurements:
changing an adapter can itself trigger development refresh.

The new `NativeHostPerformanceExample` is registered in **both complete existing
RNTester module lists**. RNTester imports, original examples, navigation chrome,
and native dependencies remain present. This is the requested larger full-app
baseline, not a slim RN shell. Its extra modules and possible background work
(for example ImageExample's import-time prefetch) remain relevant to performance
interpretation.

The existing native launch route becomes functional on the first React render:

- Android: append `--es route NativeHostPerformance` to the RNTester Activity
  launch. The native delegate supplies
  `exampleFromAppetizeParams='rntester://example/NativeHostPerformanceExample'`.
- iOS: launch RNTester with `-route NativeHostPerformance`; SceneDelegate supplies
  the same initial property through NSUserDefaults.

The adapter consumes that property in the actual RNTester navigation reducer
initializer. It does not wait for `Linking.getInitialURL()` or first mount the
default Components menu. Normal startup without the property still shows the
original menu. Valid original RNTester modules can also use the launch property;
malformed, unknown, or ambiguous launch routes fail explicitly. The ordinary
Linking event handler remains unchanged.

The shared screen is the module's single non-outer-scrollable example. The screen
owns its own ScrollView. RNTester retains its title bar/tabs and can constrain the
available content area, so native owners must verify the fixed 320×540 workload
and touch targets on each device. The standalone candidate does not gain all
RNTester features simply because this shared screen matches.

`verify.mjs` runs the actual RNTesterAppShared, complete module lists, module
container, and shared workload with the repository's Jest native-component mocks
on both selected platforms. Four tests per platform check graph retention,
zero transient default-menu renders during routed startup, real shared-workload
state/unmount actions, ordinary menu startup, and rejected invalid routes.

Test-only accommodations are narrow: allow known deprecated-internal-import
notices; give Image.prefetch its real Promise-shaped return contract without
network I/O; and resolve density-only assets as Metro does. Other warnings and
component errors retain the repository's throwing behavior. The menu observer
wraps and renders the actual memoized menu rather than replacing it.

Per-attempt logs/results are retained in `build/reference-performance-tests` and
the latest summary is `build/reference-performance-route-evidence.json`. Earlier
root-Jest attempts exposed these existing full-graph test-environment gaps and
are retained as `build/reference-performance-route-jest*.log/json`. This suite
proves JS navigation/component behavior, not native launch delivery, display
timing, or real platform geometry; those remain native-platform verification.

## Ordinary Fast Refresh boundary

The RNTester metadata module exports strings and an examples array, so it is not
a React Refresh boundary. Keeping the stateful factory invocation and an inline
example wrapper in that module caused revision updates to recreate component
types and lose state. This was an adapter artifact, not an inherent React Native
limitation.

`BoundPerformanceScreen.js` now binds the unchanged shared factory once in its
own component-only module. `PerformanceExample.js` separately imports revision
and exports only its component. The metadata module references that component.
A revision-only update stops at this ordinary component boundary and leaves the
stateful Screen type unchanged. No custom refresh registrations, HMR accept
handlers, or changes to the shared workload are introduced.

The regression test uses the installed **actual Metro module loader, React
Refresh runtime, and React test renderer**. Its legacy control demonstrates the
previous state reset; the fixed adapter preserves seeded counter/input state
through two hot revision updates and requests no full reload. Evidence is
`build/reference-refresh-boundary-evidence.json`. Native primitives are test
strings in this host-side test, so actual device HMR delivery, stable PID,
state-preserving observation, and default-development timing still require the
device-owner's separate measurement lane.
