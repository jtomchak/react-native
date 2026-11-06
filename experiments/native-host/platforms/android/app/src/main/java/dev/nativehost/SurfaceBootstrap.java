package dev.nativehost;

import android.os.Handler;
import android.view.View;

/** Owner-thread, one-shot bootstrap after actual positive surface geometry. */
final class SurfaceBootstrap {
  private final View surface;
  private final Handler owner;
  private final Runnable ready;
  private boolean started;
  private boolean closed;
  private final Runnable attempt = this::attempt;
  private final View.OnLayoutChangeListener layout = (v, l, t, r, b, oldL, oldT, oldR, oldB) -> schedule();

  SurfaceBootstrap(View surface, Handler owner, Runnable ready) {
    this.surface = surface; this.owner = owner; this.ready = ready;
  }
  void start() {
    if (started || closed) return;
    started = true;
    surface.addOnLayoutChangeListener(layout);
    schedule();
  }
  private void schedule() {
    if (closed) return;
    owner.removeCallbacks(attempt);
    owner.post(attempt);
  }
  private void attempt() {
    if (closed || surface.getWidth() <= 0 || surface.getHeight() <= 0) return;
    // Detach before invoking code that can itself trigger layout or teardown.
    close();
    ready.run();
  }
  void close() {
    if (closed) return;
    closed = true;
    owner.removeCallbacks(attempt);
    surface.removeOnLayoutChangeListener(layout);
  }
}
