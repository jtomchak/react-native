package dev.nativehost;

import java.util.ArrayList;
import java.util.Arrays;

/** Simulated Activity callbacks against the actual platform lifecycle module.
 * Physical OS transitions are a separate instrumentation/device lane. */
public final class AppStateLifecycleTest {
  public static void main(String[] args) {
    ArrayList<String> states = new ArrayList<>();
    AppStateLifecycle lifecycle = new AppStateLifecycle(states::add);
    if (!lifecycle.current().equals("background")) throw new AssertionError("initial state");
    lifecycle.onResume();
    lifecycle.onResume();
    lifecycle.onStop();
    lifecycle.onStop();
    lifecycle.onResume();
    if (!states.equals(Arrays.asList("active", "background", "active"))) throw new AssertionError(states);
    lifecycle.close();
    lifecycle.onStop();
    if (states.size() != 3 || !lifecycle.current().equals("active")) throw new AssertionError("callback after close");
    System.out.println("PASS: real Android module, simulated lifecycle, duplicate suppression and detach");
  }
}
