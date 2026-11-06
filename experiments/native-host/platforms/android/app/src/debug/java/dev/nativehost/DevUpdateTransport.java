package dev.nativehost;

import android.os.Handler;
import android.os.Process;
import android.os.SystemClock;
import java.io.EOFException;
import java.io.File;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.lang.ref.WeakReference;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.SeekableByteChannel;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/** Debug-only framed loopback ingress, independent of instrumentation/test hooks. */
final class DevUpdateTransport {
  private static final long AUTH_MS = 5000, IDLE_MS = 60000, BODY_MS = 5000, OWNER_MS = 10000;
  private final Object lifetime = new Object();
  private final AtomicBoolean active = new AtomicBoolean(false);
  private WeakReference<HostActivity> activity = new WeakReference<>(null);
  private Handler owner;
  private long generation;
  private DevUpdateProtocol.Config config;
  private volatile ServerSocketChannel listener;
  private volatile SocketChannel client;
  private volatile AtomicBoolean clientAlive;
  private volatile OwnerTask pendingTask;
  private Thread worker;

  void start(HostActivity current, Handler handler, long hostGeneration, String selectedRevision) {
    owner = handler; activity = new WeakReference<>(current); generation = hostGeneration;
    Path files = null;
    try {
      files = current.getFilesDir().getCanonicalFile().toPath();
      Path configPath = files.resolve("native-dev-session.json");
      // A receipt is a startup observation; a new startup never reuses old data.
      Files.deleteIfExists(files.resolve("native-dev-ready.json"));
      if (!Files.exists(configPath, LinkOption.NOFOLLOW_LINKS)) return;
      config = DevUpdateProtocol.config(readConfig(configPath));
      if (!config.initialRevision.equals(selectedRevision)) throw new IllegalArgumentException("Development revision differs from selected bundle");
      long handle = current.ownerHandle(generation);
      if (handle == 0) throw new IllegalStateException("Host lifetime ended before development startup");
      String opened = DevUpdateBridge.open(handle, Long.toUnsignedString(generation), DevUpdateProtocol.hex(config.sessionId), config.initialRevision, DevUpdateProtocol.hex(config.digest));
      JSONObject result = new JSONObject(opened);
      if (result.has("error")) throw new IllegalStateException("Native development session rejected: " + result.getJSONObject("error").optString("code"));
      if (!result.getJSONObject("result").getBoolean("opened")) throw new IllegalStateException("Native development session did not open");
      ServerSocketChannel server = ServerSocketChannel.open(); listener = server;
      server.socket().bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), config.port), 1);
      active.set(true);
      writeReceipt(files, server.socket().getLocalPort(), "ready", null);
      worker = new Thread(this::serve, "NativeHostDevUpdates"); worker.setDaemon(true); worker.start();
    } catch (Exception error) {
      close();
      if (files != null) {
        try { writeReceipt(files, 0, "error", "Development startup rejected: " + error.getClass().getSimpleName() + ": " + safeMessage(error)); }
        catch (Exception receiptError) { android.util.Log.e("NativeHost", "Unable to publish development startup receipt"); }
      }
    }
  }

  private static byte[] readConfig(Path path) throws Exception {
    if (Files.isSymbolicLink(path) || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)
        || !path.toFile().getCanonicalFile().toPath().equals(path)) throw new IOException("Configuration must be a canonical regular app-private file");
    ByteBuffer bytes = ByteBuffer.allocate(DevUpdateProtocol.MAX_CONFIG + 1);
    try (SeekableByteChannel channel = Files.newByteChannel(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
      while (bytes.hasRemaining() && channel.read(bytes) >= 0) {}
    }
    if (bytes.position() > DevUpdateProtocol.MAX_CONFIG) throw new IOException("Development configuration exceeds limit");
    byte[] result = new byte[bytes.position()]; bytes.flip(); bytes.get(result); return result;
  }
  private void writeReceipt(Path files, int port, String status, String error) throws Exception {
    JSONObject receipt = new JSONObject().put("schemaVersion", 1).put("port", port)
        .put("sessionId", config == null ? JSONObject.NULL : config.sessionId)
        .put("initialRevision", config == null ? JSONObject.NULL : config.initialRevision)
        .put("generation", Long.toUnsignedString(generation)).put("processId", Process.myPid()).put("status", status);
    if (error != null) receipt.put("error", new JSONObject().put("code", "DEV_TRANSPORT_START").put("message", error.length() > 512 ? error.substring(0, 512) : error));
    Path temporary = Files.createTempFile(files, "native-dev-ready-", ".tmp");
    try {
      Files.write(temporary, receipt.toString().getBytes(StandardCharsets.UTF_8), StandardOpenOption.TRUNCATE_EXISTING);
      Files.move(temporary, files.resolve("native-dev-ready.json"), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    } finally { Files.deleteIfExists(temporary); }
  }
  private static String safeMessage(Exception error) {
    // Parsing/authentication errors never include input values or credentials.
    String message = error.getMessage(); return message == null ? "No detail" : message;
  }

  private void serve() {
    try {
      while (active.get()) {
        SocketChannel socket = listener.accept();
        if (!active.get()) { socket.close(); break; }
        AtomicBoolean connection = new AtomicBoolean(true);
        client = socket; clientAlive = connection;
        try {
          socket.configureBlocking(false); socket.socket().setTcpNoDelay(true);
          boolean authenticated = false;
          while (active.get() && connection.get()) {
            byte[] frame = readFrame(socket, authenticated);
            DevUpdateProtocol.Request request;
            try { request = DevUpdateProtocol.request(frame); }
            catch (IllegalArgumentException invalid) {
              writeFrame(socket, DevUpdateProtocol.error("DEV_TRANSPORT_SCHEMA", "Invalid development transport schema"));
              if (!authenticated) break;
              continue;
            }
            if (!authenticated) {
              if (!"authenticate".equals(request.method) || !MessageDigest.isEqual(config.token.getBytes(StandardCharsets.US_ASCII), (request.token == null ? "" : request.token).getBytes(StandardCharsets.US_ASCII))) {
                writeFrame(socket, DevUpdateProtocol.error("DEV_AUTH", "Authentication required")); break;
              }
              authenticated = true; writeFrame(socket, "{\"id\":null,\"result\":{\"authenticated\":true}}");
              continue;
            }
            if ("authenticate".equals(request.method)) { writeFrame(socket, DevUpdateProtocol.error("DEV_TRANSPORT_SCHEMA", "Session already authenticated")); continue; }
            OwnerTask task = new OwnerTask(request, connection);
            pendingTask = task;
            if (!owner.postAtTime(task, lifetime, SystemClock.uptimeMillis())) throw new IOException("Owner queue unavailable");
            ByteBuffer probe = ByteBuffer.allocate(1);
            while (!task.finished && active.get() && connection.get()) {
              int extra = socket.read(probe);
              if (extra < 0) throw new EOFException("Client disconnected before owner acknowledgement");
              if (extra > 0) throw new IOException("Only one request may be in flight");
              if (System.nanoTime() > task.deadline) throw new InterruptedIOException("Owner acknowledgement timed out");
              pause();
            }
            if (!active.get() || !connection.get()) break;
            writeFrame(socket, task.response);
            pendingTask = null;
          }
        } catch (Exception ended) {
          // A failed/partial connection has no authority over future clients.
          // Closed sockets cancel queued tasks; already-running owner work can
          // complete and is recoverable through native duplicate replay.
        } finally {
          connection.set(false);
          OwnerTask queued = pendingTask;
          if (queued != null && queued.connection == connection) { owner.removeCallbacks(queued); pendingTask = null; }
          try { socket.close(); } catch (IOException ignored) {}
          if (client == socket) { client = null; clientAlive = null; }
        }
      }
    } catch (Exception stopped) {
      if (active.get()) android.util.Log.e("NativeHost", "Development listener stopped unexpectedly");
    } finally { closeSockets(); }
  }

  private final class OwnerTask implements Runnable {
    final DevUpdateProtocol.Request request;
    final AtomicBoolean connection;
    final long deadline = System.nanoTime() + OWNER_MS * 1000000L;
    volatile boolean finished;
    String response;
    OwnerTask(DevUpdateProtocol.Request request, AtomicBoolean connection) { this.request = request; this.connection = connection; }
    @Override public void run() {
      try {
        HostActivity current = activity.get();
        if (!active.get() || !connection.get() || System.nanoTime() > deadline || current == null) {
          response = DevUpdateProtocol.error("DEV_STALE_SESSION", "Development task lifetime ended"); return;
        }
        long handle = current.ownerHandle(generation);
        if (handle == 0) { response = DevUpdateProtocol.error("STALE_GENERATION", "Host lifetime ended"); return; }
        switch (request.method) {
          case "dev.status": response = DevUpdateBridge.status(handle); break;
          case "dev.drain": response = DevUpdateBridge.drain(handle); break;
          case "dev.enqueue":
            response = DevUpdateBridge.enqueue(handle, request.generation, request.session, request.sequence, request.base, request.target, request.digest, request.payload); break;
          default: response = DevUpdateProtocol.error("DEV_TRANSPORT_SCHEMA", "Unsupported owner request");
        }
      } catch (Exception error) {
        response = DevUpdateProtocol.error("DEV_TRANSPORT_OWNER", "Owner task failed: " + error.getClass().getSimpleName());
      } finally { finished = true; }
    }
  }

  private byte[] readFrame(SocketChannel socket, boolean authenticated) throws Exception {
    ByteBuffer header = ByteBuffer.allocate(4).order(ByteOrder.BIG_ENDIAN);
    header.limit(1); readFully(socket, header, authenticated ? IDLE_MS : AUTH_MS);
    header.limit(4); readFully(socket, header, BODY_MS); header.flip(); int length = header.getInt();
    if (length <= 0 || length > (authenticated ? DevUpdateProtocol.MAX_FRAME : 1024)) throw new IOException("Development frame exceeds limit");
    ByteBuffer bytes = ByteBuffer.allocate(length); readFully(socket, bytes, BODY_MS); return bytes.array();
  }
  private void readFully(SocketChannel socket, ByteBuffer bytes, long timeoutMs) throws Exception {
    long deadline = System.nanoTime() + timeoutMs * 1000000L;
    while (bytes.hasRemaining()) {
      if (!active.get() || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Development session closed");
      if (System.nanoTime() > deadline) throw new InterruptedIOException("Development frame timed out");
      int count = socket.read(bytes); if (count < 0) throw new EOFException();
      if (count == 0) pause();
    }
  }
  private void writeFrame(SocketChannel socket, String json) throws Exception {
    if (json == null) throw new IOException("Missing owner response");
    byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
    if (bytes.length > DevUpdateProtocol.MAX_FRAME) throw new IOException("Development response exceeds limit");
    ByteBuffer frame = ByteBuffer.allocate(bytes.length + 4).order(ByteOrder.BIG_ENDIAN); frame.putInt(bytes.length).put(bytes).flip();
    long deadline = System.nanoTime() + BODY_MS * 1000000L;
    while (frame.hasRemaining()) {
      if (!active.get() || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Development session closed");
      if (System.nanoTime() > deadline) throw new InterruptedIOException("Development response timed out");
      if (socket.write(frame) == 0) pause();
    }
  }
  private static void pause() throws InterruptedException { Thread.sleep(2); }
  void close() {
    active.set(false);
    AtomicBoolean connection = clientAlive; if (connection != null) connection.set(false);
    if (owner != null) owner.removeCallbacksAndMessages(lifetime);
    pendingTask = null;
    closeSockets();
    Thread thread = worker; if (thread != null) thread.interrupt();
    activity.clear();
  }
  private void closeSockets() {
    SocketChannel socket = client; if (socket != null) try { socket.close(); } catch (IOException ignored) {}
    ServerSocketChannel server = listener; if (server != null) try { server.close(); } catch (IOException ignored) {}
  }
}
