package dev.nativehost;

import android.app.Instrumentation;
import android.os.SystemClock;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebResourceError;
import android.widget.FrameLayout;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;

/** White-box adapter lifetime regression. Not a React/system-input E2E test. */
final class InlineSourceRace {
  private static final int NODE_ID = 2147483000;
  private static final String TEST_ID = "inline-race-probe";
  private final Instrumentation instrumentation;
  private final HostActivity app;
  private final JSONArray callbacks = new JSONArray();
  private Object node;
  private WebView web;
  private int assertions;
  private interface Query<T> { T run() throws Exception; }
  InlineSourceRace(Instrumentation instrumentation, HostActivity app) { this.instrumentation = instrumentation; this.app = app; }

  JSONObject run() throws Exception {
    try {
      onUi(() -> {
        eval("globalThis.__inlineRaceEvents=[];globalThis.__inlineRaceDispatch=globalThis.__nhDispatch;globalThis.__nhDispatch=function(method,params){if(method==='app.event'&&params.nodeId===" + NODE_ID + "){__inlineRaceEvents.push(params);return true;}return __inlineRaceDispatch(method,params)};true");
        node = invoke(app, "createNode", new Class<?>[]{int.class, String.class}, NODE_ID, "WebView");
        web = (WebView) field(node, "view");
        nodes().put(NODE_ID, node);
        FrameLayout surface = (FrameLayout) field(app, "surface");
        surface.addView(web, new FrameLayout.LayoutParams(300, 150));
        WebViewClient delegate = web.getWebViewClient();
        web.setWebViewClient(new WebViewClient() {
          private void record(String event, String url) {
            try { callbacks.put(new JSONObject().put("event", event).put("url", url)); }
            catch (Exception error) { throw new IllegalStateException(error); }
          }
          @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) { record("started", url); delegate.onPageStarted(view, url, icon); }
          @Override public void onPageFinished(WebView view, String url) { record("finished", url); delegate.onPageFinished(view, url); }
          @Override public void doUpdateVisitedHistory(WebView view, String url, boolean reload) { delegate.doUpdateVisitedHistory(view, url, reload); }
          @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) { return delegate.shouldInterceptRequest(view, request); }
          @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { delegate.onReceivedError(view, request, error); }
          @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return delegate.shouldOverrideUrlLoading(view, request); }
        });
        replace("A"); return null;
      });
      await(() -> messages().toString().contains("ready:A"), "real A document becomes ready");
      JSONObject initial = onUi(() -> app.testNodeState(TEST_ID));
      String oldToken = onUi(() -> (String) field(node, "document"));
      JSONArray requested = new JSONArray().put(initial.getString("inlineDocumentUrl"));
      onUi(() -> {
        eval("__inlineRaceEvents=[];true");
        queueCommandEval("window.NativeHost.postMessage('stale-eval:A')");
        replace("B"); requested.put(app.testNodeState(TEST_ID).getString("inlineDocumentUrl"));
        // Deliberately exercises the internal B-epoch callback guard. Public
        // nativeCommand rejects a document that is not ready, as tested in the
        // shared command boundary; this is not a successful B command claim.
        queueCommandEval("window.NativeHost.postMessage('stale-eval:B')");
        replace("C"); requested.put(app.testNodeState(TEST_ID).getString("inlineDocumentUrl"));
        return null;
      });
      await(() -> messages().toString().contains("ready:C"), "actual C document loads and delivers through Hermes");
      await(() -> onUi(() -> app.testNodeState(TEST_ID).getInt("droppedCommandCallbacks")) >= 2, "both prior native evaluation callbacks are dropped");
      require(!requested.getString(0).equals(requested.getString(1)) && !requested.getString(1).equals(requested.getString(2)), "each source receives a unique native URL");
      // This is explicit stale-token replay from the actual C document, not a
      // fabricated WebView load completion or direct Java event invocation.
      evaluate("NativeHostTransport.postMessage(" + JSONObject.quote(oldToken) + ",'stale-token:A');NativeHost.postMessage('current:C');true");
      await(() -> messages().toString().contains("current:C"), "current document message follows stale-token rejection");
      evaluate("Promise.all([" + JSONObject.quote(requested.getString(2)) + ","
          + JSONObject.quote(requested.getString(2) + "unregistered?probe=true") + ","
          + JSONObject.quote(requested.getString(0))
          + "].map(url=>fetch(url).then(response=>response.status))).then(statuses=>NativeHost.postMessage('resource-scope:'+statuses.join(',')));true");
      await(() -> messages().toString().contains("resource-scope:410,410,410"), "real subresource requests cannot retrieve current, arbitrary or stale inline documents");
      JSONArray accepted = messages();
      require(accepted.length() == 3 && "ready:C".equals(accepted.getString(0)) && "current:C".equals(accepted.getString(1))
          && "resource-scope:410,410,410".equals(accepted.getString(2)), "only current C messages are delivered to Hermes");
      JSONObject current = onUi(() -> app.testNodeState(TEST_ID));
      require(current.getString("inlineDocumentUrl").equals(requested.getString(2)), "native resource retains current URL");
      require(onUi(() -> html("C").equals(field(field(node, "inlineDocument"), "html"))), "single retained resource contains C HTML only");
      int retainedResources = onUi(() -> {
        int count = 0; Class<?> resourceType = field(node, "inlineDocument").getClass();
        for (Field item : node.getClass().getDeclaredFields()) {
          item.setAccessible(true);
          if (resourceType.isInstance(item.get(node))) count++;
        }
        return count;
      });
      require(retainedResources == 1, "adapter retains one current inline resource field");
      require(onUi(() -> app.testHealth().getBoolean("healthy")), "runtime stays healthy");
      return new JSONObject().put("assertions", assertions).put("kind", "white-box-native-lifecycle")
          .put("requestedUrls", requested).put("observedPlatformCallbacks", onUi(() -> new JSONArray(callbacks.toString())))
          .put("acceptedMessages", accepted).put("nativeState", current)
          .put("currentInlineResourceCount", retainedResources).put("publicCommandAdmissionExercised", false);
    } finally {
      onUi(() -> {
        if (node != null) { nodes().remove(NODE_ID); invoke(app, "dispose", new Class<?>[]{node.getClass()}, node); }
        eval("if(globalThis.__inlineRaceDispatch)globalThis.__nhDispatch=globalThis.__inlineRaceDispatch;true");
        return null;
      });
    }
  }

  private void replace(String name) throws Exception {
    setField(node, "props", new JSONObject().put("testID", TEST_ID).put("source", new JSONObject().put("html", html(name))));
    invoke(app, "updateWebSource", new Class<?>[]{node.getClass(), WebView.class}, node, web);
  }
  private static String html(String name) {
    return "<!doctype html><p>" + name + "</p><script>(function ready(){if(window.NativeHost)NativeHost.postMessage('ready:" + name + "');else setTimeout(ready,10)})()</script>";
  }
  private void queueCommandEval(String source) throws Exception {
    invoke(app, "evaluateDocumentCommand", new Class<?>[]{node.getClass(), WebView.class, String.class, String.class}, node, web, "injectJavaScript", source);
  }
  private Object eval(String source) throws Exception {
    JSONObject result = new JSONObject(app.testDispatch(new JSONObject().put("id", 9100).put("method", "runtime.eval").put("params", new JSONObject().put("source", source)).toString()));
    if (result.has("error")) throw new IllegalStateException(result.get("error").toString());
    return result.opt("result");
  }
  private JSONArray messages() throws Exception {
    return (JSONArray) onUi(() -> eval("__inlineRaceEvents.filter(e=>e.event==='message').map(e=>e.payload.data)"));
  }
  private void evaluate(String script) throws Exception {
    CountDownLatch done = new CountDownLatch(1);
    onUi(() -> { web.evaluateJavascript(script, result -> done.countDown()); return null; });
    require(done.await(5, TimeUnit.SECONDS), "real browser evaluation completes");
  }
  @SuppressWarnings("unchecked") private Map<Integer, Object> nodes() throws Exception { return (Map<Integer, Object>) field(app, "nodes"); }
  private static Object field(Object owner, String name) throws Exception { Field field = owner.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(owner); }
  private static void setField(Object owner, String name, Object value) throws Exception { Field field = owner.getClass().getDeclaredField(name); field.setAccessible(true); field.set(owner, value); }
  private static Object invoke(Object owner, String name, Class<?>[] types, Object... args) throws Exception { Method method = owner.getClass().getDeclaredMethod(name, types); method.setAccessible(true); return method.invoke(owner, args); }
  private <T> T onUi(Query<T> query) throws Exception {
    AtomicReference<T> value = new AtomicReference<>(); AtomicReference<Exception> failure = new AtomicReference<>();
    instrumentation.runOnMainSync(() -> { try { value.set(query.run()); } catch (Exception error) { failure.set(error); } });
    if (failure.get() != null) throw failure.get();
    return value.get();
  }
  private void await(Query<Boolean> condition, String message) throws Exception {
    long deadline = SystemClock.uptimeMillis() + 15000;
    while (SystemClock.uptimeMillis() < deadline) {
      if (condition.run()) { assertions++; return; }
      String failure = onUi(() -> app.testFailure()); if (failure != null) throw new AssertionError(failure);
      Thread.sleep(20);
    }
    throw new AssertionError("Timed out: " + message + "; callbacks=" + onUi(() -> callbacks.toString()));
  }
  private void require(boolean value, String message) { assertions++; if (!value) throw new AssertionError(message); }
}
