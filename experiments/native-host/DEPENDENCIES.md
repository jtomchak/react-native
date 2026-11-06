# Prototype dependency proposal

The prototype is isolated from the root workspace packages and does not change
the production React Native package. Proposed exact package versions:

| Package | Purpose | Classification |
| --- | --- | --- |
| react 19.3.0 | Existing repository React version, used by the prototype | Runtime, already used in this repository |
| react-reconciler 0.34.0 | Upstream React renderer integration; peer requires React ^19.3.0 | New runtime dependency; approved 2026-11-05 |
| rolldown 1.3.0 | Rust-backed JSX/TypeScript bundle generation | Prototype development tool |
| @playwright/test 1.64.1 | Test fixtures, assertions and reporting | Prototype development tool |
| react-refresh 0.14.2 | Permanent development bootstrap and component update validation; matches the reference checkout | Development only; excluded from production bundles |
| serde_json 1.0.145 (Rust) | Bounded JSON messages in the separate desktop Refresh transport | Development tool only; never linked into the native application |

The Rust service core initially uses only the standard library. Hermes and Yoga
are existing project components, reused through native bindings. Cached native
artifacts may bootstrap the prototype only with their exact versions recorded;
they are not equivalent to the pinned reference runtime without verification.

No Tauri/Wry or additional native runtime libraries are selected at this point.
The application service core remains standard-library-only; the separate
`dev-refresh` desktop tool has its own Cargo lockfile and JSON parser dependency.
The user approved React/reconciler, Rolldown and
Playwright on 2026-11-05. React Refresh was subsequently added as a development
tool for the state-preserving update experiment, as was the desktop JSON parser;
neither is an additional production dependency. Packages are installed only in
this isolated experiment.
