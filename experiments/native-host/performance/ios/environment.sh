#!/usr/bin/env bash
# Source from the baseline scripts; modifies only the ignored reference checkout.
PERF_IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NH_EXPERIMENT="$(cd "$PERF_IOS_DIR/../.." && pwd)"
NH_REFERENCE="${NH_REFERENCE:-$NH_EXPERIMENT/build/reference}"
NH_REFERENCE_COMMIT=fe398e511d7b4cfa22baf5b449e256ff9b7d66c4
if [[ "$(git -C "$NH_REFERENCE" rev-parse HEAD)" != "$NH_REFERENCE_COMMIT" ]]; then
  echo "Reference must be pinned to $NH_REFERENCE_COMMIT" >&2
  exit 1
fi
NH_IOS_ARTIFACTS="${NH_IOS_ARTIFACTS:-$NH_EXPERIMENT/build/performance/ios}"
export BUNDLE_GEMFILE="$NH_REFERENCE/packages/rn-tester/Gemfile"
export BUNDLE_PATH="$NH_EXPERIMENT/build/reference-ruby"
export RCT_USE_PREBUILT_RNCORE=0 RCT_USE_RN_DEP=0
export RCT_NO_LAUNCH_PACKAGER=1
