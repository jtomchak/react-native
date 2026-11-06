package dev.nativehost;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.json.JSONObject;

/** Small, strict, flat control schema. Update source remains opaque binary bytes. */
final class DevUpdateProtocol {
  static final int MAX_PAYLOAD = 4 * 1024 * 1024;
  static final int MAX_FRAME = MAX_PAYLOAD * 2 + 16384;
  static final int MAX_CONFIG = 4096;
  static final class Config {
    final String token, sessionId, initialRevision, digest;
    final int port;
    Config(Map<String, Object> fields) {
      exact(fields, "schemaVersion", "token", "sessionId", "initialRevision", "initialBundleSha256", "port");
      if (!(fields.get("schemaVersion") instanceof Long) || ((Long) fields.get("schemaVersion")) != 1) throw schema();
      if (!(fields.get("port") instanceof Long)) throw schema();
      long number = (Long) fields.get("port"); if (number < 0 || number > 65535) throw schema(); port = (int) number;
      token = hexString(fields, "token", 64); sessionId = session(fields);
      initialRevision = revision(fields, "initialRevision"); digest = hexString(fields, "initialBundleSha256", 64);
    }
  }
  static final class Request {
    final String method, token, generation, sessionId, sequence, base, target;
    final byte[] session, digest, payload;
    Request(Map<String, Object> fields) {
      method = string(fields, "method");
      String auth = null, gen = null, sid = null, seq = null, from = null, to = null;
      byte[] idBytes = null, hashBytes = null, sourceBytes = null;
      switch (method) {
        case "authenticate": exact(fields, "method", "token"); auth = hexString(fields, "token", 64); break;
        case "dev.status": case "dev.drain": exact(fields, "method"); break;
        case "dev.enqueue":
          exact(fields, "method", "generation", "sessionId", "sequence", "baseRevision", "targetRevision", "payloadSha256", "payloadHex");
          gen = u64(fields, "generation"); sid = session(fields); seq = u64(fields, "sequence");
          from = revision(fields, "baseRevision"); to = revision(fields, "targetRevision");
          idBytes = hex(sid); hashBytes = hex(hexString(fields, "payloadSha256", 64));
          String source = string(fields, "payloadHex");
          if (source.length() < 2 || source.length() > MAX_PAYLOAD * 2 || (source.length() & 1) != 0) throw schema();
          sourceBytes = hex(source);
          break;
        default: throw schema();
      }
      token = auth; generation = gen; sessionId = sid; sequence = seq; base = from; target = to;
      session = idBytes; digest = hashBytes; payload = sourceBytes;
    }
  }
  static Config config(byte[] bytes) { if (bytes.length > MAX_CONFIG) throw schema(); return new Config(parse(bytes)); }
  static Request request(byte[] bytes) { if (bytes.length > MAX_FRAME) throw schema(); return new Request(parse(bytes)); }
  static String error(String code, String message) {
    try { return new JSONObject().put("id", JSONObject.NULL).put("error", new JSONObject().put("code", code).put("message", message.length() > 512 ? message.substring(0, 512) : message)).toString(); }
    catch (Exception impossible) { return "{\"id\":null,\"error\":{\"code\":\"DEV_TRANSPORT_ERROR\",\"message\":\"Transport failure\"}}"; }
  }
  static IllegalArgumentException schema() { return new IllegalArgumentException("Invalid development transport schema"); }
  static String string(Map<String, Object> fields, String name) { Object value = fields.get(name); if (!(value instanceof String)) throw schema(); return (String) value; }
  static String u64(Map<String, Object> fields, String name) {
    String value = string(fields, name);
    if (!value.matches("[1-9][0-9]{0,19}") || (value.length() == 20 && value.compareTo("18446744073709551615") > 0)) throw schema();
    return value;
  }
  static String revision(Map<String, Object> fields, String name) { String value = string(fields, name); if (!value.matches("[A-Za-z0-9._-]{1,64}")) throw schema(); return value; }
  static String hexString(Map<String, Object> fields, String name, int length) {
    String value = string(fields, name); if (value.length() != length) throw schema();
    for (int index = 0; index < value.length(); index++) nibble(value.charAt(index));
    return value;
  }
  static String session(Map<String, Object> fields) {
    String value = hexString(fields, "sessionId", 32); if (value.equals("00000000000000000000000000000000")) throw schema(); return value;
  }
  static byte[] hex(String value) {
    if ((value.length() & 1) != 0) throw schema();
    byte[] bytes = new byte[value.length() / 2];
    for (int index = 0; index < bytes.length; index++) bytes[index] = (byte) ((nibble(value.charAt(index * 2)) << 4) | nibble(value.charAt(index * 2 + 1)));
    return bytes;
  }
  private static int nibble(char c) { if (c >= '0' && c <= '9') return c - '0'; if (c >= 'a' && c <= 'f') return c - 'a' + 10; throw schema(); }
  static void exact(Map<String, Object> fields, String... names) {
    Set<String> expected = new HashSet<>(Arrays.asList(names)); if (!expected.equals(fields.keySet())) throw schema();
  }
  private static Map<String, Object> parse(byte[] bytes) { return new FlatJson(bytes).read(); }
  private static final class FlatJson {
    private final byte[] bytes;
    private int at;
    FlatJson(byte[] bytes) { this.bytes = bytes; }
    Map<String, Object> read() {
      Map<String, Object> values = new HashMap<>(); expect('{'); whitespace();
      if (take('}')) { end(); return values; }
      while (true) {
        String key = text(); expect(':'); whitespace(); Object value;
        if (peek() == '"') value = text();
        else {
          int start = at; while (peek() >= '0' && peek() <= '9') at++;
          if (at == start || (at - start > 1 && bytes[start] == '0') || at - start > 19) throw schema();
          try { value = Long.valueOf(new String(bytes, start, at - start, StandardCharsets.US_ASCII)); }
          catch (NumberFormatException invalid) { throw schema(); }
        }
        if (values.containsKey(key) || values.size() >= 8) throw schema(); values.put(key, value);
        whitespace(); if (take('}')) { end(); return values; } expect(',');
      }
    }
    private String text() {
      expect('"'); int start = at;
      while (peek() != '"') { int c = peek(); if (c < 32 || c > 126 || c == '\\') throw schema(); at++; }
      String result = new String(bytes, start, at - start, StandardCharsets.US_ASCII); at++; return result;
    }
    private int peek() { return at < bytes.length ? bytes[at] & 255 : -1; }
    private boolean take(int c) { if (peek() != c) return false; at++; return true; }
    private void expect(int c) { whitespace(); if (!take(c)) throw schema(); }
    private void whitespace() { while (peek() == ' ' || peek() == '\t' || peek() == '\r' || peek() == '\n') at++; }
    private void end() { whitespace(); if (at != bytes.length) throw schema(); }
  }
}
