package dev.nativehost;

import android.content.Context;
import android.content.Intent;
import java.io.File;
import java.io.InputStream;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import org.json.JSONObject;

/** Debug variant only: immutable, digest-checked revision selection before Hermes. */
final class BundleSelection {
  static final class Result {
    final File file;
    final String revision;
    Result(File file, String revision) { this.file = file; this.revision = revision; }
  }

  static Result select(Context context, Intent intent) throws Exception {
    String revision = intent.getStringExtra("devRevision");
    if (revision == null) return new Result(PackagedBundle.extract(context), "packaged");
    if (!revision.matches("[0-9]{1,96}")) throw new IllegalArgumentException("Invalid development revision: expected 1-96 digits");
    File files = context.getFilesDir().getCanonicalFile();
    File base = new File(files, "dev-revisions");
    if (!base.getCanonicalFile().equals(base)) throw new IllegalArgumentException("Development revision directory cannot be a symlink");
    File directory = new File(base, revision);
    if (!directory.getCanonicalFile().equals(directory)) throw new IllegalArgumentException("Development revision cannot be a symlink");
    File manifestFile = checkedFile(directory, "manifest.json");
    if (manifestFile.length() <= 0 || manifestFile.length() > 65536) throw new IllegalArgumentException("Invalid development manifest size");
    JSONObject manifest = new JSONObject(new String(Files.readAllBytes(manifestFile.toPath()), StandardCharsets.UTF_8));
    if (!(manifest.opt("schemaVersion") instanceof Integer) || manifest.getInt("schemaVersion") != 1 || !"development".equals(manifest.optString("mode")) || !"full".equals(manifest.optString("reload"))) {
      throw new IllegalArgumentException("Unsupported development manifest contract");
    }
    if (!(manifest.opt("revision") instanceof String) || !revision.equals(manifest.getString("revision"))) throw new IllegalArgumentException("Development manifest revision mismatch");
    File bundle = verifyArtifact(directory, "app.bundle.js", manifest);
    JSONObject sourceMap = manifest.optJSONObject("sourceMap");
    if (sourceMap == null || !"app.bundle.js.map".equals(sourceMap.optString("file"))) throw new IllegalArgumentException("Invalid development source map metadata");
    verifyArtifact(directory, "app.bundle.js.map", sourceMap);
    return new Result(bundle, revision);
  }

  private static File verifyArtifact(File directory, String name, JSONObject metadata) throws Exception {
    Object size = metadata.opt("byteLength");
    if (!(size instanceof Integer || size instanceof Long)) throw new IllegalArgumentException("Development byteLength must be an integer");
    long byteLength = ((Number) size).longValue();
    String digest = metadata.optString("sha256");
    if (byteLength < 1 || byteLength > 64 * 1024 * 1024 || !digest.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid development bundle metadata");
    File bundle = checkedFile(directory, name);
    if (bundle.length() != byteLength) throw new IllegalArgumentException("Development bundle byte length mismatch: " + name);
    MessageDigest sha256 = MessageDigest.getInstance("SHA-256");
    long read = 0;
    try (InputStream input = new FileInputStream(bundle)) {
      byte[] bytes = new byte[16384]; int count;
      while ((count = input.read(bytes)) != -1) { read += count; if (read > byteLength) throw new IllegalArgumentException("Development bundle changed during validation"); sha256.update(bytes, 0, count); }
    }
    StringBuilder actual = new StringBuilder();
    for (byte value : sha256.digest()) actual.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
    if (read != byteLength || !MessageDigest.isEqual(actual.toString().getBytes(StandardCharsets.US_ASCII), digest.getBytes(StandardCharsets.US_ASCII))) throw new IllegalArgumentException("Development bundle SHA256 mismatch: " + name);
    return bundle;
  }

  private static File checkedFile(File directory, String name) throws Exception {
    File file = new File(directory, name);
    if (!file.isFile() || !file.getCanonicalFile().equals(file)) throw new IllegalArgumentException("Missing or symlinked development file: " + name);
    return file;
  }

  static void recordStartup(Context context, JSONObject receipt) throws Exception {
    File temporary = new File(context.getFilesDir(), "dev-startup.json.tmp");
    File destination = new File(context.getFilesDir(), "dev-startup.json");
    try (FileOutputStream output = new FileOutputStream(temporary)) {
      output.write(receipt.toString().getBytes(StandardCharsets.UTF_8));
      output.getFD().sync();
    }
    Files.move(temporary.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
  }
}
