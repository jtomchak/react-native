package dev.nativehost;

/** All methods are called on the Activity UI thread. */
final class NativeRuntime {
  static { System.loadLibrary("nativehost_android"); }
  interface CommitListener { void onCommit(String snapshot); }
  interface CommandListener { String onCommand(String command); }
  private final CommitListener listener;
  private final CommandListener commands;
  NativeRuntime(CommitListener listener, CommandListener commands) { this.listener = listener; this.commands = commands; }
  private void onCommit(String snapshot) { listener.onCommit(snapshot); }
  private String onCommand(String command) { return commands.onCommand(command); }
  native long create(String bundle, double width, double height, String initialAppState);
  native String updateAppState(long host, long generation, String state);
  native String dispatch(long host, String request);
  native String pump(long host);
  native void destroy(long host);
}

