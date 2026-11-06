package dev.nativehost;

/** Development-only owner-thread JNI. Binary payloads never cross modified UTF-8. */
final class DevUpdateBridge {
  private DevUpdateBridge() {}
  static native String status(long handle);
  static native String open(long handle, String generation, byte[] session, String revision, byte[] digest);
  static native String enqueue(long handle, String generation, byte[] session, String sequence, String base, String target, byte[] digest, byte[] payload);
  static native String drain(long handle);
}
