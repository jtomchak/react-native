# Full RNTester iOS baseline

This baseline builds the full RNTester application from detached reference commit
`fe398e511d7b4cfa22baf5b449e256ff9b7d66c4`. It retains RNTester's complete native and
JavaScript graph. The shared performance-screen adapter is installed by
`performance/reference`; it adds a deterministic startup route without pruning
other RNTester examples.

Run from the repository root:

```sh
bash experiments/native-host/performance/ios/setup.sh
bash experiments/native-host/performance/ios/build.sh Debug
bash experiments/native-host/performance/ios/build.sh Release
```

Prerequisites are the already prepared `build/reference` checkout, its installed
Node dependencies, built codegen, Xcode, Ruby/Bundler and CMake. The setup uses the
reference Gemfile, a separate ignored Ruby install directory, and saved generated
Gemfile/Podfile locks. This commit's source declares Hermes `260318099.0.2` while
its original Podfile lock contains `.0.1`; the initial setup updates only that
declared Hermes version; local podspec graphs are regenerated from the pinned
checkout (including its stable C++ API facades), while other existing locked pod
versions stay unchanged. React Native core and its native dependencies explicitly compile
from source. Hermes uses the source-declared prebuilt Debug/Release artifacts.

Builds target unsigned arm64 iOS Simulator with four Xcode jobs by default
(`NH_BUILD_JOBS` overrides this). Debug and Release use separate DerivedData
folders under ignored `build/performance`. Scripts preserve existing caches;
these commands do not constitute controlled clean-build measurements. They record
commands, exit status, logs and elapsed setup observations, explicitly marked as
unsuitable for performance comparison while other builds run.

Debug follows RNTester's normal simulator workflow: the native build skips JS
bundling and the app requests the full graph from Metro. After coordination with
the parent performance runner, start the dedicated server and launch explicitly:

```sh
bash experiments/native-host/performance/ios/serve.sh
NH_SIMULATOR_ID=<dedicated-uuid> bash experiments/native-host/performance/ios/launch.sh Debug
```

Metro binds only `127.0.0.1:18793` by default (`NH_REFERENCE_METRO_PORT` overrides
it). RNTester's existing `-RCT_jsLocation` launch argument selects that server
without changing framework code. Release embeds the full JS graph and does not
need Metro. Launch selects `-route NativeHostPerformance`, implemented by the
shared reference adapter. No script chooses a simulator implicitly or accesses a
physical device.

The candidate currently embeds a different Hermes version. Keep that engine
version difference, the full RNTester graph versus the small candidate app, the
build configuration, cache state, and concurrent workload status visible in any
reported comparison. Setup success alone is not runtime or performance evidence.
