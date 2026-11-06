package dev.nativehost;

import android.content.Context;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

final class PackagedBundle {
  static File extract(Context context) throws Exception {
    File bundle = new File(context.getFilesDir(), "app.bundle.js");
    try (InputStream input = context.getAssets().open("app.bundle.js");
         FileOutputStream output = new FileOutputStream(bundle)) {
      byte[] bytes = new byte[16384]; int count;
      while ((count = input.read(bytes)) != -1) output.write(bytes, 0, count);
    }
    return bundle;
  }
}
