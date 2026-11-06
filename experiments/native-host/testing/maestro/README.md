# Independent native smoke lane

This flow uses the separately installed Maestro CLI and platform accessibility
and input. It never connects to the prototype's embedded test protocol. Run only
after the task-owned device is idle; do not run it concurrently with XCTest or
the Android instrumentation driver.

From the experiment directory:

```sh
maestro --device emulator-5580 test -e APP_ID=dev.nativehost.experiment --format junit --output build/maestro-android.xml testing/maestro/smoke.yaml
maestro --device D942F30F-EB29-4921-892E-5F3160A038A3 test -e APP_ID=dev.nativehost.prototype --format junit --output build/maestro-ios.xml testing/maestro/smoke.yaml
```

The flow restarts the task app, observes native state, taps a WebView button and
then a native cover. The covered-coordinate occlusion assertion belongs to the
shared Playwright mobile scenario; tapping the cover by its accessible label
does not independently prove the exact underlying DOM target was occluded.

Maestro's [launchApp](https://docs.maestro.dev/reference/commands-available/launchapp.md),
[tapOn](https://docs.maestro.dev/reference/commands-available/tapon.md) and
[assertVisible](https://docs.maestro.dev/reference/commands-available/assertvisible.md)
commands define the flow behavior. Reports in `build/` distinguish execution
from this checked-in test definition.
