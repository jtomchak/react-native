package dev.nativehost;

/** The selected single Activity's foreground state, updated only on its UI thread.
 * onPause does not imply background (for example, another window may cover it).
 * Android does not synthesize the iOS-only inactive state.
 */
final class AppStateLifecycle {
  interface Listener { void changed(String state); }
  private final Listener listener;
  private String state = "background";
  private boolean closed;
  AppStateLifecycle(Listener listener) { this.listener = listener; }
  String current() { return state; }
  void onResume() { update("active"); }
  void onStop() { update("background"); }
  void close() { closed = true; }
  private void update(String next) {
    if (closed || state.equals(next)) return;
    state = next;
    listener.changed(next);
  }
}
