#!/usr/bin/env bash
set -euo pipefail
prototype_root="$(cd "$(dirname "$0")/.." && pwd)"
: "${HERMES_ROOT:?Set HERMES_ROOT to a matched Hermes destroot (see runtime/README.md)}"
hermes_framework="${HERMES_FRAMEWORK:-$HERMES_ROOT/Library/Frameworks/universal/hermesvm.xcframework/macos-arm64_x86_64/hermesvm.framework}"
cargo build --manifest-path "$prototype_root/core/Cargo.toml" --release --features test-hooks --target-dir "$prototype_root/build/core-test"
cmake -S "$prototype_root/runtime" -B "$prototype_root/build/headless" \
  -DCMAKE_BUILD_TYPE=Release -DNH_TEST_HOOKS=ON -DNH_SERVICE_TEST_HOOKS=ON \
  -DNH_CORE_LIBRARY="$prototype_root/build/core-test/release/libnative_host_core.a" \
  -DHERMES_ROOT="$HERMES_ROOT" -DHERMES_FRAMEWORK="$hermes_framework"
cmake --build "$prototype_root/build/headless" --parallel 6
