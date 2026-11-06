package dev.nativehost.observer;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Activity;
import android.app.Instrumentation;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** External observer: OS accessibility and injected system input only. No app VM access. */
public final class ObserverInstrumentation extends Instrumentation {
  private Bundle arguments;
  private boolean running = true;
  @Override public void onCreate(Bundle arguments) { this.arguments = arguments == null ? new Bundle() : arguments; super.onCreate(arguments); start(); }
  @Override public void onStart() {
    Bundle outcome = new Bundle();
    try {
      AccessibilityServiceInfo info = getUiAutomation().getServiceInfo();
      info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
      getUiAutomation().setServiceInfo(info);
      serve(); outcome.putString("stream", "External observer stopped\n"); finish(Activity.RESULT_OK, outcome);
    } catch (Throwable error) {
      outcome.putString("stream", "External observer failed: " + error + "\n"); finish(Activity.RESULT_CANCELED, outcome);
    }
  }

  private void serve() throws Exception {
    String token = arguments.getString("token", "");
    if (!token.matches("[A-Za-z0-9_-]{32,}")) throw new IllegalArgumentException("A fresh session token is required");
    int port = Integer.parseInt(arguments.getString("port", "18792"));
    if (port < 1024 || port > 65535) throw new IllegalArgumentException("Invalid observer port");
    try (ServerSocket server = new ServerSocket(port, 1, InetAddress.getLoopbackAddress())) {
      Bundle ready = new Bundle(); ready.putString("stream", "Native-host external observer ready on loopback port " + port + "\n"); sendStatus(1, ready);
      while (running) {
        try (Socket socket = server.accept()) {
          socket.setSoTimeout(120000);
          BufferedReader input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
          PrintWriter output = new PrintWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8), true);
          boolean authenticated = false;
          String line;
          while (running && (line = boundedLine(input)) != null) {
            JSONObject response = new JSONObject();
            try {
              JSONObject request = new JSONObject(line); response.put("id", request.opt("id"));
              String method = request.getString("method"); JSONObject params = request.optJSONObject("params");
              if (params == null) params = new JSONObject();
              if (!authenticated) {
                if (!"session.authenticate".equals(method) || !MessageDigest.isEqual(token.getBytes(StandardCharsets.UTF_8), params.optString("token").getBytes(StandardCharsets.UTF_8))) throw new SecurityException("Authentication required");
                authenticated = true; response.put("result", new JSONObject().put("authenticated", true));
              } else response.put("result", dispatch(method, params));
            } catch (Exception error) {
              response.put("error", new JSONObject().put("code", error instanceof SecurityException ? "UNAUTHORIZED" : "OBSERVER_ERROR").put("message", error.toString()));
            }
            output.println(response.toString());
            if (!authenticated) break;
          }
        } catch (java.net.SocketTimeoutException ignored) { /* A new client can reconnect. */ }
      }
    }
  }
  private static String boundedLine(BufferedReader reader) throws Exception {
    StringBuilder line = new StringBuilder(); int character;
    while ((character = reader.read()) != -1) {
      if (character == '\n') return line.toString();
      if (line.length() >= 65536) throw new IllegalArgumentException("Observer request too large");
      line.append((char) character);
    }
    return line.length() == 0 ? null : line.toString();
  }
  private JSONObject dispatch(String method, JSONObject params) throws Exception {
    if ("session.describe".equals(method)) return new JSONObject().put("protocolVersion", 1).put("platform", "android")
        .put("driver", "external-instrumentation-uiautomation").put("package", "dev.nativehost.observer")
        .put("observation", "operating-system-accessibility").put("inputMechanism", "system-coordinate-and-key-events")
        .put("survivesTargetForceStop", true).put("pollIntervalMs", 20).put("deviceElapsedRealtimeNanos", SystemClock.elapsedRealtimeNanos());
    if ("session.close".equals(method)) { running = false; return new JSONObject().put("closed", true); }
    String targetPackage = params.getString("package");
    if (!"dev.nativehost.reference".equals(targetPackage) && !"dev.nativehost.experiment".equals(targetPackage)) throw new SecurityException("Only the two task applications may be observed or controlled");
    JSONObject selector = params.optJSONObject("selector");
    if (selector == null) {
      selector = new JSONObject(params.toString());
      // In ui.type the top-level text is the new input value, not a selector.
      if ("ui.type".equals(method)) selector.remove("text");
    }
    if ("ui.snapshot".equals(method)) return snapshot(targetPackage);
    if ("ui.dismissKeyboard".equals(method)) {
      // Check the target still owns an app window before issuing system Back.
      AccessibilityNodeInfo root = root(targetPackage);
      if (root == null) throw new IllegalStateException("Target application is not visible");
      root.recycle(); boolean visible = false;
      for (AccessibilityWindowInfo window : getUiAutomation().getWindows()) {
        if (window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) visible = true;
        window.recycle();
      }
      if (visible) key(KeyEvent.KEYCODE_BACK, 0);
      return new JSONObject().put("performed", visible);
    }
    if ("ui.waitFor".equals(method)) {
      long started = SystemClock.elapsedRealtimeNanos(); int timeout = params.optInt("timeoutMs", 15000);
      if (timeout < 1 || timeout > 60000) throw new IllegalArgumentException("timeoutMs must be 1..60000");
      do {
        AccessibilityNodeInfo node = find(targetPackage, selector);
        if (node != null) {
          try {
            if (node.isVisibleToUser()) return nodeInfo(node).put("observedAtElapsedRealtimeNanos", SystemClock.elapsedRealtimeNanos())
                .put("waitDurationNanos", SystemClock.elapsedRealtimeNanos() - started);
          } finally { node.recycle(); }
        }
        SystemClock.sleep(20);
      } while ((SystemClock.elapsedRealtimeNanos() - started) / 1000000 < timeout);
      throw new IllegalStateException("Timed out waiting for exact visible accessibility selector " + params);
    }
    AccessibilityNodeInfo node = find(targetPackage, selector);
    if (node == null) {
      if ("ui.find".equals(method)) return new JSONObject().put("exists", false).put("observedAtElapsedRealtimeNanos", SystemClock.elapsedRealtimeNanos());
      throw new IllegalStateException("No matching accessibility node");
    }
    try {
      if ("ui.find".equals(method)) return nodeInfo(node).put("observedAtElapsedRealtimeNanos", SystemClock.elapsedRealtimeNanos());
      if ("ui.text".equals(method)) return new JSONObject().put("text", string(node.getText())).put("label", string(node.getContentDescription()));
      Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
      if (!node.isVisibleToUser() || !node.isEnabled() || bounds.isEmpty()) throw new IllegalStateException("Accessibility target is not actionable");
      if ("ui.tap".equals(method)) {
        tap(bounds.centerX(), bounds.centerY()); return new JSONObject().put("performed", true).put("bounds", rect(bounds));
      }
      if ("ui.type".equals(method)) {
        String text = params.getString("text"); if (text.length() > 4096) throw new IllegalArgumentException("Text too long");
        KeyEvent[] events = text.isEmpty() ? new KeyEvent[0] : KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray());
        if (events == null) throw new IllegalArgumentException("Text contains unsupported system keyboard characters");
        tap(bounds.centerX(), bounds.centerY());
        if (params.optBoolean("clear", true)) { key(KeyEvent.KEYCODE_A, KeyEvent.META_CTRL_ON); key(KeyEvent.KEYCODE_DEL, 0); }
        for (KeyEvent event : events) if (!getUiAutomation().injectInputEvent(event, true)) throw new IllegalStateException("System key injection rejected");
        return new JSONObject().put("performed", true).put("length", text.length());
      }
      if ("ui.scroll".equals(method)) {
        String direction = params.optString("direction", "down");
        if (!"down".equals(direction) && !"up".equals(direction)) throw new IllegalArgumentException("Scroll direction must be down or up");
        int duration = params.optInt("durationMs", 300); if (duration < 100 || duration > 2000) throw new IllegalArgumentException("Invalid swipe duration");
        float top = bounds.top + bounds.height() * .2f, bottom = bounds.top + bounds.height() * .8f;
        swipe(bounds.centerX(), "down".equals(direction) ? bottom : top, "down".equals(direction) ? top : bottom, duration);
        return new JSONObject().put("performed", true).put("mechanism", "system-swipe");
      }
      throw new IllegalArgumentException("Unsupported observer method: " + method);
    } finally { node.recycle(); }
  }

  private AccessibilityNodeInfo root(String targetPackage) {
    List<AccessibilityWindowInfo> windows = getUiAutomation().getWindows();
    AccessibilityNodeInfo result = null;
    for (AccessibilityWindowInfo window : windows) {
      AccessibilityNodeInfo node = window.getRoot();
      if (node != null) {
        if (result == null && node.refresh() && window.getType() == AccessibilityWindowInfo.TYPE_APPLICATION && targetPackage.equals(string(node.getPackageName()))) result = node;
        else node.recycle();
      }
      window.recycle();
    }
    return result;
  }
  private AccessibilityNodeInfo find(String targetPackage, JSONObject selector) throws Exception {
    boolean hasSelector = selector.has("text") || selector.has("label") || selector.has("resourceID") || selector.has("testID");
    if (!hasSelector) throw new IllegalArgumentException("An exact text, label, resourceID or testID selector is required");
    AccessibilityNodeInfo root = root(targetPackage); if (root == null) return null;
    ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>(); queue.add(root); int visited = 0;
    try {
      while (!queue.isEmpty() && visited++ < 10000) {
        AccessibilityNodeInfo node = queue.remove();
        // Accessibility's client cache can retain text after a native update.
        // Refresh via the OS connection before observing or acting on a node.
        if (!node.refresh()) { node.recycle(); continue; }
        boolean matches = (!selector.has("text") || selector.getString("text").equals(string(node.getText())))
            && (!selector.has("label") || selector.getString("label").equals(string(node.getContentDescription())))
            && (!selector.has("resourceID") || selector.getString("resourceID").equals(node.getViewIdResourceName()))
            && (!selector.has("testID") || selector.getString("testID").equals(node.getViewIdResourceName()) || selector.getString("testID").equals(string(node.getContentDescription())));
        if (matches && node.isVisibleToUser()) return node;
        for (int i = 0; i < node.getChildCount(); i++) { AccessibilityNodeInfo child = node.getChild(i); if (child != null) queue.add(child); }
        node.recycle();
      }
      return null;
    } finally { while (!queue.isEmpty()) queue.remove().recycle(); }
  }
  private JSONObject snapshot(String targetPackage) throws Exception {
    JSONArray nodes = new JSONArray(); AccessibilityNodeInfo root = root(targetPackage);
    if (root != null) {
      ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>(); queue.add(root);
      try {
        while (!queue.isEmpty() && nodes.length() < 10000) {
          AccessibilityNodeInfo node = queue.remove();
          if (!node.refresh()) { node.recycle(); continue; }
          nodes.put(nodeInfo(node));
          for (int i = 0; i < node.getChildCount(); i++) { AccessibilityNodeInfo child = node.getChild(i); if (child != null) queue.add(child); }
          node.recycle();
        }
      } finally { while (!queue.isEmpty()) queue.remove().recycle(); }
    }
    return new JSONObject().put("package", targetPackage).put("nodes", nodes).put("observedAtElapsedRealtimeNanos", SystemClock.elapsedRealtimeNanos());
  }
  private static JSONObject nodeInfo(AccessibilityNodeInfo node) throws Exception {
    Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
    return new JSONObject().put("exists", true).put("text", string(node.getText())).put("label", string(node.getContentDescription()))
        .put("resourceID", node.getViewIdResourceName() == null ? JSONObject.NULL : node.getViewIdResourceName())
        .put("className", string(node.getClassName())).put("package", string(node.getPackageName()))
        .put("visible", node.isVisibleToUser()).put("enabled", node.isEnabled()).put("clickable", node.isClickable()).put("scrollable", node.isScrollable())
        .put("focused", node.isFocused()).put("selectionStart", node.getTextSelectionStart()).put("selectionEnd", node.getTextSelectionEnd()).put("bounds", rect(bounds));
  }
  private static JSONObject rect(Rect rect) throws Exception { return new JSONObject().put("x", rect.left).put("y", rect.top).put("width", rect.width()).put("height", rect.height()); }
  private static String string(CharSequence value) { return value == null ? "" : value.toString(); }
  private void key(int code, int meta) {
    long now = SystemClock.uptimeMillis();
    if (!getUiAutomation().injectInputEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, meta), true)
        || !getUiAutomation().injectInputEvent(new KeyEvent(now, now, KeyEvent.ACTION_UP, code, 0, meta), true)) throw new IllegalStateException("System key injection rejected");
  }
  private void touch(long down, long now, int action, float x, float y) {
    MotionEvent event = MotionEvent.obtain(down, now, action, x, y, 0); event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
    try { if (!getUiAutomation().injectInputEvent(event, true)) throw new IllegalStateException("System touch injection rejected"); }
    finally { event.recycle(); }
  }
  private void tap(float x, float y) { long now = SystemClock.uptimeMillis(); touch(now, now, MotionEvent.ACTION_DOWN, x, y); touch(now, now + 30, MotionEvent.ACTION_UP, x, y); }
  private void swipe(float x, float fromY, float toY, int duration) {
    long start = SystemClock.uptimeMillis(); touch(start, start, MotionEvent.ACTION_DOWN, x, fromY);
    int steps = 12;
    for (int step = 1; step <= steps; step++) { SystemClock.sleep(duration / steps); touch(start, SystemClock.uptimeMillis(), MotionEvent.ACTION_MOVE, x, fromY + (toY - fromY) * step / steps); }
    touch(start, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, toY);
  }
}
