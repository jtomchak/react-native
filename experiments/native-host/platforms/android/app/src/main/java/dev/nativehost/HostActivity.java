package dev.nativehost;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.view.ViewGroup;
import android.view.Gravity;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebResourceError;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.net.URL;
import java.net.URLConnection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.lang.ref.WeakReference;

/** Minimal native host. Hermes and platform mounts share the UI thread in v0. */
public final class HostActivity extends Activity {
  private static WeakReference<HostActivity> active = new WeakReference<>(null);
  private final String hostSessionId = UUID.randomUUID().toString();
  private String bundleRevision;
  private String requestedRevision;
  private final Handler ui = new Handler(Looper.getMainLooper());
  private final Map<Integer, Node> nodes = new HashMap<>();
  private final ExecutorService images = Executors.newSingleThreadExecutor();
  private NativeRuntime runtime;
  private long host;
  private FrameLayout surface;
  private SurfaceBootstrap bootstrap;
  private float density;
  private boolean applying;
  private boolean destroyed;
  private long appStateGeneration;
  private final AppStateLifecycle appState = new AppStateLifecycle(this::appStateChanged);
  private long requestId;
  private long commandGeneration;
  private String snapshot = "{}";
  private String failure;
  private final DevUpdateTransport devUpdates = new DevUpdateTransport();

  private static final String INLINE_ORIGIN = "https://native-host.invalid";
  private static final class InlineDocument {
    final String url;
    final String html;
    final String currentDocumentUrl;
    InlineDocument(String url, String html) { this(url, html, url); }
    InlineDocument(String url, String html, String currentDocumentUrl) {
      this.url = url; this.html = html; this.currentDocumentUrl = currentDocumentUrl;
    }
  }

  private static final class Node {
    final int id;
    final String type;
    final View view;
    ViewGroup children;
    JSONObject props = new JSONObject();
    String source = "";
    String document = "";
    int navigation;
    int sourceGeneration;
    boolean documentReady;
    boolean inputInitialized;
    long nativeTextEventCount;
    long rejectedTextUpdates;
    String loadingUrl = "";
    int droppedWebCallbacks;
    int droppedCommandCallbacks;
    volatile InlineDocument inlineDocument;
    Node(int id, String type, View view) { this.id = id; this.type = type; this.view = view; }
  }

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    active = new WeakReference<>(this);
    requestedRevision = getIntent().getStringExtra("devRevision");
    density = getResources().getDisplayMetrics().density;
    FrameLayout window = new FrameLayout(this);
    surface = new FrameLayout(this);
    surface.setFocusableInTouchMode(true);
    surface.setBackgroundColor(Color.WHITE);
    window.addView(surface, new FrameLayout.LayoutParams(-1, -1));
    window.setOnApplyWindowInsetsListener((view, insets) -> {
      FrameLayout.LayoutParams layout = (FrameLayout.LayoutParams) surface.getLayoutParams();
      layout.leftMargin = insets.getSystemWindowInsetLeft();
      layout.topMargin = insets.getSystemWindowInsetTop();
      layout.rightMargin = insets.getSystemWindowInsetRight();
      layout.bottomMargin = insets.getSystemWindowInsetBottom();
      surface.setLayoutParams(layout);
      return insets;
    });
    setContentView(window);
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
    bootstrap = new SurfaceBootstrap(surface, ui, () -> {
      if (destroyed) return;
      try {
        BundleSelection.Result bundle = BundleSelection.select(this, getIntent());
        bundleRevision = bundle.revision;
        if (android.os.Build.VERSION.SDK_INT >= 28) surface.setAccessibilityPaneTitle("Native host revision " + bundleRevision);
        runtime = new NativeRuntime(this::commit, this::nativeCommand);
        host = runtime.create(bundle.file.getAbsolutePath(), surface.getWidth() / density, surface.getHeight() / density, appState.current());
        appStateGeneration = new JSONObject(runtime.dispatch(host, "{\"method\":\"session.describe\"}")).getJSONObject("result").getLong("generation");
        devUpdates.start(this, ui, appStateGeneration, bundleRevision);
        publishStartupReceipt();
        ui.post(pump);
      } catch (Exception e) { fail(e); publishStartupReceipt(); }
    });
    bootstrap.start();
  }

  @Override protected void onResume() { super.onResume(); appState.onResume(); }
  @Override protected void onStop() { appState.onStop(); super.onStop(); }
  private void appStateChanged(String state) {
    final long observedHost = host, observedGeneration = appStateGeneration;
    if (observedHost == 0 || destroyed) return;
    ui.post(() -> {
      if (destroyed || host != observedHost || appStateGeneration != observedGeneration) return;
      try { observeRuntimeResponse(runtime.updateAppState(observedHost, observedGeneration, state), "AppState.update"); }
      catch (Exception error) { fail(error); }
    });
  }

  private final Runnable pump = new Runnable() {
    @Override public void run() {
      if (destroyed || host == 0) return;
      try { observeRuntimeResponse(runtime.pump(host), "runtime.pump"); } catch (Exception e) { fail(e); return; }
      ui.postDelayed(this, 8);
    }
  };

  private void fail(Exception e) {
    // Preserve the first failure even if later callbacks succeed or errors are
    // acknowledged in the embedded runtime. This is the platform health record.
    if (failure != null) return;
    failure = e.toString();
    android.util.Log.e("NativeHost", "Host failure", e);
    TextView error = new TextView(this); error.setText(failure); surface.addView(error);
  }

  String testSnapshot() { return snapshot; }
  String testFailure() { return failure; }
  private void publishStartupReceipt() {
    if (!BuildConfig.DEBUG) return;
    try {
      JSONObject receipt = testLaunchInfo();
      Object generation = JSONObject.NULL;
      if (host != 0 && runtime != null) {
        String response = runtime.dispatch(host, "{\"id\":0,\"method\":\"session.describe\",\"params\":{}}");
        observeRuntimeResponse(response, "startup.describe");
        JSONObject result = new JSONObject(response).optJSONObject("result");
        if (result != null && result.has("generation")) generation = result.get("generation");
      }
      receipt.put("runtimeGeneration", generation).put("healthy", host != 0 && failure == null)
          .put("failure", failure == null ? JSONObject.NULL : failure).put("observation", "startup-only");
      BundleSelection.recordStartup(this, receipt);
    } catch (Exception e) { fail(new IllegalStateException("Unable to publish startup receipt", e)); }
  }
  boolean testHasRuntime() { return host != 0 && !destroyed; }
  JSONObject testLaunchInfo() throws Exception {
    return new JSONObject().put("bundleRevision", bundleRevision == null ? JSONObject.NULL : bundleRevision)
        .put("requestedRevision", requestedRevision == null ? JSONObject.NULL : requestedRevision)
        .put("processId", android.os.Process.myPid()).put("hostSessionId", hostSessionId)
        .put("runtimeStarted", testHasRuntime());
  }
  JSONObject testHealth() throws Exception {
    if (host == 0 || destroyed) return testLaunchInfo().put("healthy", false).put("failure", failure == null ? "runtime unavailable" : failure);
    observeRuntimeResponse(runtime.pump(host), "session.health");
    JSONArray errors = new JSONArray();
    if (failure != null) errors.put(failure);
    return testLaunchInfo().put("healthy", failure == null).put("failure", failure == null ? JSONObject.NULL : failure).put("errors", errors);
  }
  View testView(String testID) {
    for (Node node : nodes.values()) if (testID.equals(node.props.optString("testID"))) return node.view;
    return null;
  }
  JSONObject testNodeState(String testID) throws Exception {
    Node node = null;
    for (Node item : nodes.values()) if (testID.equals(item.props.optString("testID"))) { node = item; break; }
    if (node == null) throw new IllegalArgumentException("Missing native node: " + testID);
    JSONObject state = new JSONObject().put("nodeId", node.id).put("type", node.type).put("focused", node.view.hasFocus()).put("attached", node.view.isAttachedToWindow());
    if (node.view instanceof TextView) state.put("text", ((TextView) node.view).getText().toString());
    if (node.view instanceof EditText) state.put("nativeTextEventCount", node.nativeTextEventCount)
        .put("rejectedTextUpdates", node.rejectedTextUpdates)
        .put("selectionStart", ((EditText) node.view).getSelectionStart()).put("selectionEnd", ((EditText) node.view).getSelectionEnd());
    if (node.view instanceof ScrollView) state.put("offset", new JSONObject().put("x", node.view.getScrollX() / density).put("y", node.view.getScrollY() / density));
    if (node.view instanceof WebView) {
      WebView web = (WebView) node.view;
      state.put("documentGeneration", node.navigation).put("sourceGeneration", node.sourceGeneration).put("documentReady", node.documentReady)
          .put("url", web.getUrl()).put("canGoBack", web.canGoBack()).put("canGoForward", web.canGoForward());
      state.put("inlineDocumentUrl", node.inlineDocument == null ? JSONObject.NULL : node.inlineDocument.url)
          .put("inlineReloadUrl", node.inlineDocument == null ? JSONObject.NULL : node.inlineDocument.currentDocumentUrl)
          .put("droppedWebCallbacks", node.droppedWebCallbacks).put("droppedCommandCallbacks", node.droppedCommandCallbacks);
      android.webkit.WebBackForwardList history = web.copyBackForwardList();
      JSONArray entries = new JSONArray();
      for (int index = 0; index < history.getSize(); index++) {
        android.webkit.WebHistoryItem entry = history.getItemAtIndex(index);
        entries.put(new JSONObject().put("url", entry.getUrl()).put("originalUrl", entry.getOriginalUrl()));
      }
      state.put("history", new JSONObject().put("currentIndex", history.getCurrentIndex()).put("entries", entries));
    }
    return state;
  }
  String testDispatch(String request) {
    if (!BuildConfig.DEBUG) throw new IllegalStateException("Test hooks unavailable");
    String response = runtime.dispatch(host, request);
    try {
      String method = new JSONObject(request).optString("method");
      if ("runtime.pump".equals(method) || "app.event".equals(method)) observeRuntimeResponse(response, method);
    } catch (Exception e) { fail(e); }
    return response;
  }

  private void observeRuntimeResponse(String json, String operation) {
    try {
      JSONObject response = new JSONObject(json);
      if (response.has("error") && !response.isNull("error")) {
        fail(new IllegalStateException(operation + ": " + response.get("error").toString()));
        return;
      }
      JSONObject result = response.optJSONObject("result");
      if (result == null) return;
      JSONArray errors = result.optJSONArray("errors");
      if (errors != null && errors.length() > 0) fail(new IllegalStateException(operation + " asynchronous errors: " + errors.toString()));
      else if (result.optLong("suppressedErrors", 0) > 0) fail(new IllegalStateException(operation + " suppressed asynchronous errors: " + result.optLong("suppressedErrors")));
    } catch (Exception e) { fail(new IllegalStateException(operation + " returned an invalid response", e)); }
  }

  private void event(Node node, String event, JSONObject payload) {
    event(node, event, payload, null, -1);
  }

  private void event(Node node, String event, JSONObject payload, String document, int sourceGeneration) {
    if (applying || destroyed || nodes.get(node.id) != node) return;
    // Delegate callbacks may run synchronously inside a host command or commit.
    // Never enter Hermes until that native callback has returned.
    ui.post(() -> {
      if (destroyed || host == 0 || nodes.get(node.id) != node) return;
      if (document != null && (!document.equals(node.document) || sourceGeneration != node.sourceGeneration)) return;
      try {
        JSONObject params = new JSONObject().put("nodeId", node.id).put("event", event).put("payload", payload);
        observeRuntimeResponse(runtime.dispatch(host, new JSONObject().put("id", ++requestId).put("method", "app.event").put("params", params).toString()), "app.event:" + event);
      } catch (Exception e) { fail(e); }
    });
  }

  private String nativeCommand(String json) {
    try {
      if (Looper.myLooper() != Looper.getMainLooper()) return commandError("WRONG_THREAD", "Native command must execute on the UI thread");
      if (destroyed) return commandError("STALE_GENERATION", "Native host is destroyed");
      JSONObject command = new JSONObject(json);
      if (command.getInt("version") != 1) return commandError("UNSUPPORTED_VERSION", "Unsupported native command version");
      long generation = command.getLong("generation");
      if (generation <= 0 || (commandGeneration != 0 && generation != commandGeneration)) return commandError("STALE_GENERATION", "Native runtime generation changed");
      // The C++ boundary already validates generation before entering this
      // callback, including commands emitted while create() is still running.
      commandGeneration = generation;
      Node node = nodes.get(command.getInt("nodeId"));
      if (node == null || node.view.getParent() == null) return commandError("STALE_NODE", "Native command target is no longer mounted");
      String name = command.getString("name");
      JSONObject args = command.getJSONObject("args");
      if ("TextInput".equals(node.type)) {
        EditText input = (EditText) node.view;
        InputMethodManager keyboard = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        switch (name) {
          case "focus":
            if (!input.isEnabled() || !input.requestFocus()) return commandError("FOCUS_REJECTED", "Native input could not accept focus");
            keyboard.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT); break;
          case "blur":
            input.clearFocus(); surface.requestFocus(); keyboard.hideSoftInputFromWindow(input.getWindowToken(), 0); break;
          case "clear": {
            boolean previous = applying; applying = true;
            try { input.setText(""); } finally { applying = previous; }
            break;
          }
          default: return commandError("UNSUPPORTED_COMMAND", "Unsupported TextInput command");
        }
      } else if ("ScrollView".equals(node.type)) {
        ScrollView scroll = (ScrollView) node.view;
        int x, y;
        if ("scrollTo".equals(name)) { x = px(args.optDouble("x", 0)); y = px(args.optDouble("y", 0)); }
        else if ("scrollToEnd".equals(name)) { x = scroll.getScrollX(); y = Math.max(0, node.children.getHeight() - scroll.getHeight()); }
        else return commandError("UNSUPPORTED_COMMAND", "Unsupported ScrollView command");
        if (args.optBoolean("animated", true)) scroll.smoothScrollTo(x, y); else scroll.scrollTo(x, y);
      } else if ("WebView".equals(node.type)) {
        WebView web = (WebView) node.view;
        switch (name) {
          // Same-document history retains its bridge. A real document
          // navigation invalidates the token in onPageStarted instead.
          case "goBack": if (web.canGoBack()) web.goBack(); break;
          case "goForward": if (web.canGoForward()) web.goForward(); break;
          case "reload": invalidateDocument(node); web.reload(); break;
          case "stopLoading": web.stopLoading(); break;
          case "postMessage":
          case "injectJavaScript": {
            if (!node.documentReady || node.document.isEmpty()) return commandError("DOCUMENT_NOT_READY", "WebView document has not finished bridge setup");
            String source = "postMessage".equals(name)
                ? "window.dispatchEvent(new MessageEvent('message',{data:" + JSONObject.quote(args.getString("data")) + "}));"
                : args.getString("source");
            evaluateDocumentCommand(node, web, name, source); break;
          }
          default: return commandError("UNSUPPORTED_COMMAND", "Unsupported WebView command");
        }
      } else return commandError("UNSUPPORTED_COMMAND", "Primitive has no native commands");
      return "{\"result\":null}";
    } catch (Exception error) { return commandError("ANDROID_COMMAND_ERROR", error.toString()); }
  }

  private static String commandError(String code, String message) {
    try { return new JSONObject().put("error", new JSONObject().put("code", code).put("message", message.length() > 700 ? message.substring(0, 700) : message)).toString(); }
    catch (Exception ignored) { return "{\"error\":{\"code\":\"ANDROID_COMMAND_ERROR\",\"message\":\"Unable to encode command error\"}}"; }
  }

  private void invalidateDocument(Node node) { node.document = ""; node.documentReady = false; node.sourceGeneration++; }

  private void evaluateDocumentCommand(Node node, WebView web, String name, String source) throws Exception {
    String document = node.document; int generation = node.sourceGeneration;
    String script = "(function(){if(window.__nativeHostDocument!==" + JSONObject.quote(document) + ")return {stale:true};try{(0,eval)(" + JSONObject.quote(source) + ");return {ok:true}}catch(e){return {error:String(e)}}})()";
    web.evaluateJavascript(script, result -> {
      if (destroyed || nodes.get(node.id) != node || generation != node.sourceGeneration || !document.equals(node.document)) { node.droppedWebCallbacks++; node.droppedCommandCallbacks++; return; }
      try {
        JSONObject outcome = new JSONObject(result);
        if (outcome.has("error")) event(node, "error", new JSONObject().put("operation", name).put("description", outcome.getString("error")).put("documentGeneration", node.navigation), document, generation);
      } catch (Exception error) { fail(new IllegalStateException("Invalid WebView command result", error)); }
    });
  }

  private void commit(String json) {
    if (destroyed) return;
    try {
      JSONObject root = new JSONObject(json);
      applying = true;
      Set<Integer> alive = new HashSet<>();
      JSONArray children = root.optJSONArray("children");
      reconcile(children == null ? new JSONArray() : children, surface, 0, 0, alive);
      for (Integer id : new HashSet<>(nodes.keySet())) {
        if (!alive.contains(id)) dispose(nodes.remove(id));
      }
      snapshot = json;
    } catch (Exception e) { fail(e); }
    finally { applying = false; }
  }

  private void reconcile(JSONArray list, ViewGroup parent, double parentX, double parentY, Set<Integer> alive) throws Exception {
    int index = 0;
    for (int i = 0; i < list.length(); i++) {
      JSONObject data = list.getJSONObject(i);
      String type = data.getString("type");
      if ("#text".equals(type)) continue;
      int id = data.getInt("id");
      Node node = nodes.get(id);
      if (node != null && !type.equals(node.type)) { dispose(node); nodes.remove(id); node = null; }
      if (node == null) { node = createNode(id, type); nodes.put(id, node); }
      alive.add(id);
      if (node.view.getParent() != parent) {
        if (node.view.getParent() instanceof ViewGroup) ((ViewGroup) node.view.getParent()).removeView(node.view);
        parent.addView(node.view, Math.min(index, parent.getChildCount()));
      } else if (parent.indexOfChild(node.view) != index) {
        parent.removeView(node.view); parent.addView(node.view, Math.min(index, parent.getChildCount()));
      }
      index++;
      JSONObject bounds = data.optJSONObject("bounds");
      double x = bounds == null ? 0 : bounds.optDouble("x");
      double y = bounds == null ? 0 : bounds.optDouble("y");
      double w = bounds == null ? 0 : bounds.optDouble("width");
      double h = bounds == null ? 0 : bounds.optDouble("height");
      FrameLayout.LayoutParams layout = new FrameLayout.LayoutParams(px(w), px(h));
      layout.leftMargin = px(x - parentX); layout.topMargin = px(y - parentY);
      node.view.setLayoutParams(layout);
      JSONObject props = data.optJSONObject("props");
      node.props = props == null ? new JSONObject() : props;
      updateNode(node, data);
      JSONArray nested = data.optJSONArray("children");
      if (node.children != null && nested != null) {
        reconcile(nested, node.children, x, y, alive);
        if (node.view instanceof ScrollView) {
          double extent = h;
          for (int c = 0; c < nested.length(); c++) {
            JSONObject cb = nested.getJSONObject(c).optJSONObject("bounds");
            if (cb != null) extent = Math.max(extent, cb.optDouble("y") - y + cb.optDouble("height"));
          }
          node.children.setLayoutParams(new ScrollView.LayoutParams(px(w), px(extent)));
        }
      }
    }
  }

  private Node createNode(int id, String type) {
    View view;
    switch (type) {
      case "Text": view = new TextView(this); ((TextView) view).setIncludeFontPadding(false); break;
      case "TextInput": view = new EditText(this); break;
      case "Image": view = new ImageView(this); break;
      case "ScrollView": view = new ScrollView(this); break;
      case "WebView": view = new WebView(this); break;
      case "View": case "Pressable": view = new FrameLayout(this); break;
      default: throw new IllegalArgumentException("Unsupported native primitive: " + type);
    }
    Node node = new Node(id, type, view);
    view.setTag(id);
    if (view instanceof FrameLayout) node.children = (FrameLayout) view;
    if (view instanceof ScrollView) {
      node.children = new FrameLayout(this);
      ((ScrollView) view).addView(node.children);
      view.setOnScrollChangeListener((v, x, y, oldX, oldY) -> {
        try { event(node, "scroll", new JSONObject()
            .put("contentOffset", new JSONObject().put("x", x / density).put("y", y / density))
            .put("contentSize", new JSONObject().put("width", node.children.getWidth() / density).put("height", node.children.getHeight() / density))
            .put("layoutMeasurement", new JSONObject().put("width", view.getWidth() / density).put("height", view.getHeight() / density))); }
        catch (Exception error) { fail(error); }
      });
    }
    if ("Pressable".equals(type)) {
      view.setClickable(true); view.setFocusable(true);
      view.setOnClickListener(v -> event(node, "press", new JSONObject()));
    }
    if (view instanceof EditText) {
      ((EditText) view).addTextChangedListener(new TextWatcher() {
        public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
        public void onTextChanged(CharSequence s, int start, int before, int count) {
          // Programmatic commits and ref.clear() are silent. Count native
          // edits before queueing so older JS echoes cannot replace later input.
          if (applying || destroyed || nodes.get(node.id) != node) return;
          try {
            if (node.nativeTextEventCount >= 9007199254740991L) throw new IllegalStateException("Native text event counter exhausted");
            event(node, "changeText", new JSONObject().put("text", s.toString()).put("eventCount", ++node.nativeTextEventCount));
          } catch (Exception e) { fail(e); }
        }
        public void afterTextChanged(Editable text) {}
      });
      view.setOnFocusChangeListener((v, focused) -> event(node, focused ? "focus" : "blur", new JSONObject()));
      ((EditText) view).setOnEditorActionListener((input, actionId, key) -> {
        try { event(node, "submitEditing", new JSONObject().put("text", input.getText().toString())); }
        catch (Exception error) { fail(error); }
        return false;
      });
    }
    if (view instanceof WebView) setupWebView(node, (WebView) view);
    return node;
  }

  private void updateNode(Node node, JSONObject data) throws Exception {
    JSONObject props = node.props;
    JSONObject style = props.optJSONObject("style");
    if (style == null) style = new JSONObject();
    View view = node.view;
    view.setContentDescription(props.optString("accessibilityLabel", props.optString("testID", "")));
    view.setEnabled(!props.optBoolean("disabled", false));
    view.setAlpha((float) style.optDouble("opacity", 1));
    view.setBackgroundColor(color(style.optString("backgroundColor", "transparent"), Color.TRANSPARENT));
    view.setVisibility("none".equals(style.optString("display")) ? View.GONE : View.VISIBLE);
    if (view instanceof TextView) {
      TextView text = (TextView) view;
      text.setTextColor(color(style.optString("color", "#111111"), Color.BLACK));
      text.setTextSize((float) style.optDouble("fontSize", 14));
      text.setGravity("center".equals(style.optString("textAlign")) ? Gravity.CENTER : Gravity.TOP | Gravity.START);
      if (view instanceof EditText) {
        EditText input = (EditText) view;
        if (props.has("value") || !node.inputInitialized) {
          String value = props.optString("value", props.optString("defaultValue", ""));
          Object acknowledgement = props.opt("mostRecentEventCount");
          boolean current = acknowledgement == null ? node.nativeTextEventCount == 0
              : acknowledgement instanceof Number
                  && ((Number) acknowledgement).doubleValue() == node.nativeTextEventCount;
          if (!props.has("value") || current) {
            if (!value.contentEquals(input.getText())) { input.setText(value); input.setSelection(value.length()); }
          } else if (!value.contentEquals(input.getText())) node.rejectedTextUpdates++;
          node.inputInitialized = true;
        }
        input.setHint(props.optString("placeholder", ""));
        input.setSingleLine(!props.optBoolean("multiline", false));
      } else text.setText(textContent(data));
    }
    if (view instanceof ImageView) updateImage(node, (ImageView) view);
    if (view instanceof WebView) updateWebSource(node, (WebView) view);
  }

  private String textContent(JSONObject node) {
    JSONObject props = node.optJSONObject("props");
    StringBuilder result = new StringBuilder();
    if ("#text".equals(node.optString("type"))) {
      return props == null ? node.optString("text", "") : props.optString("text", props.optString("value", ""));
    }
    if (props != null && props.has("text")) result.append(props.optString("text"));
    JSONArray children = node.optJSONArray("children");
    if (children != null) for (int i = 0; i < children.length(); i++) result.append(textContent(children.optJSONObject(i)));
    return result.toString();
  }

  private void updateImage(Node node, ImageView view) {
    JSONObject source = node.props.optJSONObject("source");
    String uri = source == null ? "" : source.optString("uri", "");
    if (uri.equals(node.source)) return;
    node.source = uri; view.setImageDrawable(null);
    view.setScaleType(ImageView.ScaleType.FIT_CENTER);
    if (uri.isEmpty()) return;
    images.execute(() -> {
      try {
        byte[] bytes;
        if (uri.startsWith("data:image/")) bytes = android.util.Base64.decode(uri.substring(uri.indexOf(',') + 1), android.util.Base64.DEFAULT);
        else {
          if (!uri.startsWith("https://")) throw new IllegalArgumentException("Only HTTPS/data images are supported");
          URLConnection connection = new URL(uri).openConnection();
          connection.setConnectTimeout(10000); connection.setReadTimeout(10000);
          try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[8192]; int count;
            while ((count = input.read(chunk)) != -1) {
              if (output.size() + count > 16 * 1024 * 1024) throw new IllegalArgumentException("Image exceeds prototype size limit");
              output.write(chunk, 0, count);
            }
            bytes = output.toByteArray();
          }
        }
        android.graphics.Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        ui.post(() -> { if (!destroyed && nodes.get(node.id) == node && uri.equals(node.source)) view.setImageBitmap(bitmap); });
      } catch (Exception e) { android.util.Log.w("NativeHost", "Image load failed", e); }
    });
  }

  private void setupWebView(Node node, WebView web) {
    web.getSettings().setJavaScriptEnabled(true);
    web.getSettings().setAllowFileAccess(false);
    web.getSettings().setAllowContentAccess(false);
    web.addJavascriptInterface(new Object() {
      @JavascriptInterface public void postMessage(String document, String payload) {
        // This entry point executes on WebView's bridge thread. Validate only
        // immutable arguments here; view/node lifecycle belongs to the UI thread.
        if (!validBridgeMessage(document, payload)) return;
        ui.post(() -> {
          if (!validBridgeMessage(document, payload) || destroyed || host == 0 || nodes.get(node.id) != node || !node.document.equals(document)) return;
          try { event(node, "message", new JSONObject().put("data", payload).put("documentGeneration", node.navigation), document, node.sourceGeneration); }
          catch (Exception e) { fail(e); }
        });
      }
    }, "NativeHostTransport");
    web.setWebViewClient(new WebViewClient() {
      @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
        if (destroyed || nodes.get(node.id) != node) return;
        if (staleInlineUrl(node, url)) { node.droppedWebCallbacks++; return; }
        node.navigation++; node.document = UUID.randomUUID().toString(); node.documentReady = false; node.loadingUrl = url;
        try {
          JSONObject state = webNavigation(node, view, url, true);
          event(node, "navigation", state, node.document, node.sourceGeneration);
          event(node, "loadStart", state, node.document, node.sourceGeneration);
        } catch (Exception e) { fail(e); }
      }
      @Override public void onPageFinished(WebView view, String url) {
        if (destroyed || nodes.get(node.id) != node) return;
        if (url == null || !url.equals(node.loadingUrl) || staleInlineUrl(node, url)) { node.droppedWebCallbacks++; return; }
        String document = node.document; int generation = node.sourceGeneration;
        String token = JSONObject.quote(document);
        view.evaluateJavascript("window.__nativeHostDocument=" + token + ";window.NativeHost={postMessage:function(s){NativeHostTransport.postMessage(" + token + ",String(s))}};window.ReactNativeWebView=window.NativeHost;true;", result -> {
          if (destroyed || nodes.get(node.id) != node || generation != node.sourceGeneration || !document.equals(node.document)) { node.droppedWebCallbacks++; return; }
          if (!"true".equals(result)) { fail(new IllegalStateException("WebView document bridge setup failed")); return; }
          node.documentReady = true;
          try {
            JSONObject state = webNavigation(node, view, url, false);
            event(node, "navigation", state, document, generation);
            event(node, "load", state, document, generation);
            event(node, "loadEnd", state, document, generation);
          } catch (Exception e) { fail(e); }
        });
      }
      @Override public void doUpdateVisitedHistory(WebView view, String url, boolean reload) {
        if (destroyed || nodes.get(node.id) != node || !node.documentReady) return;
        if (staleInlineUrl(node, url)) { node.droppedWebCallbacks++; return; }
        InlineDocument current = node.inlineDocument;
        String documentUrl = withoutFragment(url);
        if (current != null && documentUrl.startsWith(current.url)) {
          // A native history callback establishes the current same-document
          // alias. Keep exactly one alias, not every URL visited by the page.
          node.inlineDocument = new InlineDocument(current.url, current.html, documentUrl);
        }
        try { event(node, "navigation", webNavigation(node, view, url, false), node.document, node.sourceGeneration); }
        catch (Exception error) { fail(error); }
      }
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        // One immutable resource per node. Background requests atomically read
        // URL+HTML together; source replacement releases the previous resource.
        InlineDocument document = node.inlineDocument;
        String url = withoutFragment(request.getUrl().toString());
        if (request.isForMainFrame() && document != null
            && (document.url.equals(url) || document.currentDocumentUrl.equals(url))) {
          return new WebResourceResponse("text/html", "UTF-8", new ByteArrayInputStream(document.html.getBytes(StandardCharsets.UTF_8)));
        }
        if (isInlineUrl(url)) return new WebResourceResponse("text/plain", "UTF-8", 410, "Gone", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
        return null;
      }
      @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (!request.isForMainFrame() || destroyed || nodes.get(node.id) != node) return;
        if (staleInlineUrl(node, request.getUrl().toString())) { node.droppedWebCallbacks++; return; }
        try { event(node, "error", new JSONObject().put("url", request.getUrl().toString()).put("code", error.getErrorCode()).put("description", error.getDescription().toString()).put("documentGeneration", node.navigation), node.document, node.sourceGeneration); }
        catch (Exception failure) { fail(failure); }
      }
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        String scheme = request.getUrl().getScheme();
        return !("https".equals(scheme) || "about".equals(scheme));
      }
    });
  }

  private JSONObject webNavigation(Node node, WebView view, String url, boolean loading) throws Exception {
    return new JSONObject().put("url", url).put("loading", loading).put("canGoBack", view.canGoBack()).put("canGoForward", view.canGoForward()).put("documentGeneration", node.navigation);
  }

  private static boolean validBridgeMessage(String document, String payload) {
    return document != null && document.length() == 36 && payload != null && payload.length() <= 1048576;
  }

  private static String withoutFragment(String url) {
    if (url == null) return "";
    int fragment = url.indexOf('#');
    return fragment < 0 ? url : url.substring(0, fragment);
  }
  private static boolean isInlineUrl(String url) { return url != null && url.startsWith(INLINE_ORIGIN + "/"); }
  private static boolean staleInlineUrl(Node node, String url) {
    InlineDocument current = node.inlineDocument;
    // Relative same-document paths/query changes remain within this source's
    // unique directory. A previous source's directory never becomes current.
    return isInlineUrl(url) && (current == null || !withoutFragment(url).startsWith(current.url));
  }

  private void updateWebSource(Node node, WebView web) {
    JSONObject source = node.props.optJSONObject("source");
    String value = source == null ? "" : source.toString();
    if (node.source.equals(value)) return;
    node.source = value; invalidateDocument(node);
    node.inlineDocument = source != null && source.has("html")
        ? new InlineDocument(INLINE_ORIGIN + "/" + hostSessionId + "/" + node.id + "/" + UUID.randomUUID() + "/", source.optString("html")) : null;
    // Serve this node's inline document through its scoped request interceptor.
    // loadDataWithBaseURL creates data-backed history entries whose fragment
    // URLs are not restored by native back/forward on current Android WebView.
    if (node.inlineDocument != null) web.loadUrl(node.inlineDocument.url);
    else if (source != null && source.optString("uri").startsWith("https://")) web.loadUrl(source.optString("uri"));
    else web.loadUrl("about:blank");
  }

  private void dispose(Node node) {
    if (node == null) return;
    invalidateDocument(node); node.inlineDocument = null;
    if (node.view.getParent() instanceof ViewGroup) ((ViewGroup) node.view.getParent()).removeView(node.view);
    if (node.view instanceof WebView) {
      WebView web = (WebView) node.view;
      web.stopLoading(); web.removeJavascriptInterface("NativeHostTransport"); web.setWebViewClient(null); web.destroy();
    }
  }
  private int px(double value) { return (int) Math.round(value * density); }
  private static int color(String value, int fallback) { try { return Color.parseColor(value); } catch (Exception e) { return fallback; } }

  static HostActivity activeInstance() { return active.get(); }
  long ownerHandle(long generation) {
    if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Host access requires its owner thread");
    return !destroyed && generation == appStateGeneration ? host : 0;
  }
  void prepareForReload() { releaseHost(); finish(); }
  private void releaseHost() {
    if (destroyed) return;
    if (bootstrap != null) bootstrap.close();
    devUpdates.close();
    destroyed = true; appState.close(); ui.removeCallbacksAndMessages(null);
    if (host != 0) { runtime.destroy(host); host = 0; }
    for (Node node : nodes.values()) dispose(node);
    nodes.clear(); images.shutdownNow();
    if (active.get() == this) active.clear();
  }
  @Override protected void onDestroy() {
    releaseHost();
    super.onDestroy();
  }
}
