package dev.nativehost;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Shell-only debug control: destroy the old host before the deployer stops its process. */
public final class DebugReloadReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context context, Intent intent) {
    if (!"dev.nativehost.experiment.PREPARE_RELOAD".equals(intent.getAction())) { setResultCode(0); return; }
    HostActivity activity = HostActivity.activeInstance();
    if (activity != null) { activity.prepareForReload(); setResultData("host-destroyed"); }
    else setResultData("no-active-host");
    setResultCode(-1);
  }
}
