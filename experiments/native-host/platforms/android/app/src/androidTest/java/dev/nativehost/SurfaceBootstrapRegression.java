package dev.nativehost;

import android.app.Instrumentation;
import android.os.Handler;
import android.os.Looper;
import android.widget.FrameLayout;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/** Deterministic real View layout and UI queue regression, not a Doze simulation. */
final class SurfaceBootstrapRegression {
  static JSONObject run(Instrumentation instrumentation) throws Exception {
    AtomicInteger calls = new AtomicInteger(), cancelledCalls = new AtomicInteger();
    FrameLayout[] views = new FrameLayout[2];
    SurfaceBootstrap[] gates = new SurfaceBootstrap[2];
    instrumentation.runOnMainSync(() -> {
      Handler owner = new Handler(Looper.getMainLooper());
      for (int i = 0; i < 2; i++) views[i] = new FrameLayout(instrumentation.getTargetContext());
      gates[0] = new SurfaceBootstrap(views[0], owner, calls::incrementAndGet);
      gates[1] = new SurfaceBootstrap(views[1], owner, cancelledCalls::incrementAndGet);
      gates[0].start(); gates[0].start(); gates[1].start();
    });
    instrumentation.waitForIdleSync();
    require(calls.get() == 0 && cancelledCalls.get() == 0, "initial zero geometry does not bootstrap");
    instrumentation.runOnMainSync(() -> views[0].layout(0, 0, 0, 100));
    instrumentation.waitForIdleSync();
    require(calls.get() == 0, "zero width with positive height remains pending");
    instrumentation.runOnMainSync(() -> views[0].layout(0, 0, 100, 0));
    instrumentation.waitForIdleSync();
    require(calls.get() == 0, "positive width with zero height remains pending");
    instrumentation.runOnMainSync(() -> {
      views[0].layout(0, 0, 100, 200);
      views[1].layout(0, 0, 100, 200);
      gates[1].close(); // Cancel the already-posted positive-layout attempt.
    });
    instrumentation.waitForIdleSync();
    require(calls.get() == 1, "first actual positive layout bootstraps exactly once");
    require(cancelledCalls.get() == 0, "teardown cancels queued positive-layout bootstrap");
    instrumentation.runOnMainSync(() -> {
      views[0].layout(0, 0, 200, 300); gates[0].start();
      views[1].layout(0, 0, 200, 300); gates[1].start();
    });
    instrumentation.waitForIdleSync();
    require(calls.get() == 1 && cancelledCalls.get() == 0, "later layouts and repeated start cannot resurrect either gate");
    return new JSONObject().put("kind", "white-box-real-view-layout-owner-queue").put("assertions", 6)
        .put("bootstrapCount", calls.get()).put("cancelledBootstrapCount", cancelledCalls.get()).put("dozeSimulation", false);
  }
  private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
