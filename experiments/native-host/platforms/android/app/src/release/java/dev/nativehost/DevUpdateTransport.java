package dev.nativehost;

/** Production source variant contains no development transport or native API. */
final class DevUpdateTransport {
  void start(HostActivity activity, android.os.Handler owner, long generation, String revision) {}
  void close() {}
}
