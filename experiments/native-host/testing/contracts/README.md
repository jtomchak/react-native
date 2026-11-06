# Shared differential contracts

Run from `experiments/native-host` after the native candidate and isolated stock
reference Fantom checkout have been built:

```sh
node scripts/compare-contracts.mjs
node --test testing/contracts/compare.test.mjs
```

The runner copies `shared.js` byte-for-byte into a new untracked fixture directory
in `build/reference/packages/react-native`, because Fantom restricts tests to that
checkout. It does not change reference runtime or test sources. The candidate gets
a separate Rolldown test bundle; the app bundle and scenarios are untouched.

Both renderers run the same component factory and action sequence with their own
React and View implementation. The adapter only supplies rendering and synchronous
task flushing. There are two cases:

- A state update in a layout effect records effect order, geometry in each effect,
  final geometry, and cleanup count.
- A keyed pair receives a state update and reorders. Measurements retain host-ref
  equality, state, geometry, effect order, and cleanup order. No renderer-specific
  numeric ids are compared. This is public ref identity, not proof of platform
  widget allocation identity.

All observations are emitted outside React callbacks and compared as structured
records. Empty/missing/extra/duplicate cases, malformed records, and mismatches
fail the command. Reference component/assertion error logs also fail even if Jest
reports success. This matters because the separate upstream UIConsistency suite
has logged swallowed assertion errors. The comparator has negative regression
tests for these record failure modes.

Artifacts are in `build/differential-contracts`: raw logs, stock Jest results,
both result documents, and `comparison.json` with the shared-source SHA256,
reference revision, and actual runtime identities. A rerun resets the comparison
to failed/incomplete before work begins, preventing stale green evidence.

The reference fixture explicitly enables Fabric commit branching. The verified
run used React 19.3.0 on both sides, while stock source-built Hermes reported OSS
version `1.0.0` and the candidate cached engine reported `250829098.0.16` (both
HBC98). Other reference flags retain their stock defaults. This mismatch is
recorded, not normalized away. These are two synchronous headless behavior
contracts, not general RN compatibility, platform input, typography, native
widget identity, intermediate mount atomicity, or WebView evidence.

For saved result comparison only:

```sh
node scripts/compare-contracts.mjs --compare build/differential-contracts/reference.json build/differential-contracts/candidate.json
```
