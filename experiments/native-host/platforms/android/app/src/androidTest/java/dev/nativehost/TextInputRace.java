package dev.nativehost;

import android.app.Instrumentation;
import android.os.SystemClock;
import android.widget.EditText;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;

/** Deterministic real EditText/event-queue regression, not system-input evidence. */
final class TextInputRace {
  private final Instrumentation instrumentation;
  private final HostActivity app;
  private int assertions;
  private interface Query<T> { T run() throws Exception; }
  TextInputRace(Instrumentation instrumentation, HostActivity app) { this.instrumentation = instrumentation; this.app = app; }

  JSONObject run() throws Exception {
    JSONObject initial = onUi(() -> app.testNodeState("name-input"));
    require(initial.getLong("nativeTextEventCount") == 0, "initial programmatic mount does not count as a native edit");
    JSONObject queued = onUi(() -> {
      EditText input = (EditText) app.testView("name-input");
      // One UI turn guarantees all three native edits precede delivery of the
      // first posted event. No fabricated app.event or direct JS handler call.
      input.setText("A"); input.setText("AB"); input.setText("ABC"); input.setSelection(1);
      return app.testNodeState("name-input");
    });
    require(queued.getLong("nativeTextEventCount") == 3 && "ABC".equals(queued.getString("text")), "three real native edits are queued before JS delivery");
    await(() -> onUi(() -> {
      JSONObject props = inputProps(app);
      return props != null && props.optLong("mostRecentEventCount", -1) == 3 && "ABC".equals(props.optString("value"));
    }), "React acknowledges the latest edit");
    JSONObject settled = onUi(() -> app.testNodeState("name-input"));
    require("ABC".equals(settled.getString("text")), "older controlled echoes do not erase newer native text");
    require(settled.getLong("rejectedTextUpdates") >= 2, "both older controlled value writes were rejected");
    require(settled.getLong("nativeTextEventCount") == 3, "controlled commits do not produce additional native events");
    require(settled.getInt("selectionStart") == 1 && settled.getInt("selectionEnd") == 1, "same-value acknowledgement preserves native selection");
    require(onUi(() -> app.testHealth().getBoolean("healthy")), "native runtime remains healthy");
    return new JSONObject().put("kind", "white-box-native-edit-queue").put("systemInput", false)
        .put("assertions", assertions).put("initial", initial).put("queued", queued).put("settled", settled)
        .put("committedProps", onUi(() -> inputProps(app)));
  }
  static JSONObject inputProps(HostActivity app) throws Exception { return find(new JSONObject(app.testSnapshot()).getJSONArray("children")); }
  private static JSONObject find(JSONArray children) throws Exception {
    for (int i = 0; i < children.length(); i++) {
      JSONObject node = children.getJSONObject(i), props = node.optJSONObject("props");
      if (props != null && "name-input".equals(props.optString("testID"))) return props;
      JSONArray nested = node.optJSONArray("children");
      if (nested != null) { JSONObject found = find(nested); if (found != null) return found; }
    }
    return null;
  }
  private <T> T onUi(Query<T> query) throws Exception {
    AtomicReference<T> value = new AtomicReference<>(); AtomicReference<Exception> failure = new AtomicReference<>();
    instrumentation.runOnMainSync(() -> { try { value.set(query.run()); } catch (Exception error) { failure.set(error); } });
    if (failure.get() != null) throw failure.get();
    return value.get();
  }
  private void await(Query<Boolean> condition, String message) throws Exception {
    long deadline = SystemClock.uptimeMillis() + 10000;
    while (SystemClock.uptimeMillis() < deadline) {
      if (condition.run()) { assertions++; return; }
      String failure = onUi(() -> app.testFailure()); if (failure != null) throw new AssertionError(failure);
      Thread.sleep(20);
    }
    throw new AssertionError("Timed out: " + message);
  }
  private void require(boolean condition, String message) { assertions++; if (!condition) throw new AssertionError(message); }
}
