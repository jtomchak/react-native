package dev.nativehost;

import android.content.Context;
import android.content.Intent;
import java.io.File;
import org.json.JSONObject;

/** Release variant has no development-file lookup or override implementation. */
final class BundleSelection {
  static final class Result {
    final File file;
    final String revision;
    Result(File file, String revision) { this.file = file; this.revision = revision; }
  }
  static Result select(Context context, Intent intent) throws Exception {
    return new Result(PackagedBundle.extract(context), "packaged");
  }
  static void recordStartup(Context context, JSONObject receipt) { /* No debug receipt in release. */ }
}
