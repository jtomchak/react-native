package dev.nativehost;

import android.app.Instrumentation;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/** Real framed transport/C ABI regression; does not claim compiler/React Refresh coverage. */
final class DevTransportRegression {
  private final Instrumentation instrumentation;
  private final File configFile, receiptFile;
  private final String token, session;
  private HostActivity app;
  private int port, assertions;
  private String generation;
  private interface Query<T> { T run() throws Exception; }
  private DevTransportRegression(Instrumentation instrumentation, File config, File receipt, String token, String session) {
    this.instrumentation = instrumentation; this.configFile = config; this.receiptFile = receipt; this.token = token; this.session = session;
  }
  static DevTransportRegression prepare(Instrumentation instrumentation) throws Exception {
    Context context = instrumentation.getTargetContext(); File files = context.getFilesDir();
    File config = new File(files, "native-dev-session.json"), receipt = new File(files, "native-dev-ready.json");
    if (config.exists() || receipt.exists()) throw new IllegalStateException("Transport regression requires no existing developer config or receipt");
    byte[] auth = new byte[32], id = new byte[16]; SecureRandom random = new SecureRandom(); random.nextBytes(auth); random.nextBytes(id); id[0] |= 1;
    String token = hex(auth), session = hex(id); MessageDigest digest = MessageDigest.getInstance("SHA-256");
    try (InputStream input = context.getAssets().open("app.bundle.js")) { byte[] block = new byte[8192]; int count; while ((count = input.read(block)) != -1) digest.update(block, 0, count); }
    JSONObject value = new JSONObject().put("schemaVersion", 1).put("token", token).put("sessionId", session).put("initialRevision", "packaged").put("initialBundleSha256", hex(digest.digest())).put("port", 0);
    try (java.io.FileOutputStream output = context.openFileOutput(config.getName(), Context.MODE_PRIVATE)) { output.write(value.toString().getBytes(StandardCharsets.UTF_8)); }
    return new DevTransportRegression(instrumentation, config, receipt, token, session);
  }
  JSONObject run(HostActivity activity) throws Exception {
    app = activity;
    try {
      JSONObject receipt = new JSONObject(new String(Files.readAllBytes(receiptFile.toPath()), StandardCharsets.UTF_8));
      require("ready".equals(receipt.getString("status")) && session.equals(receipt.getString("sessionId")), "real startup publishes this session receipt");
      require(!receipt.toString().contains(token), "receipt contains no authentication token");
      port = receipt.getInt("port"); generation = receipt.getString("generation");
      try (Client bad = new Client(false)) {
        require(bad.call(new JSONObject().put("method", "authenticate").put("token", "0000000000000000000000000000000000000000000000000000000000000000")).has("error"), "bad authentication rejects before native calls");
      }
      try (Client unauthorized = new Client(false)) { require(unauthorized.call(new JSONObject().put("method", "dev.status")).has("error"), "status requires authentication"); }
      try (Client bounds = new Client(true)) { bounds.output.writeInt(DevUpdateProtocol.MAX_FRAME + 1); bounds.output.flush(); require(bounds.closed(), "oversized length closes without reading/allocating body"); }
      try (Client partial = new Client(true)) { partial.output.writeInt(100); partial.output.writeByte('{'); partial.output.flush(); }
      try (Client trickle = new Client(true)) {
        trickle.output.writeInt(10000); trickle.output.flush();
        long began = SystemClock.uptimeMillis();
        Thread writer = new Thread(() -> {
          try { while (SystemClock.uptimeMillis() - began < 6500) { trickle.output.writeByte(' '); trickle.output.flush(); Thread.sleep(10); } }
          catch (Exception closed) {}
        }, "NativeHostTestTrickle");
        writer.start();
        require(trickle.closed(), "continuously trickled partial body closes at absolute deadline");
        long elapsed = SystemClock.uptimeMillis() - began;
        trickle.close(); writer.join(1000);
        require(elapsed >= 4500 && elapsed < 6500, "partial body deadline remains five seconds despite progress");
      }
      try (Client client = new Client(true)) {
        require(client.callRaw("{\"method\":\"dev.status\",\"method\":\"dev.drain\"}").has("error"), "duplicate keys rejected");
        require(client.callRaw("{\"method\":\"runtime.eval\",\"source\":\"1\"}").has("error"), "no runtime/application forwarding surface");
        require(client.callRaw("{\"method\":\"dev.status\",\"extra\":true}").has("error"), "unknown fields and non-schema value types rejected");
        JSONObject initial = client.status();
        require(initial.getBoolean("opened") && "0".equals(initial.getString("acceptedSequence")) && !initial.getBoolean("pending"), "partial and invalid frames leave native session unchanged");
        JSONObject patch = patch("1", "packaged", "transport-one");
        JSONObject wrong = new JSONObject(patch.toString()).put("payloadSha256", "0000000000000000000000000000000000000000000000000000000000000000");
        require(client.call(wrong).has("error"), "native digest validation rejects corrupted payload");
        require(client.call(new JSONObject(patch.toString()).put("generation", Long.toString(Long.parseLong(generation) + 1))).has("error"), "stale generation rejected");
        require(client.call(new JSONObject(patch.toString()).put("sequence", "01")).has("error"), "noncanonical u64 rejected before native ingress");
        require("queued".equals(client.call(patch).getJSONObject("result").getString("status")), "valid UTF8 binary patch queued");
        require(client.status().getBoolean("pending"), "enqueue does not execute or drain");
        JSONObject applied = client.call(new JSONObject().put("method", "dev.drain")).getJSONObject("result");
        require("applied".equals(applied.getString("status")), "separate owner task drains actual Hermes patch");
        require("applied".equals(client.call(patch).getJSONObject("result").getString("status")), "identical retry replays terminal result without reexecution");
        require("transport-one".equals(client.status().getString("revision")), "applied native revision advances");
      }
      cancelledQueuedRequest(false);
      try (Client client = new Client(true)) { require("1".equals(client.status().getString("acceptedSequence")), "disconnected queued request never reaches native ingress"); }
      cancelledQueuedRequest(true);
      require(!onUi(() -> app.testHasRuntime()), "host destroyed after invalidating queued transport task");
      return new JSONObject().put("kind", "real-loopback-framed-dev-ingress").put("assertions", assertions)
          .put("sessionId", session).put("generation", generation).put("port", port)
          .put("compilerRefreshClaim", false).put("queuedDisconnectCancelled", true).put("queuedDestroyCancelled", true);
    } finally { cleanup(); }
  }
  private void cancelledQueuedRequest(boolean destroy) throws Exception {
    Object transport = field(app, "devUpdates");
    CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
    new Handler(Looper.getMainLooper()).post(() -> { entered.countDown(); try { release.await(5, TimeUnit.SECONDS); } catch (InterruptedException ignored) {} });
    require(entered.await(2, TimeUnit.SECONDS), "owner thread held for deterministic queued-lifetime regression");
    Client client = null;
    try {
      // Authenticate without scheduling any owner work while the UI is held.
      client = new Client(true);
      if (destroy) new Handler(Looper.getMainLooper()).post(() -> app.prepareForReload());
      client.send(patch("2", "transport-one", "transport-two"));
      await(() -> field(transport, "pendingTask") != null, "request is actually queued for owner thread");
      Object queued = field(transport, "pendingTask");
      if (!destroy) {
        client.close(); client = null;
        await(() -> field(transport, "pendingTask") == null, "network observes disconnect and removes queued task");
        release.countDown();
      } else {
        release.countDown();
        await(() -> !onUi(() -> app.testHasRuntime()), "earlier destruction task closes listener before host destroy");
        require(client.closed(), "destroy closes active network connection");
      }
      require(!((Boolean) field(queued, "finished")), "cancelled owner runnable never executes");
    } finally { release.countDown(); if (client != null) client.close(); }
  }
  private JSONObject patch(String sequence, String base, String target) throws Exception {
    byte[] payload = "globalThis.__transportRuns=(globalThis.__transportRuns||0)+1;globalThis.__transportText='quoted 🦀';({status:globalThis.__transportRuns===1&&globalThis.__transportText==='quoted 🦀'?'applied':'invalid'})".getBytes(StandardCharsets.UTF_8);
    return new JSONObject().put("method", "dev.enqueue").put("generation", generation).put("sessionId", session).put("sequence", sequence)
        .put("baseRevision", base).put("targetRevision", target).put("payloadSha256", hex(MessageDigest.getInstance("SHA-256").digest(payload))).put("payloadHex", hex(payload));
  }
  void cleanup() throws Exception {
    if (app != null) onUi(() -> { app.prepareForReload(); return null; });
    if (configFile.exists()) {
      JSONObject config = new JSONObject(new String(Files.readAllBytes(configFile.toPath()), StandardCharsets.UTF_8));
      if (session.equals(config.optString("sessionId"))) Files.delete(configFile.toPath());
    }
    if (receiptFile.exists()) {
      JSONObject receipt = new JSONObject(new String(Files.readAllBytes(receiptFile.toPath()), StandardCharsets.UTF_8));
      if (session.equals(receipt.optString("sessionId"))) Files.delete(receiptFile.toPath());
    }
  }
  private final class Client implements AutoCloseable {
    final Socket socket; final DataInputStream input; final DataOutputStream output;
    Client(boolean authenticate) throws Exception {
      socket = new Socket(InetAddress.getByName("127.0.0.1"), port); socket.setSoTimeout(7000); socket.setTcpNoDelay(true);
      input = new DataInputStream(socket.getInputStream()); output = new DataOutputStream(socket.getOutputStream());
      if (authenticate && !call(new JSONObject().put("method", "authenticate").put("token", token)).getJSONObject("result").getBoolean("authenticated")) throw new IllegalStateException("Test authentication failed");
    }
    void send(JSONObject value) throws Exception { byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8); output.writeInt(bytes.length); output.write(bytes); output.flush(); }
    JSONObject call(JSONObject value) throws Exception { send(value); return read(); }
    JSONObject callRaw(String value) throws Exception { byte[] bytes = value.getBytes(StandardCharsets.UTF_8); output.writeInt(bytes.length); output.write(bytes); output.flush(); return read(); }
    JSONObject read() throws Exception { int size = input.readInt(); if (size <= 0 || size > DevUpdateProtocol.MAX_FRAME) throw new IllegalStateException("Invalid native response frame"); byte[] bytes = new byte[size]; input.readFully(bytes); return new JSONObject(new String(bytes, StandardCharsets.UTF_8)); }
    JSONObject status() throws Exception { return call(new JSONObject().put("method", "dev.status")).getJSONObject("result"); }
    boolean closed() throws Exception { try { return input.read() == -1; } catch (java.net.SocketException closed) { return true; } }
    @Override public void close() throws Exception { socket.close(); }
  }
  private static String hex(byte[] bytes) { StringBuilder result = new StringBuilder(bytes.length * 2); for (byte value : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255)); return result.toString(); }
  private static Object field(Object owner, String name) throws Exception { Field field = owner.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(owner); }
  private <T> T onUi(Query<T> query) throws Exception {
    AtomicReference<T> value = new AtomicReference<>(); AtomicReference<Exception> failure = new AtomicReference<>();
    instrumentation.runOnMainSync(() -> { try { value.set(query.run()); } catch (Exception error) { failure.set(error); } });
    if (failure.get() != null) throw failure.get(); return value.get();
  }
  private void await(Query<Boolean> condition, String message) throws Exception {
    long deadline = SystemClock.uptimeMillis() + 2000;
    while (SystemClock.uptimeMillis() < deadline) { if (condition.run()) { assertions++; return; } Thread.sleep(5); }
    throw new AssertionError("Timed out: " + message);
  }
  private void require(boolean value, String message) { assertions++; if (!value) throw new AssertionError(message); }
}
