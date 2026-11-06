#include "host.h"
#include "native_host.h"
#if defined(NH_DEV_UPDATES) && NH_DEV_UPDATES
#include "dev/Integrity.h"
#endif

#include <hermes/hermes.h>
#include <jsi/jsi.h>
#include <yoga/Yoga.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace jsi = facebook::jsi;
using Clock = std::chrono::steady_clock;
namespace {
thread_local std::string lastError;
constexpr size_t maxJsonBytes = 8 * 1024 * 1024;
constexpr size_t maxNodes = 4096;
constexpr size_t maxTimers = 4096;
constexpr size_t maxCommandBytes = 1024 * 1024 + 4096;
constexpr size_t maxCommandResponseBytes = 65536;
const std::map<std::string, std::set<std::string>> commandSchema = {
    {"TextInput", {"focus", "blur", "clear"}},
    {"ScrollView", {"scrollTo", "scrollToEnd"}},
    {"WebView",
     {"goBack",
      "goForward",
      "reload",
      "stopLoading",
      "postMessage",
      "injectJavaScript"}},
};

struct NativeCallbackScope {
  bool& active;
  explicit NativeCallbackScope(bool& value) : active(value) {
    if (active)
      throw std::runtime_error("REENTRANT_HOST_CALL: native callback active");
    active = true;
  }
  ~NativeCallbackScope() {
    active = false;
  }
};

struct TaskScope {
  unsigned& depth;
  explicit TaskScope(unsigned& value) : depth(value) {
    ++depth;
  }
  ~TaskScope() {
    --depth;
  }
};

class StringBuffer final : public jsi::Buffer {
 public:
  explicit StringBuffer(std::string value) : value_(std::move(value)) {}
  size_t size() const override {
    return value_.size();
  }
  const uint8_t* data() const override {
    return reinterpret_cast<const uint8_t*>(value_.data());
  }

 private:
  std::string value_;
};

std::string quote(const std::string& input) {
  std::string result = "\"";
  const char hex[] = "0123456789abcdef";
  for (unsigned char c : input) {
    if (c == '"' || c == '\\') {
      result += '\\';
      result += c;
    } else if (c < 0x20) {
      result += "\\u00";
      result += hex[c >> 4];
      result += hex[c & 15];
    } else
      result += c;
  }
  return result + '"';
}
char* owned(const std::string& value) {
  auto* result = static_cast<char*>(std::malloc(value.size() + 1));
  if (!result)
    throw std::bad_alloc();
  std::memcpy(result, value.c_str(), value.size() + 1);
  return result;
}
std::string errorJson(
    const std::string& message,
    const std::string& id = "null",
    const std::string& code = "HOST_ERROR") {
  return "{\"id\":" + id + ",\"error\":{\"code\":" + quote(code) +
      ",\"message\":" + quote(message) + "}}";
}
const char* entryErrorCode(const std::string& error) {
  if (error.rfind("REENTRANT_HOST_CALL:", 0) == 0)
    return "REENTRANT_HOST_CALL";
#if defined(NH_DEV_UPDATES) && NH_DEV_UPDATES
  if (error.rfind("DEV_RELOAD_REQUIRED:", 0) == 0)
    return "DEV_RELOAD_REQUIRED";
#endif
  return "HOST_ERROR";
}
std::string
checkedString(jsi::Runtime& rt, const jsi::Value& value, const char* name) {
  if (!value.isString())
    throw std::invalid_argument(std::string(name) + " must be a string");
  auto s = value.getString(rt).utf8(rt);
  if (s.size() > maxJsonBytes)
    throw std::invalid_argument(std::string(name) + " exceeds size limit");
  return s;
}
double
checkedNumber(const jsi::Value& v, const char* name, double low, double high) {
  if (!v.isNumber() || !std::isfinite(v.getNumber()) || v.getNumber() < low ||
      v.getNumber() > high)
    throw std::invalid_argument(std::string(name) + " outside supported range");
  return v.getNumber();
}
uint64_t checkedId(const jsi::Value& v) {
  auto n = checkedNumber(v, "id", 1, 9007199254740991.0);
  if (std::floor(n) != n)
    throw std::invalid_argument("id must be integral");
  return static_cast<uint64_t>(n);
}
void checkStatus(uint32_t status, const char* operation) {
  if (status != 0)
    throw std::runtime_error(
        std::string(operation) + " failed with service status " +
        std::to_string(status));
}
struct YogaTree {
  YGNodeRef node;
  jsi::Object object;
  std::vector<std::unique_ptr<YogaTree>> children;
  YogaTree(YGNodeRef n, jsi::Object o) : node(n), object(std::move(o)) {}
  ~YogaTree() {
    if (node)
      YGNodeFree(node);
  }
};
} // namespace

struct NHHost {
  std::thread::id owner = std::this_thread::get_id();
  std::unique_ptr<facebook::hermes::HermesRuntime> runtime;
  NhRuntime* services = nullptr;
  uint64_t generation = 0;
  std::string runtimeMetadata = "{}";
  std::string engineVersion = "unknown";
  double width;
  double height;
  std::string platform;
  NHCommitCallback commitCallback;
  void* commitContext;
  NHCommandCallback commandCallback;
  void* commandContext;
  std::string commandCapabilities;
  std::map<std::string, std::set<std::string>> supportedCommands;
  bool insideNativeCallback = false;
  std::string appState;
  uint64_t appStateSequence = 0;
  std::set<uint64_t> appStateSubscriptions;
  Clock::time_point epoch = Clock::now();
  std::string lastSnapshot = "{\"revision\":0,\"children\":[]}";
  std::vector<std::string> asyncErrors;
  uint64_t suppressedAsyncErrors = 0;
  bool pumping = false;
  unsigned taskDepth = 0;
  struct Timer {
    jsi::Function callback;
    std::vector<jsi::Value> args;
    double due;
    double interval;
    Timer(
        jsi::Function fn,
        std::vector<jsi::Value> values,
        double at,
        double every)
        : callback(std::move(fn)),
          args(std::move(values)),
          due(at),
          interval(every) {}
  };
  std::map<uint64_t, std::shared_ptr<Timer>> timers;
  uint64_t nextTimer = 1;

  NHHost(
      double w,
      double h,
      std::string p,
      NHCommitCallback callback,
      void* context,
      NHCommandCallback command,
      void* command_context,
      std::string capabilities,
      std::string initialAppState)
      : width(w),
        height(h),
        platform(std::move(p)),
        commitCallback(callback),
        commitContext(context),
        commandCallback(command),
        commandContext(command_context),
        commandCapabilities(std::move(capabilities)),
        appState(std::move(initialAppState)) {
    runtime = facebook::hermes::makeHermesRuntime(
        ::hermes::vm::RuntimeConfig::Builder()
            .withMicrotaskQueue(true)
            .build());
    checkStatus(nh_runtime_create(1, 256, &services), "runtime.create");
    generation = nh_runtime_generation(services);
    try {
      if (!appState.empty())
        validateAppState(appState);
      auto properties = evaluate(
          "HermesInternal.getRuntimeProperties()", "native-host:identity");
      runtimeMetadata = stringify(properties);
      auto version = properties.getObject(*runtime).getProperty(
          *runtime, "OSS Release Version");
      if (version.isString())
        engineVersion = version.getString(*runtime).utf8(*runtime);
      validateCommandCapabilities();
      install();
    } catch (const std::exception& error) {
      nh_runtime_destroy(services);
      services = nullptr;
      // JSError retains a VM value. Destroy it before constructor unwinding
      // destroys the runtime, rather than carrying it across that lifetime.
      throw std::runtime_error(error.what());
    } catch (...) {
      nh_runtime_destroy(services);
      services = nullptr;
      throw std::runtime_error("unknown native host initialization error");
    }
  }
  ~NHHost() {
    timers.clear();
    if (services)
      nh_runtime_destroy(services);
  }
  void assertOwner() const {
    if (owner != std::this_thread::get_id())
      throw std::runtime_error("Hermes access from non-owner thread");
  }
  void assertEntry(bool allowPoisoned = false) const {
    assertOwner();
    if (insideNativeCallback || taskDepth != 0)
      throw std::runtime_error(
          "REENTRANT_HOST_CALL: enqueue delegate events for a later owner-thread turn");
#if defined(NH_DEV_UPDATES) && NH_DEV_UPDATES
    if (!allowPoisoned && dev.poisoned)
      throw std::runtime_error(
          "DEV_RELOAD_REQUIRED: destroy and load a verified full revision");
#else
    (void)allowPoisoned;
#endif
  }

#if defined(NH_DEV_UPDATES) && NH_DEV_UPDATES
#include "dev/HostMethods.inc"
#endif

  void validateAppState(const std::string& state) const {
    if ((platform != "ios" && platform != "android") ||
        (state != "active" && state != "background" &&
         !(platform == "ios" && state == "inactive")))
      throw std::invalid_argument("invalid platform AppState");
  }
  std::string appStatePayload() const {
    return "{\"schemaVersion\":1,\"generation\":" + std::to_string(generation) +
        ",\"state\":" + quote(appState) +
        ",\"sequence\":" + std::to_string(appStateSequence) +
        ",\"capturedAtMs\":" + std::to_string(now()) +
        ",\"source\":\"native-lifecycle\"}";
  }
  std::string updateAppState(
      uint64_t requestedGeneration,
      const std::string& state) {
    assertEntry();
    if (requestedGeneration != generation)
      throw std::runtime_error("STALE_GENERATION: AppState update");
    if (appState.empty())
      throw std::runtime_error(
          "UNSUPPORTED_SERVICE: AppState backend unavailable");
    validateAppState(state);
    const bool changed = state != appState;
    if (changed) {
      appState = state;
      ++appStateSequence;
      const auto payload = appStatePayload();
      // Snapshot the subscription ids: delivery happens only in a later pump,
      // and never invokes JavaScript from this native lifecycle ingress.
      for (auto id : appStateSubscriptions) {
        auto status = nh_publish(
            services,
            generation,
            id,
            reinterpret_cast<const uint8_t*>(payload.data()),
            payload.size());
        if (status != NH_OK) {
          recordAsyncError(
              "AppState event queue overflow; lifecycle delivery incomplete");
          checkStatus(status, "AppState.publish");
        }
      }
    }
    return "{\"id\":null,\"result\":{\"changed\":" +
        std::string(changed ? "true" : "false") +
        ",\"sequence\":" + std::to_string(appStateSequence) + "}}";
  }

  void validateCommandCapabilities() {
    auto& rt = *runtime;
    auto value = parse(commandCapabilities);
    if (!value.isObject() || value.getObject(rt).isArray(rt))
      throw std::invalid_argument("command capabilities must be an object");
    auto object = value.getObject(rt);
    auto keys = object.getPropertyNames(rt);
    for (size_t i = 0; i < keys.size(rt); ++i) {
      auto type = keys.getValueAtIndex(rt, i).getString(rt).utf8(rt);
      auto schema = commandSchema.find(type);
      auto list = object.getProperty(rt, type.c_str());
      if (schema == commandSchema.end() || !list.isObject() ||
          !list.getObject(rt).isArray(rt))
        throw std::invalid_argument(
            "unknown command capability type or non-array commands");
      auto commands = list.getObject(rt).getArray(rt);
      for (size_t j = 0; j < commands.size(rt); ++j) {
        auto name = checkedString(
            rt, commands.getValueAtIndex(rt, j), "command capability");
        if (!schema->second.count(name) ||
            !supportedCommands[type].insert(name).second)
          throw std::invalid_argument(
              "unknown or duplicate command capability");
        if (!commandCallback)
          throw std::invalid_argument(
              "command capabilities require a command callback");
      }
    }
    commandCapabilities = stringify(value);
  }

  [[noreturn]] void commandError(const char* code, const std::string& message) {
    auto& rt = *runtime;
    auto error =
        rt.global()
            .getPropertyAsFunction(rt, "Error")
            .callAsConstructor(rt, jsi::String::createFromUtf8(rt, message))
            .getObject(rt);
    error.setProperty(rt, "code", jsi::String::createFromUtf8(rt, code));
    throw jsi::JSError(rt, jsi::Value(std::move(error)));
  }

  std::string committedType(const jsi::Object& node, uint64_t target) {
    auto& rt = *runtime;
    auto id = node.getProperty(rt, "id");
    if (id.isNumber() && id.getNumber() == static_cast<double>(target))
      return checkedString(rt, node.getProperty(rt, "type"), "committed type");
    auto children = node.getProperty(rt, "children");
    if (children.isObject() && children.getObject(rt).isArray(rt)) {
      auto array = children.getObject(rt).getArray(rt);
      for (size_t i = 0; i < array.size(rt); ++i) {
        auto found =
            committedType(array.getValueAtIndex(rt, i).getObject(rt), target);
        if (!found.empty())
          return found;
      }
    }
    return "";
  }

  jsi::Value command(const std::string& json) {
    assertOwner();
    auto& rt = *runtime;
    if (json.size() > maxCommandBytes)
      commandError("INVALID_COMMAND", "command exceeds size limit");
    jsi::Value value;
    try {
      value = parse(json);
    } catch (const std::exception&) {
      commandError("INVALID_COMMAND", "command must be valid JSON");
    }
    if (!value.isObject() || value.getObject(rt).isArray(rt))
      commandError("INVALID_COMMAND", "command must be an object");
    auto object = value.getObject(rt);
    const std::set<std::string> fields{
        "version", "generation", "nodeId", "name", "args"};
    auto fieldNames = object.getPropertyNames(rt);
    for (size_t i = 0; i < fieldNames.size(rt); ++i) {
      if (!fields.count(
              fieldNames.getValueAtIndex(rt, i).getString(rt).utf8(rt)))
        commandError("INVALID_COMMAND", "unknown command envelope field");
    }
    auto version = object.getProperty(rt, "version");
    if (!version.isNumber() || version.getNumber() != 1)
      commandError("INVALID_COMMAND", "unsupported command version");
    uint64_t requestedGeneration, target;
    std::string name;
    try {
      requestedGeneration = checkedId(object.getProperty(rt, "generation"));
      target = checkedId(object.getProperty(rt, "nodeId"));
      name = checkedString(rt, object.getProperty(rt, "name"), "command name");
    } catch (const std::exception& e) {
      commandError("INVALID_COMMAND", e.what());
    }
    if (requestedGeneration != generation)
      commandError(
          "STALE_GENERATION",
          "native command belongs to a different runtime generation");
    auto type = committedType(parse(lastSnapshot).getObject(rt), target);
    if (type.empty())
      commandError("STALE_NODE", "native command target is not committed");
    auto supported = supportedCommands.find(type);
    if (!commandCallback || supported == supportedCommands.end() ||
        !supported->second.count(name))
      commandError(
          "UNSUPPORTED_COMMAND",
          "unsupported native command " + type + "." + name);
    auto argsValue = object.getProperty(rt, "args");
    if (!argsValue.isObject() || argsValue.getObject(rt).isArray(rt))
      commandError("INVALID_COMMAND", "command args must be an object");
    auto args = argsValue.getObject(rt);
    std::set<std::string> allowed;
    if (name == "scrollTo")
      allowed = {"x", "y", "animated"};
    if (name == "scrollToEnd")
      allowed = {"animated"};
    if (name == "postMessage")
      allowed = {"data"};
    if (name == "injectJavaScript")
      allowed = {"source"};
    auto keys = args.getPropertyNames(rt);
    for (size_t i = 0; i < keys.size(rt); ++i) {
      auto key = keys.getValueAtIndex(rt, i).getString(rt).utf8(rt);
      if (!allowed.count(key))
        commandError("INVALID_COMMAND", "unexpected command argument: " + key);
      auto arg = args.getProperty(rt, key.c_str());
      if ((key == "x" || key == "y") &&
          (!arg.isNumber() || !std::isfinite(arg.getNumber()) ||
           std::abs(arg.getNumber()) > 10000000))
        commandError(
            "INVALID_COMMAND", "scroll coordinate outside supported range");
      if (key == "animated" && !arg.isBool())
        commandError("INVALID_COMMAND", "animated must be boolean");
    }
    if (name == "postMessage" || name == "injectJavaScript") {
      auto payload =
          args.getProperty(rt, name == "postMessage" ? "data" : "source");
      if (!payload.isString() ||
          payload.getString(rt).utf8(rt).size() > 1024 * 1024)
        commandError(
            "INVALID_COMMAND",
            "command payload must be a string of at most 1MiB UTF-8");
    }
    std::unique_ptr<char, decltype(&std::free)> response(nullptr, &std::free);
    try {
      NativeCallbackScope scope(insideNativeCallback);
      response.reset(commandCallback(commandContext, json.c_str()));
    } catch (const std::exception& e) {
      commandError("NATIVE_COMMAND_ERROR", e.what());
    } catch (...) {
      commandError("NATIVE_COMMAND_ERROR", "native command callback threw");
    }
    if (!response)
      commandError(
          "NATIVE_COMMAND_ERROR", "native command callback returned null");
    size_t length = strnlen(response.get(), maxCommandResponseBytes + 1);
    if (length > maxCommandResponseBytes)
      commandError(
          "NATIVE_COMMAND_ERROR", "native command response exceeds size limit");
    jsi::Value reply;
    try {
      reply = parse(std::string(response.get(), length));
    } catch (const std::exception&) {
      commandError(
          "NATIVE_COMMAND_ERROR",
          "native command callback returned malformed JSON");
    }
    if (!reply.isObject() || reply.getObject(rt).isArray(rt))
      commandError(
          "NATIVE_COMMAND_ERROR", "native command response must be an object");
    auto envelope = reply.getObject(rt);
    bool hasError = envelope.hasProperty(rt, "error"),
         hasResult = envelope.hasProperty(rt, "result");
    if (hasError == hasResult)
      commandError(
          "NATIVE_COMMAND_ERROR",
          "native command response must contain exactly one of result or error");
    if (hasError) {
      auto errorValue = envelope.getProperty(rt, "error");
      if (!errorValue.isObject())
        commandError("NATIVE_COMMAND_ERROR", "malformed native command error");
      auto error = errorValue.getObject(rt);
      auto code = error.getProperty(rt, "code"),
           message = error.getProperty(rt, "message");
      if (!code.isString() || !message.isString() ||
          code.getString(rt).utf8(rt).empty() ||
          code.getString(rt).utf8(rt).size() > 64 ||
          message.getString(rt).utf8(rt).size() > 4096)
        commandError(
            "NATIVE_COMMAND_ERROR", "malformed native command error fields");
      commandError(
          code.getString(rt).utf8(rt).c_str(),
          type + "." + name + ": " + message.getString(rt).utf8(rt));
    }
    if (!envelope.getProperty(rt, "result").isNull())
      commandError(
          "NATIVE_COMMAND_ERROR",
          "native commands acknowledge submission with null result only");
    return jsi::Value::null();
  }
  double now() const {
    return std::chrono::duration<double, std::milli>(Clock::now() - epoch)
        .count();
  }
  jsi::Value parse(const std::string& json) {
    return runtime->global()
        .getPropertyAsObject(*runtime, "JSON")
        .getPropertyAsFunction(*runtime, "parse")
        .call(*runtime, jsi::String::createFromUtf8(*runtime, json));
  }
  std::string stringify(const jsi::Value& v) {
    if (v.isUndefined())
      return "null";
    auto result = runtime->global()
                      .getPropertyAsObject(*runtime, "JSON")
                      .getPropertyAsFunction(*runtime, "stringify")
                      .call(*runtime, v);
    return result.isUndefined() ? "null"
                                : result.getString(*runtime).utf8(*runtime);
  }
  void bind(const char* name, unsigned count, jsi::HostFunctionType function) {
    runtime->global().setProperty(
        *runtime,
        name,
        jsi::Function::createFromHostFunction(
            *runtime,
            jsi::PropNameID::forAscii(*runtime, name),
            count,
            [this, function = std::move(function)](
                jsi::Runtime& rt,
                const jsi::Value& self,
                const jsi::Value* args,
                size_t size) -> jsi::Value {
              assertOwner();
              try {
                return function(rt, self, args, size);
              } catch (const jsi::JSError&) {
                throw;
              } catch (const std::exception& e) {
                throw jsi::JSError(rt, e.what());
              } catch (...) {
                throw jsi::JSError(rt, "unknown native host callback error");
              }
            }));
  }
  jsi::Value evaluate(const std::string& source, const std::string& url) {
    return runtime->evaluateJavaScript(
        std::make_shared<StringBuffer>(source), url);
  }
  void install() {
    auto& rt = *runtime;
    rt.global().setProperty(
        rt, "__nhGeneration", static_cast<double>(generation));
    rt.global().setProperty(
        rt, "__nhPlatform", jsi::String::createFromUtf8(rt, platform));
    rt.global().setProperty(rt, "__nhAppStateAvailable", !appState.empty());
    bind(
        "__nhAppStateSnapshot",
        0,
        [this](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t n) {
          if (n)
            commandError(
                "INVALID_SERVICE_ARGUMENT",
                "AppState snapshot takes no arguments");
          if (appState.empty())
            commandError(
                "UNSUPPORTED_SERVICE",
                "AppState requires a real platform lifecycle backend");
          const auto payload = appStatePayload();
          uint64_t id = 0;
          checkStatus(
              nh_submit(
                  services,
                  generation,
                  reinterpret_cast<const uint8_t*>(payload.data()),
                  payload.size(),
                  0,
                  &id),
              "AppState.snapshot");
          return jsi::Value(static_cast<double>(id));
        });
    bind(
        "__nhAppStateSubscribe",
        0,
        [this](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t n) {
          if (n)
            commandError(
                "INVALID_SERVICE_ARGUMENT",
                "AppState subscribe takes no arguments");
          if (appState.empty())
            commandError(
                "UNSUPPORTED_SERVICE",
                "AppState requires a real platform lifecycle backend");
          if (appStateSubscriptions.size() >= 64)
            commandError(
                "SERVICE_CAPACITY",
                "AppState supports at most 64 subscriptions");
          uint64_t id = 0;
          checkStatus(
              nh_subscribe(services, generation, &id), "AppState.subscribe");
          appStateSubscriptions.insert(id);
          return jsi::Value(static_cast<double>(id));
        });
    rt.global().setProperty(
        rt, "__nhCommandCapabilities", parse(commandCapabilities));
    bind(
        "__nhCommand",
        1,
        [this](
            jsi::Runtime& runtime,
            const jsi::Value&,
            const jsi::Value* args,
            size_t size) {
          if (size != 1 || !args[0].isString())
            commandError(
                "INVALID_COMMAND", "__nhCommand requires one JSON string");
          return command(args[0].getString(runtime).utf8(runtime));
        });
    jsi::Object viewport(rt);
    viewport.setProperty(rt, "width", width);
    viewport.setProperty(rt, "height", height);
    rt.global().setProperty(rt, "__nhViewport", std::move(viewport));
    bind(
        "__nhCommit",
        1,
        [this](
            jsi::Runtime& r, const jsi::Value&, const jsi::Value* a, size_t n) {
          if (n != 1)
            throw std::invalid_argument("commit requires tree JSON");
          return jsi::Value(
              jsi::String::createFromUtf8(
                  r, layout(checkedString(r, a[0], "tree"), true)));
        });
    bind(
        "__nhLayout",
        1,
        [this](
            jsi::Runtime& r, const jsi::Value&, const jsi::Value* a, size_t n) {
          if (n != 1)
            throw std::invalid_argument("layout requires tree JSON");
          return jsi::Value(
              jsi::String::createFromUtf8(
                  r, layout(checkedString(r, a[0], "tree"), false)));
        });
    bind(
        "__nhEcho",
        2,
        [this](
            jsi::Runtime& r, const jsi::Value&, const jsi::Value* a, size_t n) {
          if (n < 1)
            throw std::invalid_argument("echo requires payload");
          auto payload = checkedString(r, a[0], "payload");
          uint32_t delay = n > 1
              ? static_cast<uint32_t>(checkedNumber(a[1], "delay", 0, 60000))
              : 0;
          uint64_t id = 0;
          checkStatus(
              nh_submit(
                  services,
                  generation,
                  reinterpret_cast<const uint8_t*>(payload.data()),
                  payload.size(),
                  delay,
                  &id),
              "echo");
          return jsi::Value(static_cast<double>(id));
        });
#ifdef NH_SERVICE_TEST_HOOKS
    bind(
        "__nhTestEchoError",
        2,
        [this](
            jsi::Runtime& r, const jsi::Value&, const jsi::Value* a, size_t n) {
          if (n < 1)
            throw std::invalid_argument(
                "test error requires diagnostic payload");
          auto payload = checkedString(r, a[0], "payload");
          uint32_t delay = n > 1
              ? static_cast<uint32_t>(checkedNumber(a[1], "delay", 0, 60000))
              : 0;
          uint64_t id = 0;
          checkStatus(
              nh_test_submit_error(
                  services,
                  generation,
                  reinterpret_cast<const uint8_t*>(payload.data()),
                  payload.size(),
                  delay,
                  &id),
              "test error");
          return jsi::Value(static_cast<double>(id));
        });
#endif
    bind(
        "__nhCancel",
        1,
        [this](
            jsi::Runtime&, const jsi::Value&, const jsi::Value* a, size_t n) {
          if (n != 1)
            throw std::invalid_argument("cancel requires id");
          return jsi::Value(
              static_cast<double>(
                  nh_cancel(services, generation, checkedId(a[0]))));
        });
    bind(
        "__nhSubscribe",
        0,
        [this](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
          uint64_t id = 0;
          checkStatus(nh_subscribe(services, generation, &id), "subscribe");
          return jsi::Value(static_cast<double>(id));
        });
    bind(
        "__nhPublish",
        2,
        [this](
            jsi::Runtime& r, const jsi::Value&, const jsi::Value* a, size_t n) {
          if (n != 2)
            throw std::invalid_argument("publish requires id,payload");
          if (appStateSubscriptions.count(checkedId(a[0])))
            commandError(
                "INVALID_SERVICE_ARGUMENT",
                "AppState events originate only from the native lifecycle backend");
          auto data = checkedString(r, a[1], "payload");
          checkStatus(
              nh_publish(
                  services,
                  generation,
                  checkedId(a[0]),
                  reinterpret_cast<const uint8_t*>(data.data()),
                  data.size()),
              "publish");
          return jsi::Value::undefined();
        });
    bind(
        "__nhUnsubscribe",
        1,
        [this](
            jsi::Runtime&, const jsi::Value&, const jsi::Value* a, size_t n) {
          if (n != 1)
            throw std::invalid_argument("unsubscribe requires id");
          appStateSubscriptions.erase(checkedId(a[0]));
          return jsi::Value(
              static_cast<double>(
                  nh_unsubscribe(services, generation, checkedId(a[0]))));
        });
    for (bool repeating : {false, true}) {
      bind(
          repeating ? "setInterval" : "setTimeout",
          2,
          [this, repeating](
              jsi::Runtime& r,
              const jsi::Value&,
              const jsi::Value* a,
              size_t n) {
            if (!n || !a[0].isObject() || !a[0].getObject(r).isFunction(r))
              throw std::invalid_argument("timer callback must be a function");
            if (timers.size() >= maxTimers)
              throw std::runtime_error("timer capacity exceeded");
            double delay = n > 1 && !a[1].isUndefined()
                ? checkedNumber(a[1], "timer delay", 0, 2147483647)
                : 0;
            std::vector<jsi::Value> values;
            for (size_t i = 2; i < n; ++i)
              values.emplace_back(r, a[i]);
            auto id = nextTimer++;
            timers.emplace(
                id,
                std::make_shared<Timer>(
                    a[0].getObject(r).getFunction(r),
                    std::move(values),
                    now() + delay,
                    repeating ? std::max(1.0, delay) : 0));
            return jsi::Value(static_cast<double>(id));
          });
    }
    for (const char* name : {"clearTimeout", "clearInterval"})
      bind(
          name,
          1,
          [this](
              jsi::Runtime&, const jsi::Value&, const jsi::Value* a, size_t n) {
            if (n && a[0].isNumber() && std::isfinite(a[0].getNumber()) &&
                a[0].getNumber() >= 1 && a[0].getNumber() <= 9007199254740991.0)
              timers.erase(static_cast<uint64_t>(a[0].getNumber()));
            return jsi::Value::undefined();
          });
    bind(
        "queueMicrotask",
        1,
        [](jsi::Runtime& r, const jsi::Value&, const jsi::Value* a, size_t n) {
          if (!n || !a[0].isObject() || !a[0].getObject(r).isFunction(r))
            throw std::invalid_argument(
                "microtask callback must be a function");
          r.queueMicrotask(a[0].getObject(r).getFunction(r));
          return jsi::Value::undefined();
        });
    bind(
        "__nhNow",
        0,
        [this](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
          return jsi::Value(now());
        });
    bind(
        "__nhLog",
        1,
        [](jsi::Runtime& r, const jsi::Value&, const jsi::Value* a, size_t n) {
          if (n)
            std::cerr << a[0].toString(r).utf8(r) << '\n';
          return jsi::Value::undefined();
        });
    evaluate(
        "globalThis.performance={now:__nhNow};globalThis.console={log:(...a)=>__nhLog(a.map(String).join(' ')),warn:(...a)=>__nhLog(a.map(String).join(' ')),error:(...a)=>__nhLog(a.map(String).join(' ')),info:(...a)=>__nhLog(a.map(String).join(' ')),debug:(...a)=>__nhLog(a.map(String).join(' '))};globalThis.setImmediate=(f,...a)=>setTimeout(f,0,...a);globalThis.clearImmediate=clearTimeout;",
        "native-host:bootstrap");
  }

  void style(YGNodeRef node, const jsi::Object& s) {
    auto& rt = *runtime;
    auto number = [&](const char* name, auto setter) {
      auto v = s.getProperty(rt, name);
      if (v.isUndefined() || v.isNull())
        return;
      setter(static_cast<float>(checkedNumber(v, name, -1000000, 1000000)));
    };
    auto dimension = [&](const char* name,
                         auto points,
                         auto percent,
                         auto automatic) {
      auto v = s.getProperty(rt, name);
      if (v.isUndefined() || v.isNull())
        return;
      if (v.isNumber()) {
        points(static_cast<float>(checkedNumber(v, name, 0, 1000000)));
        return;
      }
      auto str = checkedString(rt, v, name);
      if (str == "auto") {
        automatic();
        return;
      }
      if (!str.empty() && str.back() == '%') {
        size_t end = 0;
        float amount = std::stof(str, &end);
        if (end != str.size() - 1 || !std::isfinite(amount) || amount < 0 ||
            amount > 1000000)
          throw std::invalid_argument("invalid percent dimension");
        percent(amount);
        return;
      }
      throw std::invalid_argument(std::string("unsupported dimension ") + name);
    };
    dimension(
        "width",
        [&](float x) { YGNodeStyleSetWidth(node, x); },
        [&](float x) { YGNodeStyleSetWidthPercent(node, x); },
        [&] { YGNodeStyleSetWidthAuto(node); });
    dimension(
        "height",
        [&](float x) { YGNodeStyleSetHeight(node, x); },
        [&](float x) { YGNodeStyleSetHeightPercent(node, x); },
        [&] { YGNodeStyleSetHeightAuto(node); });
    number("minWidth", [&](float x) { YGNodeStyleSetMinWidth(node, x); });
    number("minHeight", [&](float x) { YGNodeStyleSetMinHeight(node, x); });
    number("maxWidth", [&](float x) { YGNodeStyleSetMaxWidth(node, x); });
    number("maxHeight", [&](float x) { YGNodeStyleSetMaxHeight(node, x); });
    number("flex", [&](float x) { YGNodeStyleSetFlex(node, x); });
    number("flexGrow", [&](float x) { YGNodeStyleSetFlexGrow(node, x); });
    number("flexShrink", [&](float x) { YGNodeStyleSetFlexShrink(node, x); });
    number("aspectRatio", [&](float x) { YGNodeStyleSetAspectRatio(node, x); });
    number("gap", [&](float x) { YGNodeStyleSetGap(node, YGGutterAll, x); });
    number("rowGap", [&](float x) { YGNodeStyleSetGap(node, YGGutterRow, x); });
    number("columnGap", [&](float x) {
      YGNodeStyleSetGap(node, YGGutterColumn, x);
    });
    const std::pair<const char*, YGEdge> edges[] = {
        {"", YGEdgeAll},
        {"Horizontal", YGEdgeHorizontal},
        {"Vertical", YGEdgeVertical},
        {"Left", YGEdgeLeft},
        {"Top", YGEdgeTop},
        {"Right", YGEdgeRight},
        {"Bottom", YGEdgeBottom},
        {"Start", YGEdgeStart},
        {"End", YGEdgeEnd}};
    for (auto edge : edges) {
      number((std::string("padding") + edge.first).c_str(), [&](float x) {
        YGNodeStyleSetPadding(node, edge.second, x);
      });
      number((std::string("margin") + edge.first).c_str(), [&](float x) {
        YGNodeStyleSetMargin(node, edge.second, x);
      });
      number(
          (std::string("border") + edge.first + "Width").c_str(),
          [&](float x) { YGNodeStyleSetBorder(node, edge.second, x); });
    }
    for (auto edge : std::vector<std::pair<const char*, YGEdge>>{
             {"left", YGEdgeLeft},
             {"top", YGEdgeTop},
             {"right", YGEdgeRight},
             {"bottom", YGEdgeBottom}})
      number(edge.first, [&](float x) {
        YGNodeStyleSetPosition(node, edge.second, x);
      });
    auto text = [&](const char* name) {
      auto v = s.getProperty(rt, name);
      return v.isString() ? v.getString(rt).utf8(rt) : std::string();
    };
    auto direction = text("flexDirection");
    if (direction == "row")
      YGNodeStyleSetFlexDirection(node, YGFlexDirectionRow);
    else if (direction == "row-reverse")
      YGNodeStyleSetFlexDirection(node, YGFlexDirectionRowReverse);
    else if (direction == "column-reverse")
      YGNodeStyleSetFlexDirection(node, YGFlexDirectionColumnReverse);
    else
      YGNodeStyleSetFlexDirection(node, YGFlexDirectionColumn);
    auto align = [](const std::string& v) {
      if (v == "center")
        return YGAlignCenter;
      if (v == "flex-end")
        return YGAlignFlexEnd;
      if (v == "stretch")
        return YGAlignStretch;
      if (v == "baseline")
        return YGAlignBaseline;
      if (v == "auto")
        return YGAlignAuto;
      return YGAlignFlexStart;
    };
    auto items = text("alignItems");
    if (!items.empty())
      YGNodeStyleSetAlignItems(node, align(items));
    auto self = text("alignSelf");
    if (!self.empty())
      YGNodeStyleSetAlignSelf(node, align(self));
    auto justify = text("justifyContent");
    if (justify == "center")
      YGNodeStyleSetJustifyContent(node, YGJustifyCenter);
    else if (justify == "flex-end")
      YGNodeStyleSetJustifyContent(node, YGJustifyFlexEnd);
    else if (justify == "space-between")
      YGNodeStyleSetJustifyContent(node, YGJustifySpaceBetween);
    else if (justify == "space-around")
      YGNodeStyleSetJustifyContent(node, YGJustifySpaceAround);
    else if (justify == "space-evenly")
      YGNodeStyleSetJustifyContent(node, YGJustifySpaceEvenly);
    if (text("position") == "absolute")
      YGNodeStyleSetPositionType(node, YGPositionTypeAbsolute);
    if (text("display") == "none")
      YGNodeStyleSetDisplay(node, YGDisplayNone);
    if (text("flexWrap") == "wrap")
      YGNodeStyleSetFlexWrap(node, YGWrapWrap);
    if (text("direction") == "rtl")
      YGNodeStyleSetDirection(node, YGDirectionRTL);
  }
  std::unique_ptr<YogaTree>
  makeTree(jsi::Object obj, size_t depth, size_t& count) {
    if (depth > 128 || ++count > maxNodes)
      throw std::invalid_argument("tree limit exceeded");
    auto& rt = *runtime;
    auto node = std::make_unique<YogaTree>(YGNodeNew(), std::move(obj));
    auto props = node->object.getProperty(rt, "props");
    if (props.isObject()) {
      auto s = props.getObject(rt).getProperty(rt, "style");
      if (s.isObject() && !s.getObject(rt).isArray(rt))
        style(node->node, s.getObject(rt));
    }
    auto children = node->object.getProperty(rt, "children");
    if (!children.isUndefined()) {
      if (!children.isObject() || !children.getObject(rt).isArray(rt))
        throw std::invalid_argument("children must be array");
      auto array = children.getObject(rt).getArray(rt);
      for (size_t i = 0; i < array.size(rt); ++i) {
        auto child = array.getValueAtIndex(rt, i);
        if (!child.isObject())
          throw std::invalid_argument("child must be object");
        auto subtree = makeTree(child.getObject(rt), depth + 1, count);
        YGNodeInsertChild(node->node, subtree->node, node->children.size());
        node->children.push_back(std::move(subtree));
      }
    }
    return node;
  }
  void addBounds(YogaTree& tree, double parentX, double parentY) {
    auto& rt = *runtime;
    double x = parentX + YGNodeLayoutGetLeft(tree.node),
           y = parentY + YGNodeLayoutGetTop(tree.node);
    jsi::Object bounds(rt);
    bounds.setProperty(rt, "x", x);
    bounds.setProperty(rt, "y", y);
    bounds.setProperty(rt, "width", YGNodeLayoutGetWidth(tree.node));
    bounds.setProperty(rt, "height", YGNodeLayoutGetHeight(tree.node));
    tree.object.setProperty(rt, "bounds", std::move(bounds));
    jsi::Object local(rt);
    local.setProperty(rt, "x", YGNodeLayoutGetLeft(tree.node));
    local.setProperty(rt, "y", YGNodeLayoutGetTop(tree.node));
    local.setProperty(rt, "width", YGNodeLayoutGetWidth(tree.node));
    local.setProperty(rt, "height", YGNodeLayoutGetHeight(tree.node));
    tree.object.setProperty(rt, "layout", std::move(local));
    for (auto& child : tree.children)
      addBounds(*child, x, y);
  }
  std::string layout(const std::string& json, bool publish) {
    auto& rt = *runtime;
    auto value = parse(json);
    if (!value.isObject())
      throw std::invalid_argument("tree must be object");
    auto obj = value.getObject(rt);
    size_t count = 0;
    auto tree = makeTree(std::move(obj), 0, count);
    YGNodeStyleSetWidth(tree->node, static_cast<float>(width));
    YGNodeStyleSetHeight(tree->node, static_cast<float>(height));
    YGNodeCalculateLayout(
        tree->node,
        static_cast<float>(width),
        static_cast<float>(height),
        YGDirectionLTR);
    addBounds(*tree, 0, 0);
    auto snapshot = stringify(jsi::Value(rt, tree->object));
    if (publish) {
      if (commitCallback) {
        NativeCallbackScope scope(insideNativeCallback);
        commitCallback(commitContext, snapshot.c_str());
      }
      lastSnapshot = snapshot;
    }
    return snapshot;
  }
  void flushMount() {
    auto fn = runtime->global().getProperty(*runtime, "__nhFlushMount");
    if (fn.isObject() && fn.getObject(*runtime).isFunction(*runtime))
      fn.getObject(*runtime).getFunction(*runtime).call(*runtime);
  }
  void recordAsyncError(const char* message) {
    if (asyncErrors.size() < 256)
      asyncErrors.emplace_back(message);
    else
      ++suppressedAsyncErrors;
  }
  void microtasks() {
    if (!runtime->drainMicrotasks(10000))
      throw std::runtime_error(
          "microtask checkpoint exceeded execution budget");
  }
  void pump() {
    assertOwner();
    if (pumping)
      return;
    pumping = true;
    struct Guard {
      bool& flag;
      ~Guard() {
        flag = false;
      }
    } guard{pumping};
    auto& rt = *runtime;
    microtasks();
    for (size_t limit = 0; limit < 1024; ++limit) {
      NhEvent event{};
      auto status = nh_poll(services, generation, &event);
      if (status == 8)
        break;
      checkStatus(status, "poll");
      struct Release {
        NhEvent& e;
        ~Release() {
          nh_event_free(&e);
        }
      } release{event};
      auto callback = rt.global().getProperty(rt, "__nhServiceEvent");
      if (callback.isObject() && callback.getObject(rt).isFunction(rt)) {
        std::string payload(
            event.len ? reinterpret_cast<char*>(event.data) : "", event.len);
        auto json = "{\"generation\":" + std::to_string(event.generation) +
            ",\"id\":" + std::to_string(event.id) +
            ",\"kind\":" + quote(event.kind == 1 ? "request" : "subscription") +
            ",\"status\":" +
            quote(event.status == 0       ? "success"
                      : event.status == 2 ? "cancelled"
                                          : "error") +
            ",\"payload\":" + quote(payload) + "}";
        try {
          callback.getObject(rt).getFunction(rt).call(
              rt, jsi::String::createFromUtf8(rt, json));
          microtasks();
        } catch (const std::exception& e) {
          recordAsyncError(e.what());
        }
      }
    }
    // One due-timer batch per pump: recursively scheduled zero-delay timers
    // yield.
    std::vector<std::pair<double, uint64_t>> due;
    double tick = now();
    for (const auto& entry : timers)
      if (entry.second->due <= tick)
        due.emplace_back(entry.second->due, entry.first);
    std::sort(due.begin(), due.end());
    for (const auto& entry : due) {
      auto found = timers.find(entry.second);
      if (found == timers.end())
        continue;
      auto timer = found->second;
      if (timer->interval > 0)
        timer->due = now() + timer->interval;
      else
        timers.erase(found);
      try {
        timer->callback.call(
            rt,
            static_cast<const jsi::Value*>(timer->args.data()),
            timer->args.size());
        microtasks();
      } catch (const std::exception& e) {
        recordAsyncError(e.what());
      }
    }
    flushMount();
  }
  jsi::Value describe() {
    auto value = parse(
        "{\"protocolVersion\":1,\"runtime\":\"Hermes\",\"serviceCore\":\"Rust\",\"layout\":\"Yoga\",\"nativeWidgets\":false,\"capabilities\":[\"semantic-layout\",\"rust-async-services\",\"real-hermes\"]}");
    auto obj = value.getObject(*runtime);
    obj.setProperty(
        *runtime,
        "hermesVersion",
        jsi::String::createFromUtf8(*runtime, engineVersion));
    obj.setProperty(*runtime, "runtimeProperties", parse(runtimeMetadata));
    obj.setProperty(
        *runtime, "platform", jsi::String::createFromUtf8(*runtime, platform));
    obj.setProperty(*runtime, "generation", static_cast<double>(generation));
    obj.setProperty(*runtime, "nativeCommandVersion", 1);
#if defined(NH_DEV_UPDATES) && NH_DEV_UPDATES
    obj.setProperty(*runtime, "devUpdates", true);
#else
    obj.setProperty(*runtime, "devUpdates", false);
#endif
    obj.setProperty(*runtime, "nativeCommands", parse(commandCapabilities));
    obj.setProperty(*runtime, "nativeAppState", !appState.empty());
    obj.setProperty(
        *runtime,
        "appStateScope",
        jsi::String::createFromUtf8(
            *runtime,
            appState.empty()
                ? "unsupported"
                : (platform == "android" ? "single-activity" : "application")));
    obj.setProperty(
        *runtime,
        "nativeWidgets",
        commitCallback != nullptr &&
            (platform == "ios" || platform == "android"));
    obj.setProperty(
        *runtime, "nativeWidgetAdapterAttached", commitCallback != nullptr);
#ifdef NH_SERVICE_TEST_HOOKS
    obj.setProperty(*runtime, "serviceTestHooks", true);
#else
    obj.setProperty(*runtime, "serviceTestHooks", false);
#endif
#ifdef NH_TEST_HOOKS
    obj.setProperty(*runtime, "testHooks", true);
#else
    obj.setProperty(*runtime, "testHooks", false);
#endif
    return obj;
  }
  std::string dispatch(const std::string& request) {
    assertEntry();
    TaskScope task(taskDepth);
    auto& rt = *runtime;
    std::string id = "null";
    try {
      if (request.size() > maxJsonBytes)
        throw std::invalid_argument("request exceeds limit");
      auto value = parse(request);
      if (!value.isObject())
        throw std::invalid_argument("request must be object");
      auto obj = value.getObject(rt);
      id = stringify(obj.getProperty(rt, "id"));
      auto method = checkedString(rt, obj.getProperty(rt, "method"), "method");
      auto params = obj.getProperty(rt, "params");
      if (params.isUndefined())
        params = jsi::Object(rt);
      pump();
      jsi::Value result;
      if (method == "session.describe")
        result = describe();
      else if (method == "runtime.pump") {
        pump();
        jsi::Object info(rt);
        info.setProperty(rt, "timers", static_cast<double>(timers.size()));
        NhStats stats{};
        checkStatus(nh_runtime_stats(services, generation, &stats), "stats");
        info.setProperty(
            rt, "pendingRequests", static_cast<double>(stats.pending_requests));
        info.setProperty(
            rt, "queuedEvents", static_cast<double>(stats.queued_events));
        info.setProperty(
            rt, "subscriptions", static_cast<double>(stats.subscriptions));
        info.setProperty(
            rt, "retainedBytes", static_cast<double>(stats.retained_bytes));
        info.setProperty(
            rt,
            "appStateSubscriptions",
            static_cast<double>(appStateSubscriptions.size()));
        jsi::Array errors(rt, asyncErrors.size());
        for (size_t i = 0; i < asyncErrors.size(); ++i)
          errors.setValueAtIndex(
              rt, i, jsi::String::createFromUtf8(rt, asyncErrors[i]));
        info.setProperty(rt, "errors", std::move(errors));
        info.setProperty(
            rt, "suppressedErrors", static_cast<double>(suppressedAsyncErrors));
        result = std::move(info);
      } else if (method == "runtime.ackErrors") {
#ifdef NH_TEST_HOOKS
        jsi::Object acknowledged(rt);
        acknowledged.setProperty(
            rt,
            "acknowledged",
            static_cast<double>(asyncErrors.size()) +
                static_cast<double>(suppressedAsyncErrors));
        asyncErrors.clear();
        suppressedAsyncErrors = 0;
        result = std::move(acknowledged);
#else
        throw std::runtime_error("runtime.ackErrors requires test build");
#endif
      } else if (method == "runtime.eval") {
#ifdef NH_TEST_HOOKS
        if (!params.isObject())
          throw std::invalid_argument("eval params must be object");
        result = evaluate(
            checkedString(
                rt, params.getObject(rt).getProperty(rt, "source"), "source"),
            "native-host:test-eval");
        microtasks();
#else
        throw std::runtime_error("runtime.eval requires test build");
#endif
      } else if (method == "native.snapshot")
        result = parse(lastSnapshot);
      else {
#ifndef NH_TEST_HOOKS
        if (method != "app.event")
          throw std::runtime_error("protocol method requires test build");
#endif
        auto fn = rt.global().getProperty(rt, "__nhDispatch");
        if (!fn.isObject() || !fn.getObject(rt).isFunction(rt))
          throw std::runtime_error("bundle does not define __nhDispatch");
        result = fn.getObject(rt).getFunction(rt).call(
            rt, jsi::String::createFromUtf8(rt, method), params);
        microtasks();
      }
      flushMount();
      return "{\"id\":" + id + ",\"result\":" + stringify(result) + "}";
    } catch (const std::exception& e) {
      lastError = e.what();
      return errorJson(e.what(), id);
    }
  }
};

extern "C" NHHost* nh_host_create(
    const char* bundle_path,
    double width,
    double height,
    const char* platform,
    NHCommitCallback callback,
    void* context) {
  NHHostOptions options{
      NH_HOST_OPTIONS_VERSION,
      sizeof(NHHostOptions),
      callback,
      context,
      nullptr,
      nullptr,
      nullptr};
  return nh_host_create_with_options(
      bundle_path, width, height, platform, &options);
}
extern "C" NHHost* nh_host_create_with_options(
    const char* bundle_path,
    double width,
    double height,
    const char* platform,
    const NHHostOptions* options) {
  lastError.clear();
  try {
    if (!options || options->version != NH_HOST_OPTIONS_VERSION ||
        options->size < NH_HOST_OPTIONS_V1_SIZE)
      throw std::invalid_argument(
          "invalid native host options version or size");
    const char* capabilities = options->command_capabilities_json
        ? options->command_capabilities_json
        : "{}";
    if (strnlen(capabilities, 16385) > 16384)
      throw std::invalid_argument("command capabilities exceed size limit");
    const char* initialState = options->size >= sizeof(NHHostOptions)
        ? options->initial_app_state
        : nullptr;
    if (initialState && (strnlen(initialState, 11) > 10 || !*initialState))
      throw std::invalid_argument("invalid initial AppState");
    if (!std::isfinite(width) || !std::isfinite(height) || width <= 0 ||
        height <= 0 || width > 100000 || height > 100000)
      throw std::invalid_argument("invalid viewport");
    auto host = std::make_unique<NHHost>(
        width,
        height,
        platform ? platform : "headless",
        options->commit_callback,
        options->commit_context,
        options->command_callback,
        options->command_context,
        capabilities,
        initialState ? initialState : "");
    if (bundle_path && *bundle_path) {
      std::ifstream file(bundle_path, std::ios::binary);
      if (!file)
        throw std::runtime_error("cannot open bundle");
      std::ostringstream source;
      source << file.rdbuf();
#if defined(NH_DEV_UPDATES) && NH_DEV_UPDATES
      host->dev.initialDigest = nhdev::sha256(source.str());
#endif
      try {
        TaskScope task(host->taskDepth);
        host->evaluate(source.str(), bundle_path);
        host->pump();
      } catch (const std::exception& error) {
        // Release any Hermes exception value while host still owns its VM.
        throw std::runtime_error(error.what());
      }
    }
    return host.release();
  } catch (const std::exception& e) {
    lastError = e.what();
    return nullptr;
  } catch (...) {
    lastError = "unknown native host creation error";
    return nullptr;
  }
}
extern "C" char* nh_host_dispatch(NHHost* host, const char* request_json) {
  try {
    if (!host || !request_json)
      throw std::invalid_argument("host and request required");
    return owned(host->dispatch(request_json));
  } catch (const std::exception& e) {
    lastError = e.what();
    try {
      const char* code = entryErrorCode(lastError);
      return owned(errorJson(e.what(), "null", code));
    } catch (...) {
      return nullptr;
    }
  } catch (...) {
    lastError = "unknown native host dispatch error";
    try {
      return owned(errorJson(lastError));
    } catch (...) {
      return nullptr;
    }
  }
}
extern "C" char* nh_host_pump(NHHost* host) {
  return nh_host_dispatch(
      host, "{\"id\":null,\"method\":\"runtime.pump\",\"params\":{}}");
}
extern "C" char*
nh_host_app_state_update(NHHost* host, uint64_t generation, const char* state) {
  try {
    if (!host || !state || strnlen(state, 11) > 10)
      throw std::invalid_argument("host and bounded AppState required");
    return owned(host->updateAppState(generation, state));
  } catch (const std::exception& error) {
    lastError = error.what();
    const char* code = lastError.rfind("STALE_GENERATION:", 0) == 0
        ? "STALE_GENERATION"
        : lastError.rfind("UNSUPPORTED_SERVICE:", 0) == 0
        ? "UNSUPPORTED_SERVICE"
        : entryErrorCode(lastError);
    try {
      return owned(errorJson(lastError, "null", code));
    } catch (...) {
      return nullptr;
    }
  } catch (...) {
    try {
      return owned(errorJson("unknown AppState update error"));
    } catch (...) {
      return nullptr;
    }
  }
}
extern "C" void nh_host_destroy(NHHost* host) {
  try {
    if (host) {
      host->assertEntry(true);
      delete host;
    }
  } catch (const std::exception& e) {
    lastError = e.what();
  } catch (...) {
    lastError = "unknown native host destruction error";
  }
}
extern "C" void nh_host_string_free(char* value) {
  std::free(value);
}
extern "C" const char* nh_host_last_error(void) {
  return lastError.c_str();
}

#if defined(NH_DEV_UPDATES) && NH_DEV_UPDATES
namespace {
template <typename Call>
char* devCall(NHHost* host, Call call) noexcept {
  try {
    if (!host)
      throw std::runtime_error("DEV_SCHEMA: host required");
    return owned(call(*host));
  } catch (const std::exception& error) {
    lastError = error.what();
    try {
      auto separator = lastError.find(':');
      auto code = separator == std::string::npos
          ? "HOST_ERROR"
          : lastError.substr(0, separator);
      if (code.rfind("DEV_", 0) != 0 && code != "STALE_GENERATION" &&
          code != "REENTRANT_HOST_CALL")
        code = "HOST_ERROR";
      return owned(errorJson(lastError, "null", code));
    } catch (...) {
      return nullptr;
    }
  } catch (...) {
    try {
      return owned(errorJson("unknown development ingress error"));
    } catch (...) {
      return nullptr;
    }
  }
}
} // namespace
extern "C" char* nh_host_dev_open(NHHost* host, const NHDevSessionV1* session) {
  return devCall(host, [session](NHHost& h) { return h.devOpen(session); });
}
extern "C" char* nh_host_dev_enqueue(NHHost* host, const NHDevPatchV1* patch) {
  return devCall(host, [patch](NHHost& h) { return h.devEnqueue(patch); });
}
extern "C" char* nh_host_dev_drain(NHHost* host) {
  return devCall(host, [](NHHost& h) { return h.devDrain(); });
}
extern "C" char* nh_host_dev_status(NHHost* host) {
  return devCall(host, [](NHHost& h) { return h.devStatus(); });
}
#endif
