package dev.nativehost;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.KeyCharacterMap;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.TextView;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;

/** No third-party driver: actual system-injected pointer events via UiAutomation. */
public final class HostInstrumentation extends Instrumentation {
  private HostActivity app;
  private int assertions;
  private Bundle arguments;
  private volatile boolean appStopped;
  private final android.app.Application.ActivityLifecycleCallbacks lifecycle = new android.app.Application.ActivityLifecycleCallbacks() {
    public void onActivityCreated(Activity a, Bundle b) {}
    public void onActivityStarted(Activity a) {}
    public void onActivityResumed(Activity a) { if (a == app) appStopped = false; }
    public void onActivityPaused(Activity a) {}
    public void onActivityStopped(Activity a) { if (a == app) appStopped = true; }
    public void onActivitySaveInstanceState(Activity a, Bundle b) {}
    public void onActivityDestroyed(Activity a) {}
  };
  @Override public void onDestroy() {
    ((android.app.Application) getTargetContext().getApplicationContext()).unregisterActivityLifecycleCallbacks(lifecycle);
    super.onDestroy();
  }
  @Override public void onCreate(Bundle arguments) { this.arguments = arguments == null ? new Bundle() : arguments; super.onCreate(arguments); start(); }
  @Override public void onStart() {
    Bundle result = new Bundle();
    DevTransportRegression devRegression = null;
    ((android.app.Application) getTargetContext().getApplicationContext()).registerActivityLifecycleCallbacks(lifecycle);
    try {
      if ("dev-transport".equals(arguments.getString("mode"))) {
        if (arguments.getString("revision") != null) throw new IllegalArgumentException("Transport regression uses packaged bundle");
        devRegression = DevTransportRegression.prepare(this);
      }
      app = (HostActivity) startActivitySync(launchIntent());
      await(() -> onUi(() -> app.testHasRuntime()) || onUi(() -> app.testFailure()) != null, "native runtime startup or rejection");
      if (devRegression != null) {
        require(onUi(() -> app.testHasRuntime()) && onUi(() -> app.testFailure()) == null, "native runtime available for transport regression");
        JSONObject report = devRegression.run(app);
        result.putString("stream", "\nPASS Android development transport: " + report.toString() + "\n");
        finish(Activity.RESULT_OK, result); return;
      }
      if ("server".equals(arguments.getString("mode"))) { serve(); finish(Activity.RESULT_OK, result); return; }
      if ("surface-bootstrap".equals(arguments.getString("mode"))) {
        JSONObject report = SurfaceBootstrapRegression.run(this);
        require(onUi(() -> app.testHasRuntime()) && onUi(() -> app.testFailure()) == null, "real Activity host boots after layout");
        result.putString("stream", "\nPASS Android surface bootstrap: " + report.toString() + "\n");
        finish(Activity.RESULT_OK, result); return;
      }
      if ("text-input-race".equals(arguments.getString("mode"))) {
        require(onUi(() -> app.testHasRuntime()) && onUi(() -> app.testFailure()) == null, "native runtime is available for input regression");
        JSONObject report = new TextInputRace(this, app).run();
        result.putString("stream", "\nPASS Android controlled-input race: " + report.toString() + "\n");
        finish(Activity.RESULT_OK, result); return;
      }
      if ("text-input-system".equals(arguments.getString("mode"))) {
        require(onUi(() -> app.testHasRuntime()) && onUi(() -> app.testFailure()) == null, "native runtime is available for system typing regression");
        JSONObject report = systemTypingRegression();
        result.putString("stream", "\nPASS Android controlled-input system typing: " + report.toString() + "\n");
        finish(Activity.RESULT_OK, result); return;
      }
      if ("inline-source-race".equals(arguments.getString("mode"))) {
        require(onUi(() -> app.testHasRuntime()) && onUi(() -> app.testFailure()) == null, "native runtime is available for lifecycle regression");
        JSONObject report = new InlineSourceRace(this, app).run();
        result.putString("stream", "\nPASS Android inline-source race: " + report.toString() + "\n");
        finish(Activity.RESULT_OK, result); return;
      }
      require(onUi(() -> app.testFailure()) == null, "native Hermes starts successfully");
      require(onUi(() -> app.testSnapshot()).contains("WebView"), "React commits include WebView primitive");
      View original = view("web-primary");
      tap(view("increment"));
      await(() -> text("count-label").equals("Count: 1"), "React state update from coordinate tap");
      require(original == view("web-primary"), "stable React id preserves native WebView instance");
      await(() -> "true".equals(evaluate("web-primary", "Boolean(window.NativeHost && document.getElementById('web-target'))")), "primary DOM and native messaging ready");
      await(() -> "true".equals(evaluate("web-secondary", "Boolean(window.NativeHost && document.getElementById('web-target'))")), "secondary DOM ready");
      String before = text("web-result");
      require("true".equals(evaluate("web-primary", "(()=>{NativeHostTransport.postMessage(null,'malformed');NativeHostTransport.postMessage(null,null);NativeHostTransport.postMessage('', 'malformed');NativeHostTransport.postMessage('00000000-0000-0000-0000-000000000000',null);return true})()")), "malformed bridge calls return without crashing");
      waitForIdleSync();
      require(before.equals(text("web-result")), "malformed WebView messages do not dispatch React events");
      require(onUi(() -> app.testHealth()).getBoolean("healthy"), "malformed WebView messages preserve native session health");
      int[] target = domCenter("web-primary");
      tap(target[0], target[1]);
      await(() -> !before.equals(text("web-result")), "WebView DOM receives actual system coordinate tap and sends Hermes message");
      String secondaryBefore = evaluate("web-secondary", "String(window.__tapCount || 0)");
      String primaryBeforeCover = evaluate("web-primary", "String(window.__tapCount || 0)");
      tap(view("toggle-overlay"));
      await(() -> view("web-overlay") != null, "React commits native cover");
      String overlayBefore = text("overlay-result");
      tap(target[0], target[1]);
      await(() -> !overlayBefore.equals(text("overlay-result")), "covered coordinate reaches native overlay");
      require(primaryBeforeCover.equals(evaluate("web-primary", "String(window.__tapCount || 0)")), "native overlay blocks underlying DOM hit");
      require(secondaryBefore.equals(evaluate("web-secondary", "String(window.__tapCount || 0)")), "independent WebView remains unaffected");
      require(onUi(() -> app.testFailure()) == null, "no native host failure after interactions");
      result.putString("stream", "\nPASS Android native-host system-input scenario: " + assertions + " assertions; Hermes + Rust + React; UiAutomation coordinate input.\n");
      result.putString("snapshot", onUi(() -> app.testSnapshot()));
      finish(Activity.RESULT_OK, result);
    } catch (Throwable failure) {
      if (devRegression != null) try { devRegression.cleanup(); } catch (Exception cleanup) { failure.addSuppressed(cleanup); }
      result.putString("stream", "\nFAIL Android native-host: " + android.util.Log.getStackTraceString(failure));
      finish(Activity.RESULT_CANCELED, result);
    }
  }

  private Intent launchIntent() {
    Intent intent = new Intent(getTargetContext(), HostActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    String revision = arguments.getString("revision");
    if (revision != null) intent.putExtra("devRevision", revision);
    return intent;
  }

  private JSONObject systemTypingRegression() throws Exception {
    org.json.JSONArray rounds = new org.json.JSONArray();
    String[] values = {"RapidNativeInput0123456789abcdefghijklmnopqrstuvwxyz", "SECOND9876543210abcdefghijklmnopqrstuvwxyz", "FinalExactText0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"};
    long previousCount = onUi(() -> app.testNodeState("name-input").getLong("nativeTextEventCount"));
    for (String value : values) {
      tap(view("name-input")); injectKey(KeyEvent.KEYCODE_A, KeyEvent.META_CTRL_ON); injectKey(KeyEvent.KEYCODE_DEL, 0);
      KeyEvent[] events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(value.toCharArray());
      require(events != null, "system keyboard can encode regression text");
      for (KeyEvent event : events) require(getUiAutomation().injectInputEvent(event, false), "asynchronous system key accepted");
      await(() -> value.equals(text("name-input")) && onUi(() -> {
        JSONObject props = TextInputRace.inputProps(app);
        return value.equals(props.optString("value")) && props.optLong("mostRecentEventCount", -1)
            == app.testNodeState("name-input").getLong("nativeTextEventCount");
      }), "native and React controlled values match full rapid input");
      JSONObject observed = onUi(() -> app.testNodeState("name-input"));
      require(observed.getLong("nativeTextEventCount") > previousCount, "native event count advances monotonically");
      previousCount = observed.getLong("nativeTextEventCount");
      rounds.put(new JSONObject().put("expected", value).put("systemKeyEvents", events.length).put("observed", observed));
    }
    require(onUi(() -> app.testHealth().getBoolean("healthy")), "system typing preserves runtime health");
    return new JSONObject().put("kind", "real-system-key-bursts").put("systemInput", true)
        .put("injectionWaitPerKey", false).put("assertions", assertions).put("rounds", rounds);
  }

  private void serve() throws Exception {
    String token = arguments.getString("token", "");
    if (token.length() < 32) throw new IllegalArgumentException("Test session token must contain at least 32 characters");
    int port = Integer.parseInt(arguments.getString("port", "18771"));
    try (ServerSocket server = new ServerSocket(port, 1, InetAddress.getLoopbackAddress())) {
      Bundle ready = new Bundle(); ready.putString("stream", "Native-host test driver ready on device loopback port " + port + "\n"); sendStatus(1, ready);
      boolean running = true;
      while (running) {
        try (Socket socket = server.accept()) {
          socket.setSoTimeout(120000);
          BufferedReader input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
          PrintWriter output = new PrintWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8), true);
          boolean authenticated = false;
          while (running) {
            String line = boundedLine(input);
            if (line == null) break;
            JSONObject response = new JSONObject();
            try {
              JSONObject request = new JSONObject(line);
              response.put("id", request.opt("id"));
              String method = request.getString("method");
              JSONObject params = request.optJSONObject("params");
              if (params == null) params = new JSONObject();
              if ("session.authenticate".equals(method)) {
                authenticated = MessageDigest.isEqual(token.getBytes(StandardCharsets.UTF_8), params.optString("token").getBytes(StandardCharsets.UTF_8));
                if (!authenticated) throw new SecurityException("Invalid session token");
                response.put("result", new JSONObject().put("authenticated", true));
              } else {
                if (!authenticated) throw new SecurityException("Authenticate first");
                if ("session.close".equals(method)) { running = false; response.put("result", true); }
                else response.put("result", command(method, params));
              }
            } catch (Throwable error) { response.put("error", new JSONObject().put("code", "DRIVER_ERROR").put("message", error.toString())); }
            output.println(response.toString());
            if (!authenticated) break;
          }
        } catch (java.net.SocketTimeoutException timeout) { /* drop idle test client */ }
      }
    }
  }

  private static String boundedLine(BufferedReader input) throws Exception {
    StringBuilder line = new StringBuilder(); int value;
    while ((value = input.read()) != -1) {
      if (value == '\n') return line.toString();
      if (line.length() >= 1024 * 1024) throw new IllegalArgumentException("Test request exceeds 1 MiB");
      line.append((char) value);
    }
    return line.length() == 0 ? null : line.toString();
  }

  private Object command(String method, JSONObject params) throws Exception {
    switch (method) {
      case "session.describe": {
        JSONObject description = onUi(() -> app.testHasRuntime()) ? hostCommand(method, params) : new JSONObject().put("runtime", "not-started").put("platform", "android");
        JSONObject launch = onUi(() -> app.testLaunchInfo());
        java.util.Iterator<String> keys = launch.keys();
        while (keys.hasNext()) { String key = keys.next(); description.put(key, launch.get(key)); }
        description.put("runtimeGeneration", description.opt("generation") == null ? JSONObject.NULL : description.opt("generation"));
        description.put("driver", "android-instrumentation-uiautomation");
        description.put("inputMechanism", "system-coordinate-events");
        description.put("webviewAutomation", "instrumented-evaluateJavascript");
        return description;
      }
      case "lifecycle.background": {
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getTargetContext().startActivity(home);
        await(() -> appStopped, "OS Home stopped the existing Activity");
        return new JSONObject().put("performed", true).put("mechanism", "system-home-intent");
      }
      case "lifecycle.activate": {
        if (onUi(() -> app.isFinishing() || app.isDestroyed())) throw new IllegalStateException("PROCESS_EXITED: refusing replacement Activity");
        Intent existing = new Intent(getTargetContext(), HostActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        getTargetContext().startActivity(existing);
        await(() -> !appStopped && onUi(() -> app.hasWindowFocus()), "OS activated existing Activity");
        return new JSONObject().put("performed", true).put("mechanism", "os-reorder-existing-activity");
      }
      case "session.health": return onUi(() -> app.testHealth());
      case "ui.snapshot": return new JSONObject(onUi(() -> app.testSnapshot()));
      case "ui.inspect": return onUi(() -> app.testNodeState(params.getString("testID")));
      case "ui.text": {
        View target = view(params.getString("testID"));
        if (target == null) throw new IllegalArgumentException("Missing native target");
        return new JSONObject().put("text", onUi(() -> nativeText(target)));
      }
      case "ui.find": {
        String id = params.getString("testID");
        View target = view(id);
        if (target == null) return new JSONObject().put("testID", id).put("exists", false).put("visible", false).put("enabled", false);
        return onUi(() -> {
          int[] location = new int[2]; target.getLocationOnScreen(location);
          Rect visible = new Rect();
          return new JSONObject().put("testID", id).put("exists", true)
              .put("label", target.getContentDescription() == null ? nativeText(target) : target.getContentDescription().toString())
              .put("visible", target.isShown() && target.getAlpha() > 0 && target.getGlobalVisibleRect(visible) && !visible.isEmpty())
              .put("enabled", target.isEnabled())
              .put("bounds", new JSONObject().put("x", location[0]).put("y", location[1]).put("width", target.getWidth()).put("height", target.getHeight()))
              .put("boundsUnit", "physical-pixels");
        });
      }
      case "ui.tap": tap(view(params.getString("testID"))); return new JSONObject().put("performed", true).put("mechanism", "system-coordinate-events");
      case "ui.dismissKeyboard": {
        boolean visible = onUi(() -> {
          View decor = app.getWindow().getDecorView();
          if (android.os.Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsets insets = decor.getRootWindowInsets();
            return insets != null && insets.isVisible(android.view.WindowInsets.Type.ime());
          }
          Rect frame = new Rect(); decor.getWindowVisibleDisplayFrame(frame);
          return decor.getHeight() - frame.bottom > 100 * getTargetContext().getResources().getDisplayMetrics().density;
        });
        if (visible) { injectKey(KeyEvent.KEYCODE_BACK, 0); waitForIdleSync(); }
        return new JSONObject().put("dismissed", visible).put("mechanism", "system-key-events");
      }
      case "ui.type": {
        tap(view(params.getString("testID")));
        String text = params.getString("text");
        KeyEvent[] events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray());
        if (!text.isEmpty() && events == null) throw new UnsupportedOperationException("Characters unsupported by Android virtual keyboard");
        injectKey(KeyEvent.KEYCODE_A, KeyEvent.META_CTRL_ON); injectKey(KeyEvent.KEYCODE_DEL, 0);
        if (events != null) for (KeyEvent event : events) require(getUiAutomation().injectInputEvent(event, true), "native typing input injected");
        waitForIdleSync();
        return new JSONObject().put("performed", true).put("mechanism", "system-key-events");
      }
      case "webview.evaluate": {
        String value = evaluate(params.getString("testID"), params.getString("source"));
        return new JSONObject().put("value", value == null ? JSONObject.NULL : new org.json.JSONTokener(value).nextValue()).put("mechanism", "instrumented-dom-evaluation");
      }
      case "webview.tap": {
        View target = view(params.getString("testID"));
        if (!(target instanceof WebView)) throw new IllegalArgumentException("Missing WebView");
        double x = params.getDouble("x"), y = params.getDouble("y");
        int[] point = onUi(() -> {
          Rect visible = actionableBounds(target);
          int[] origin = new int[2]; target.getLocationOnScreen(origin);
          float scale = getTargetContext().getResources().getDisplayMetrics().density;
          int px = origin[0] + (int) Math.round(x * scale), py = origin[1] + (int) Math.round(y * scale);
          if (!visible.contains(px, py)) throw new IllegalArgumentException("DOM point lies outside visible WebView bounds");
          return new int[] {px, py};
        });
        tap(point[0], point[1]);
        return new JSONObject().put("performed", true).put("mechanism", "system-coordinate-events");
      }
      case "fixture.reset": case "fixtures.reset": {
        runOnMainSync(() -> app.finish()); waitForIdleSync();
        app = (HostActivity) startActivitySync(launchIntent());
        await(() -> onUi(() -> app.testHasRuntime()) || onUi(() -> app.testFailure()) != null, "fixture runtime startup or rejection");
        return new JSONObject().put("reset", true).put("storageReset", false);
      }
      default: return hostCommand(method, params);
    }
  }
  private JSONObject hostCommand(String method, JSONObject params) throws Exception {
    String request = new JSONObject().put("id", 0).put("method", method).put("params", params).toString();
    JSONObject response = new JSONObject(onUi(() -> app.testDispatch(request)));
    if (response.has("error")) throw new IllegalStateException(response.getJSONObject("error").toString());
    Object value = response.opt("result");
    return value instanceof JSONObject ? (JSONObject) value : new JSONObject().put("value", value);
  }
  private void injectKey(int code, int meta) {
    long time = SystemClock.uptimeMillis();
    require(getUiAutomation().injectInputEvent(new KeyEvent(time, time, KeyEvent.ACTION_DOWN, code, 0, meta), true), "key down injected");
    require(getUiAutomation().injectInputEvent(new KeyEvent(time, time, KeyEvent.ACTION_UP, code, 0, meta), true), "key up injected");
  }

  private interface Query<T> { T run() throws Exception; }
  private <T> T onUi(Query<T> query) throws Exception {
    AtomicReference<T> result = new AtomicReference<>();
    AtomicReference<Exception> error = new AtomicReference<>();
    runOnMainSync(() -> { try { result.set(query.run()); } catch (Exception e) { error.set(e); } });
    if (error.get() != null) throw error.get();
    return result.get();
  }
  private void await(Query<Boolean> query, String description) throws Exception {
    long deadline = SystemClock.uptimeMillis() + 15000;
    while (SystemClock.uptimeMillis() < deadline) {
      if (query.run()) { assertions++; return; }
      String failure = onUi(() -> app.testFailure());
      if (failure != null) throw new AssertionError(failure);
      Thread.sleep(25);
    }
    throw new AssertionError("Timed out: " + description + "\n" + onUi(() -> app.testSnapshot()));
  }
  private void require(boolean condition, String message) { assertions++; if (!condition) throw new AssertionError(message); }
  private View view(String id) throws Exception { return onUi(() -> app.testView(id)); }
  private static String nativeText(View view) {
    if (view instanceof TextView) return ((TextView) view).getText().toString();
    StringBuilder text = new StringBuilder();
    if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) text.append(nativeText(((ViewGroup) view).getChildAt(i)));
    return text.toString();
  }
  private static Rect actionableBounds(View view) {
    Rect bounds = new Rect();
    if (!view.isEnabled() || !view.isShown() || view.getAlpha() <= 0 || !view.getGlobalVisibleRect(bounds) || bounds.isEmpty()) throw new IllegalArgumentException("Target is disabled or invisible");
    return bounds;
  }
  private String text(String id) throws Exception {
    return onUi(() -> { View view = app.testView(id); return view instanceof TextView ? ((TextView) view).getText().toString() : ""; });
  }
  private String allText() throws Exception { return onUi(() -> app.testSnapshot()); }
  private void tap(View view) throws Exception {
    if (view == null) throw new AssertionError("Missing native target");
    Rect rect = onUi(() -> actionableBounds(view));
    tap(rect.centerX(), rect.centerY());
  }
  private void tap(int x, int y) {
    long when = SystemClock.uptimeMillis();
    MotionEvent down = MotionEvent.obtain(when, when, MotionEvent.ACTION_DOWN, x, y, 0);
    MotionEvent up = MotionEvent.obtain(when, when + 50, MotionEvent.ACTION_UP, x, y, 0);
    down.setSource(InputDevice.SOURCE_TOUCHSCREEN); up.setSource(InputDevice.SOURCE_TOUCHSCREEN);
    try {
      require(getUiAutomation().injectInputEvent(down, true), "system pointer down injected");
      require(getUiAutomation().injectInputEvent(up, true), "system pointer up injected");
    } finally { down.recycle(); up.recycle(); }
    waitForIdleSync();
  }
  private String evaluate(String id, String script) throws Exception {
    CountDownLatch done = new CountDownLatch(1); AtomicReference<String> result = new AtomicReference<>();
    runOnMainSync(() -> {
      View view = app.testView(id);
      if (!(view instanceof WebView)) { done.countDown(); return; }
      ((WebView) view).evaluateJavascript(script, value -> { result.set(value); done.countDown(); });
    });
    if (!done.await(5, TimeUnit.SECONDS)) throw new AssertionError("DOM observation timeout: " + id);
    return result.get();
  }
  private int[] domCenter(String id) throws Exception {
    String json = evaluate(id, "(()=>{const r=document.getElementById('web-target').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()");
    org.json.JSONArray point = new org.json.JSONArray(json);
    return onUi(() -> {
      int[] origin = new int[2]; app.testView(id).getLocationOnScreen(origin);
      float scale = getTargetContext().getResources().getDisplayMetrics().density;
      return new int[] {origin[0] + Math.round((float) point.getDouble(0) * scale), origin[1] + Math.round((float) point.getDouble(1) * scale)};
    });
  }
}
