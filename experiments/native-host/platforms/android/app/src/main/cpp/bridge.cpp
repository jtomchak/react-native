#include <jni.h>
#include <memory>
#include <string>
#include <cstring>
#include <cstdlib>
#include "host.h"

// JNI's NewStringUTF/GetStringUTFChars use modified UTF-8, not the JSON/JS UTF-8
// accepted by Hermes. Convert explicitly so emoji and embedded Unicode survive.
static jstring toJava(JNIEnv* env, const char* value) {
  auto bytes = env->NewByteArray(static_cast<jsize>(std::strlen(value)));
  env->SetByteArrayRegion(bytes, 0, env->GetArrayLength(bytes), reinterpret_cast<const jbyte*>(value));
  auto cls = env->FindClass("java/lang/String");
  auto ctor = env->GetMethodID(cls, "<init>", "([BLjava/lang/String;)V");
  auto encoding = env->NewStringUTF("UTF-8");
  auto result = static_cast<jstring>(env->NewObject(cls, ctor, bytes, encoding));
  env->DeleteLocalRef(encoding); env->DeleteLocalRef(cls); env->DeleteLocalRef(bytes);
  return result;
}
static std::string fromJava(JNIEnv* env, jstring value) {
  auto cls = env->FindClass("java/lang/String");
  auto method = env->GetMethodID(cls, "getBytes", "(Ljava/lang/String;)[B");
  auto encoding = env->NewStringUTF("UTF-8");
  auto bytes = static_cast<jbyteArray>(env->CallObjectMethod(value, method, encoding));
  std::string result(env->GetArrayLength(bytes), '\0');
  env->GetByteArrayRegion(bytes, 0, static_cast<jsize>(result.size()), reinterpret_cast<jbyte*>(result.data()));
  env->DeleteLocalRef(encoding); env->DeleteLocalRef(cls); env->DeleteLocalRef(bytes);
  return result;
}

struct AndroidHost {
  JNIEnv* env;
  jobject runtime;
  jmethodID commit;
  jmethodID command;
  NHHost* host = nullptr;
};
static char* copiedResponse(const std::string& response) {
  auto* result = static_cast<char*>(std::malloc(response.size() + 1));
  if (result) std::memcpy(result, response.c_str(), response.size() + 1);
  return result;
}
static char* onCommand(void* context, const char* json) {
  auto* h = static_cast<AndroidHost*>(context);
  auto input = toJava(h->env, json);
  auto output = static_cast<jstring>(h->env->CallObjectMethod(h->runtime, h->command, input));
  h->env->DeleteLocalRef(input);
  if (h->env->ExceptionCheck()) {
    h->env->ExceptionClear();
    return copiedResponse("{\"error\":{\"code\":\"ANDROID_CALLBACK_ERROR\",\"message\":\"Java native command callback threw\"}}");
  }
  if (!output) return copiedResponse("{\"error\":{\"code\":\"ANDROID_CALLBACK_ERROR\",\"message\":\"Java native command callback returned null\"}}");
  std::string response = fromJava(h->env, output);
  h->env->DeleteLocalRef(output);
  return copiedResponse(response);
}
static void onCommit(void* context, const char* json) {
  auto* h = static_cast<AndroidHost*>(context);
  jstring snapshot = toJava(h->env, json);
  h->env->CallVoidMethod(h->runtime, h->commit, snapshot);
  h->env->DeleteLocalRef(snapshot);
}
extern "C" JNIEXPORT jlong JNICALL
Java_dev_nativehost_NativeRuntime_create(JNIEnv* env, jobject self, jstring bundle,
                                         jdouble width, jdouble height, jstring initialAppState) {
  auto h = std::make_unique<AndroidHost>();
  h->env = env;
  h->runtime = env->NewGlobalRef(self);
  jclass cls = env->GetObjectClass(self);
  h->commit = env->GetMethodID(cls, "onCommit", "(Ljava/lang/String;)V");
  h->command = env->GetMethodID(cls, "onCommand", "(Ljava/lang/String;)Ljava/lang/String;");
  env->DeleteLocalRef(cls);
  std::string path = fromJava(env, bundle);
  std::string appState = fromJava(env, initialAppState);
  NHHostOptions options{};
  options.version = NH_HOST_OPTIONS_VERSION;
  options.size = sizeof(options);
  options.commit_callback = onCommit;
  options.commit_context = h.get();
  options.command_callback = onCommand;
  options.command_context = h.get();
  options.initial_app_state = appState.c_str();
  options.command_capabilities_json = "{\"TextInput\":[\"focus\",\"blur\",\"clear\"],\"ScrollView\":[\"scrollTo\",\"scrollToEnd\"],\"WebView\":[\"goBack\",\"goForward\",\"reload\",\"stopLoading\",\"postMessage\",\"injectJavaScript\"]}";
  h->host = nh_host_create_with_options(path.c_str(), width, height, "android", &options);
  if (!h->host) {
    std::string message = nh_host_last_error();
    env->DeleteGlobalRef(h->runtime);
    jclass error = env->FindClass("java/lang/IllegalStateException");
    env->ThrowNew(error, message.c_str());
    env->DeleteLocalRef(error);
    return 0;
  }
  return reinterpret_cast<jlong>(h.release());
}
extern "C" JNIEXPORT jstring JNICALL
Java_dev_nativehost_NativeRuntime_updateAppState(JNIEnv* env, jobject, jlong handle, jlong generation, jstring state) {
  auto* h = reinterpret_cast<AndroidHost*>(handle);
  std::string value = fromJava(env, state);
  char* result = nh_host_app_state_update(h->host, static_cast<uint64_t>(generation), value.c_str());
  jstring output = toJava(env, result ? result : "null");
  nh_host_string_free(result);
  return output;
}
extern "C" JNIEXPORT jstring JNICALL
Java_dev_nativehost_NativeRuntime_dispatch(JNIEnv* env, jobject, jlong handle, jstring request) {
  auto* h = reinterpret_cast<AndroidHost*>(handle);
  std::string input = fromJava(env, request);
  char* result = nh_host_dispatch(h->host, input.c_str());
  jstring output = toJava(env, result ? result : "null");
  nh_host_string_free(result);
  return output;
}
extern "C" JNIEXPORT jstring JNICALL
Java_dev_nativehost_NativeRuntime_pump(JNIEnv* env, jobject, jlong handle) {
  auto* h = reinterpret_cast<AndroidHost*>(handle);
  char* result = nh_host_pump(h->host);
  jstring output = toJava(env, result ? result : "null");
  nh_host_string_free(result);
  return output;
}
extern "C" JNIEXPORT void JNICALL
Java_dev_nativehost_NativeRuntime_destroy(JNIEnv* env, jobject, jlong handle) {
  std::unique_ptr<AndroidHost> h(reinterpret_cast<AndroidHost*>(handle));
  nh_host_destroy(h->host);
  env->DeleteGlobalRef(h->runtime);
}

#if defined(NH_DEV_UPDATES) && NH_DEV_UPDATES
#include <charconv>
#include <vector>

static jstring devResult(JNIEnv* env, char* response) {
  jstring result = toJava(env, response ? response : "{\"id\":null,\"error\":{\"code\":\"DEV_NATIVE_ERROR\",\"message\":\"Native response unavailable\"}}");
  nh_host_string_free(response);
  return result;
}
static jstring devSchemaError(JNIEnv* env) {
  return toJava(env, "{\"id\":null,\"error\":{\"code\":\"DEV_TRANSPORT_SCHEMA\",\"message\":\"Invalid native development arguments\"}}");
}
static bool devU64(JNIEnv* env, jstring input, uint64_t& output) {
  if (!input) return false;
  const auto text = fromJava(env, input);
  if (text.empty() || text.size() > 20 || text[0] == '0') return false;
  auto result = std::from_chars(text.data(), text.data() + text.size(), output);
  return result.ec == std::errc{} && result.ptr == text.data() + text.size() && output != 0;
}
static bool devBytes(JNIEnv* env, jbyteArray input, uint8_t* output, size_t size) {
  if (!input || env->GetArrayLength(input) != static_cast<jsize>(size)) return false;
  env->GetByteArrayRegion(input, 0, static_cast<jsize>(size), reinterpret_cast<jbyte*>(output));
  return !env->ExceptionCheck();
}
static bool devRevision(JNIEnv* env, jstring input, char (&output)[65]) {
  if (!input) return false;
  const auto text = fromJava(env, input);
  if (text.empty() || text.size() > 64) return false;
  for (char c : text) if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')) return false;
  std::memcpy(output, text.data(), text.size());
  output[text.size()] = 0;
  return true;
}
extern "C" JNIEXPORT jstring JNICALL
Java_dev_nativehost_DevUpdateBridge_status(JNIEnv* env, jclass, jlong handle) {
  if (!handle) return devSchemaError(env);
  return devResult(env, nh_host_dev_status(reinterpret_cast<AndroidHost*>(handle)->host));
}
extern "C" JNIEXPORT jstring JNICALL
Java_dev_nativehost_DevUpdateBridge_open(JNIEnv* env, jclass, jlong handle, jstring generation, jbyteArray session, jstring revision, jbyteArray digest) {
  NHDevSessionV1 value{};
  value.version = NH_DEV_UPDATES_VERSION; value.size = sizeof(value);
  if (!handle || !devU64(env, generation, value.generation) || !devBytes(env, session, value.session_id, sizeof(value.session_id)) || !devBytes(env, digest, value.initial_bundle_sha256, sizeof(value.initial_bundle_sha256)) || !devRevision(env, revision, value.initial_revision)) return devSchemaError(env);
  return devResult(env, nh_host_dev_open(reinterpret_cast<AndroidHost*>(handle)->host, &value));
}
extern "C" JNIEXPORT jstring JNICALL
Java_dev_nativehost_DevUpdateBridge_enqueue(JNIEnv* env, jclass, jlong handle, jstring generation, jbyteArray session, jstring sequence, jstring base, jstring target, jbyteArray digest, jbyteArray payload) {
  NHDevPatchV1 value{};
  value.version = NH_DEV_UPDATES_VERSION; value.size = sizeof(value);
  if (!handle || !payload || env->GetArrayLength(payload) <= 0 || env->GetArrayLength(payload) > NH_DEV_PATCH_MAX_BYTES || !devU64(env, generation, value.generation) || !devU64(env, sequence, value.sequence) || !devBytes(env, session, value.session_id, sizeof(value.session_id)) || !devBytes(env, digest, value.payload_sha256, sizeof(value.payload_sha256)) || !devRevision(env, base, value.base_revision) || !devRevision(env, target, value.target_revision)) return devSchemaError(env);
  std::vector<uint8_t> bytes(static_cast<size_t>(env->GetArrayLength(payload)));
  env->GetByteArrayRegion(payload, 0, static_cast<jsize>(bytes.size()), reinterpret_cast<jbyte*>(bytes.data()));
  if (env->ExceptionCheck()) return nullptr;
  value.payload = bytes.data(); value.payload_length = bytes.size();
  return devResult(env, nh_host_dev_enqueue(reinterpret_cast<AndroidHost*>(handle)->host, &value));
}
extern "C" JNIEXPORT jstring JNICALL
Java_dev_nativehost_DevUpdateBridge_drain(JNIEnv* env, jclass, jlong handle) {
  if (!handle) return devSchemaError(env);
  return devResult(env, nh_host_dev_drain(reinterpret_cast<AndroidHost*>(handle)->host));
}
#endif
