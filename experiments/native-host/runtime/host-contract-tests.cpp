#include <cassert>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include "host.h"

std::string dispatch(NHHost* host, const char* request) {
  char* value = nh_host_dispatch(host, request);
  assert(value);
  std::string result(value);
  nh_host_string_free(value);
  return result;
}

struct Commands {
  NHHost* host = nullptr;
  unsigned calls = 0;
  unsigned reentries = 0;
  std::string response = "{\"result\":null}";
  std::string request;
  bool nullResponse = false;
  bool throwResponse = false;
  bool checkReentry = false;
};

void checkReentry(Commands& commands) {
  if (!commands.host || !commands.checkReentry)
    return;
  auto response = dispatch(commands.host, "{\"method\":\"session.describe\"}");
  assert(
      response.find("\"code\":\"REENTRANT_HOST_CALL\"") != std::string::npos);
  char* pumped = nh_host_pump(commands.host);
  assert(pumped && std::strstr(pumped, "REENTRANT_HOST_CALL"));
  nh_host_string_free(pumped);
  nh_host_destroy(commands.host);
  assert(std::strstr(nh_host_last_error(), "REENTRANT_HOST_CALL"));
  ++commands.reentries;
}

char* commandCallback(void* context, const char* request) {
  auto& commands = *static_cast<Commands*>(context);
  ++commands.calls;
  commands.request = request;
  checkReentry(commands);
  if (commands.throwResponse)
    throw std::runtime_error("adapter failure");
  if (commands.nullResponse)
    return nullptr;
  char* result = static_cast<char*>(std::malloc(commands.response.size() + 1));
  assert(result);
  std::memcpy(result, commands.response.c_str(), commands.response.size() + 1);
  return result;
}

void commandContracts() {
  Commands commands;
  NHHostOptions options{
      NH_HOST_OPTIONS_VERSION,
      sizeof(NHHostOptions),
      [](void* context, const char*) {
        checkReentry(*static_cast<Commands*>(context));
      },
      &commands,
      commandCallback,
      &commands,
      R"({"TextInput":["focus","blur","clear"],"ScrollView":["scrollTo","scrollToEnd"],"WebView":["goBack","goForward","reload","stopLoading","postMessage","injectJavaScript"]})"};
  auto invalid = options;
  invalid.version = 99;
  assert(!nh_host_create_with_options(nullptr, 100, 100, "headless", &invalid));
  invalid = options;
  invalid.size = 0;
  assert(!nh_host_create_with_options(nullptr, 100, 100, "headless", &invalid));
  for (const char* capabilities :
       {"[]",
        "null",
        "{",
        R"({"Bogus":["focus"]})",
        R"({"TextInput":["goBack"]})",
        R"({"TextInput":["focus","focus"]})"}) {
    invalid = options;
    invalid.command_capabilities_json = capabilities;
    assert(
        !nh_host_create_with_options(nullptr, 100, 100, "headless", &invalid));
  }
  invalid = options;
  invalid.command_callback = nullptr;
  assert(!nh_host_create_with_options(nullptr, 100, 100, "headless", &invalid));
  std::string oversizedCapabilities(16385, 'x');
  invalid = options;
  invalid.command_capabilities_json = oversizedCapabilities.c_str();
  assert(!nh_host_create_with_options(nullptr, 100, 100, "headless", &invalid));

  const auto path = std::filesystem::temp_directory_path() /
      ("native-host-command-" +
       std::to_string(
           std::chrono::steady_clock::now().time_since_epoch().count()) +
       ".js");
  {
    std::ofstream file(path);
    file << R"JS(
      function mount() {
        __nhCommit(JSON.stringify({revision:1,children:
          ['TextInput','ScrollView','WebView','View'].map((type,index) =>
            ({id:index+1,type,props:{style:{width:20,height:20}},children:[]}))}));
      }
      mount();
      __nhCommand(JSON.stringify({version:1,generation:__nhGeneration,nodeId:1,name:'focus',args:{}}));
      globalThis.__nhDispatch = (method,p) => {
        if(p.action === 'remove') return __nhCommit(JSON.stringify({revision:2,children:[]}));
        if(p.action === 'mount') { mount(); return null; }
        try {
          return {accepted: __nhCommand(p.raw !== undefined ? p.raw : JSON.stringify({
            version:p.version === undefined ? 1 : p.version,
            generation:__nhGeneration + (p.stale ? 1 : 0),
            nodeId:p.nodeId === undefined ? 1 : p.nodeId,
            name:p.name || 'focus', args:p.args === undefined ? {} : p.args
          }))};
        } catch(error) { return {code:error.code,message:error.message}; }
      };
    )JS";
  }
  // The same startup command must reject explicitly without a backend. This
  // also exercises destruction of a JS exception before its creating VM dies.
  assert(!nh_host_create(path.c_str(), 100, 100, "headless", nullptr, nullptr));
  assert(std::strstr(nh_host_last_error(), "unsupported native command"));
  commands.host =
      nh_host_create_with_options(path.c_str(), 100, 100, "headless", &options);
  std::filesystem::remove(path);
  assert(commands.host);
  assert(commands.calls == 1); // Callback registered before bundle evaluation.
  auto description =
      dispatch(commands.host, R"({"method":"session.describe"})");
  assert(description.find("nativeCommandVersion\":1") != std::string::npos);
  assert(description.find("\"WebView\":[\"goBack\"") != std::string::npos);
  auto invoke = [&](const std::string& params) {
    return dispatch(
        commands.host,
        ("{\"method\":\"app.event\",\"params\":" + params + "}").c_str());
  };
  const unsigned beforeInvalid = commands.calls;
  for (const char* params :
       {R"({"version":2})",
        R"({"raw":"{"})",
        R"({"raw":null})",
        R"({"args":[]})",
        R"({"nodeId":1.5})",
        R"({"args":{"x":1}})",
        R"({"nodeId":2,"name":"scrollTo","args":{"x":10000001}})",
        R"({"nodeId":2,"name":"scrollTo","args":{"animated":1}})",
        R"({"nodeId":3,"name":"postMessage","args":{"data":7}})",
        R"({"nodeId":3,"name":"injectJavaScript","args":{}})"})
    assert(invoke(params).find("INVALID_COMMAND") != std::string::npos);
  assert(
      invoke(R"({"stale":true})").find("STALE_GENERATION") !=
      std::string::npos);
  assert(invoke(R"({"nodeId":999})").find("STALE_NODE") != std::string::npos);
  assert(
      invoke(R"({"nodeId":4})").find("UNSUPPORTED_COMMAND") !=
      std::string::npos);
  assert(
      invoke(R"({"name":"goBack"})").find("UNSUPPORTED_COMMAND") !=
      std::string::npos);
  assert(
      invoke(
          "{\"nodeId\":3,\"name\":\"postMessage\",\"args\":{\"data\":\"" +
          std::string(1024 * 1024 + 1, 'x') + "\"}}")
          .find("INVALID_COMMAND") != std::string::npos);
  assert(commands.calls == beforeInvalid);
  for (
      const char* params :
      {R"({"name":"focus"})",
       R"({"name":"blur"})",
       R"({"name":"clear"})",
       R"({"nodeId":2,"name":"scrollTo","args":{"x":-1,"y":8,"animated":false}})",
       R"({"nodeId":2,"name":"scrollToEnd","args":{"animated":true}})",
       R"({"nodeId":3,"name":"goBack"})",
       R"({"nodeId":3,"name":"goForward"})",
       R"({"nodeId":3,"name":"reload"})",
       R"({"nodeId":3,"name":"stopLoading"})",
       R"({"nodeId":3,"name":"postMessage","args":{"data":"hi"}})",
       R"({"nodeId":3,"name":"injectJavaScript","args":{"source":"void 0"}})"})
    assert(invoke(params).find("\"accepted\":null") != std::string::npos);
  commands.checkReentry = true;
  assert(invoke("{}").find("\"accepted\":null") != std::string::npos);
  invoke(R"({"action":"mount"})");
  assert(commands.reentries == 2);
  commands.checkReentry = false;
  commands.response =
      R"({"error":{"code":"PLATFORM_DENIED","message":"test denial"}})";
  assert(invoke("{}").find("PLATFORM_DENIED") != std::string::npos);
  assert(
      invoke("{}").find("TextInput.focus: test denial") != std::string::npos);
  for (const std::string response :
       {std::string("{"),
        std::string("null"),
        std::string("{}"),
        std::string(R"({"result":null,"error":{}})"),
        std::string(R"({"result":true})"),
        std::string(R"({"error":{"code":7,"message":"bad"}})"),
        std::string(65537, 'x')}) {
    commands.response = response;
    assert(invoke("{}").find("NATIVE_COMMAND_ERROR") != std::string::npos);
  }
  commands.nullResponse = true;
  assert(invoke("{}").find("NATIVE_COMMAND_ERROR") != std::string::npos);
  commands.nullResponse = false;
  commands.throwResponse = true;
  assert(invoke("{}").find("NATIVE_COMMAND_ERROR") != std::string::npos);
  commands.throwResponse = false;
  commands.response = R"({"result":null})";
  assert(invoke("{}").find("\"accepted\":null") != std::string::npos);
  std::string wrongThread;
  auto beforeWrongThread = commands.calls;
  std::thread wrong([&] { wrongThread = invoke("{}"); });
  wrong.join();
  assert(wrongThread.find("non-owner thread") != std::string::npos);
  assert(commands.calls == beforeWrongThread);
  invoke(R"({"action":"remove"})");
  assert(invoke("{}").find("STALE_NODE") != std::string::npos);
  nh_host_destroy(commands.host);
}

// The native ingress below is an explicit simulated OS producer. JS executes
// the real service wrapper in Hermes and Rust owns actual async delivery; these
// are boundary tests, not evidence that a physical OS transition occurred.
void appStateContracts() {
  struct LegacyOptions {
    uint32_t version;
    size_t size;
    NHCommitCallback commit;
    void* commitContext;
    NHCommandCallback command;
    void* commandContext;
    const char* capabilities;
  } legacy{
      1, sizeof(LegacyOptions), nullptr, nullptr, nullptr, nullptr, nullptr};
  static_assert(sizeof(LegacyOptions) == NH_HOST_OPTIONS_V1_SIZE);
  NHHost* old = nh_host_create_with_options(
      nullptr,
      100,
      100,
      "headless",
      reinterpret_cast<const NHHostOptions*>(&legacy));
  assert(old);
  assert(
      dispatch(old, R"({"method":"session.describe"})")
          .find("\"nativeAppState\":false") != std::string::npos);
  nh_host_destroy(old);

  std::ifstream services(
      std::filesystem::path(__FILE__).parent_path().parent_path() /
      "js/services.js");
  assert(services);
  std::string source((std::istreambuf_iterator<char>(services)), {});
  // services.js has no imports; remove export declarations only, preserving
  // its implementation byte-for-byte for direct embedded-Hermes execution.
  for (size_t at = 0;
       (at = source.find("export function ", at)) != std::string::npos;)
    source.erase(at, 7);
  auto path = std::filesystem::temp_directory_path() /
      ("native-host-app-state-" +
       std::to_string(
           std::chrono::steady_clock::now().time_since_epoch().count()) +
       ".js");
  {
    std::ofstream file(path);
    file << "globalThis.__NH_TEST_HOOKS__=false;\n"
         << source << R"JS(
      const states=[], snapshots=[], failures=[];
      let subscription;
      globalThis.__nhDispatch = (_,p) => {
        try {
          if(p.action==='snapshot') {
            const request=getAppState();
            request.promise.then(value=>snapshots.push(value), error=>failures.push(error.code));
            return {settled:snapshots.length,cancelStatus:p.cancel ? request.cancel() : null};
          }
          if(p.action==='subscribe') {
            subscription=subscribeAppState(value=>{
              states.push(value);
              if(p.once) subscription.unsubscribe();
            });
            return subscription.id;
          }
          if(p.action==='unsubscribe') return subscription.unsubscribe();
          if(p.action==='forge') return __nhPublish(subscription.id,'{}');
          if(p.action==='capacity') {
            const ids=[]; try { for(let i=0;i<65;i++) ids.push(subscribeAppState(()=>{})); }
            catch(error) { return {count:ids.length,code:error.code}; }
            finally { ids.forEach(value=>value.unsubscribe()); }
          }
          return {states,snapshots,failures,generation:__nhGeneration,settledRequests:snapshots.length+failures.length};
        } catch(error) { return {code:error.code,message:error.message}; }
      };
    )JS";
  }
  NHHostOptions options{};
  options.version = NH_HOST_OPTIONS_VERSION;
  options.size = sizeof(options);
  options.initial_app_state = "active";
  assert(!nh_host_create_with_options(nullptr, 100, 100, "headless", &options));
  options.initial_app_state = "inactive";
  assert(!nh_host_create_with_options(nullptr, 100, 100, "android", &options));
  options.initial_app_state = "active";
  NHHost* host =
      nh_host_create_with_options(path.c_str(), 100, 100, "ios", &options);
  assert(host);
  auto invoke = [&](const char* params) {
    return dispatch(
        host,
        (std::string("{\"method\":\"app.event\",\"params\":") + params + "}")
            .c_str());
  };
  auto description = dispatch(host, R"({"method":"session.describe"})");
  assert(description.find("\"nativeAppState\":true") != std::string::npos);
  auto generationAt =
      description.find("\"generation\":") + std::strlen("\"generation\":");
  uint64_t generation = std::stoull(description.substr(generationAt));
  auto update = [&](uint64_t requested, const char* state) {
    char* raw = nh_host_app_state_update(host, requested, state);
    assert(raw);
    std::string result(raw);
    nh_host_string_free(raw);
    return result;
  };
  assert(
      invoke(R"({"action":"snapshot"})").find("\"settled\":0") !=
      std::string::npos);
  assert(
      update(generation, "background").find("\"changed\":true") !=
      std::string::npos);
  // Completion carries the active value captured before the OS update.
  std::string observed;
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  do {
    observed = invoke("{}");
    if (observed.find("\"snapshots\":[{") != std::string::npos)
      break;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  } while (std::chrono::steady_clock::now() < deadline);
  assert(observed.find("\"state\":\"active\"") != std::string::npos);
  assert(observed.find("\"source\":\"native-lifecycle\"") != std::string::npos);
  invoke(R"({"action":"subscribe","once":true})");
  assert(
      invoke(R"({"action":"forge"})").find("INVALID_SERVICE_ARGUMENT") !=
      std::string::npos);
  assert(
      update(generation, "inactive").find("\"changed\":true") !=
      std::string::npos);
  assert(
      update(generation, "active").find("\"changed\":true") !=
      std::string::npos);
  observed = invoke("{}");
  // The callback's reentrant unsubscribe drops the second queued transition.
  assert(
      observed.find("\"states\":[{\"schemaVersion\":1") != std::string::npos);
  assert(observed.find("\"state\":\"inactive\"") != std::string::npos);
  assert(observed.find("},{") == std::string::npos);
  assert(
      update(generation, "active").find("\"changed\":false") !=
      std::string::npos);
  assert(
      update(generation + 1, "background").find("STALE_GENERATION") !=
      std::string::npos);
  assert(update(generation, "bogus").find("error") != std::string::npos);
  std::string wrongThread;
  std::thread wrong([&] { wrongThread = update(generation, "background"); });
  wrong.join();
  assert(wrongThread.find("non-owner thread") != std::string::npos);
  assert(
      invoke(R"({"action":"capacity"})")
          .find("\"count\":64,\"code\":\"SERVICE_CAPACITY\"") !=
      std::string::npos);
  auto stats = dispatch(host, R"({"method":"runtime.pump"})");
  assert(stats.find("\"appStateSubscriptions\":0") != std::string::npos);
  assert(stats.find("\"subscriptions\":0") != std::string::npos);
  invoke(R"({"action":"snapshot","cancel":true})");
  for (int i = 0; i < 20; ++i) {
    invoke("{}");
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  assert(invoke("{}").find("\"settledRequests\":2") != std::string::npos);
  invoke(R"({"action":"subscribe"})");
  update(generation, "background");
  invoke(R"({"action":"snapshot"})");
  update(generation, "inactive");
  nh_host_destroy(host); // pending completion/subscription captures released.
  host = nh_host_create_with_options(path.c_str(), 100, 100, "ios", &options);
  assert(host);
  assert(
      update(generation, "background").find("STALE_GENERATION") !=
      std::string::npos);
  assert(
      invoke("{}").find("\"states\":[],\"snapshots\":[],\"failures\":[]") !=
      std::string::npos);
  nh_host_destroy(host);
  host = nh_host_create(path.c_str(), 100, 100, "headless", nullptr, nullptr);
  assert(host);
  assert(
      invoke(R"({"action":"snapshot"})").find("UNSUPPORTED_SERVICE") !=
      std::string::npos);
  assert(
      invoke(R"({"action":"subscribe"})").find("UNSUPPORTED_SERVICE") !=
      std::string::npos);
  nh_host_destroy(host);
  std::filesystem::remove(path);
}

int main() {
  appStateContracts();
  commandContracts();
  assert(
      nh_host_create(nullptr, -1, 100, "headless", nullptr, nullptr) ==
      nullptr);
  assert(std::strstr(nh_host_last_error(), "viewport"));
  int commits = 0;
  NHHost* host = nh_host_create(
      nullptr,
      390,
      844,
      "headless",
      [](void* context, const char*) { ++*static_cast<int*>(context); },
      &commits);
  assert(host);
  std::string wrongThread;
  std::thread wrong([&] {
    wrongThread = dispatch(host, "{\"id\":1,\"method\":\"session.describe\"}");
  });
  wrong.join();
  assert(wrongThread.find("non-owner thread") != std::string::npos);
  auto describe = dispatch(host, "{\"id\":1,\"method\":\"session.describe\"}");
  assert(describe.find("Hermes") != std::string::npos);
  assert(describe.find("Rust") != std::string::npos);
  auto result = dispatch(
      host,
      "{\"id\":2,\"method\":\"runtime.eval\",\"params\":{\"source\":\"1+2\"}}");
#ifdef NH_TEST_HOOKS
  assert(result.find("\"result\":3") != std::string::npos);
  result = dispatch(
      host,
      R"JSON({"id":3,"method":"runtime.eval","params":{"source":"__nhLayout(JSON.stringify({revision:1,children:[{id:1,type:'View',props:{style:{width:40,height:50}},children:[]}]}))"}})JSON");
  assert(result.find("error") == std::string::npos);
  assert(commits == 0);
  result = dispatch(
      host,
      R"JSON({"id":4,"method":"runtime.eval","params":{"source":"__nhCommit(JSON.stringify({revision:1,children:[{id:1,type:'View',props:{style:{width:40,height:50}},children:[]}]}))"}})JSON");
  assert(result.find("error") == std::string::npos);
  assert(commits == 1);
#else
  assert(result.find("requires test build") != std::string::npos);
  result =
      dispatch(host, "{\"id\":3,\"method\":\"scenario.load\",\"params\":{}}");
  assert(result.find("requires test build") != std::string::npos);
  result = dispatch(host, "{\"id\":4,\"method\":\"runtime.ackErrors\"}");
  assert(result.find("requires test build") != std::string::npos);
#endif
  result = dispatch(host, "not JSON");
  assert(result.find("error") != std::string::npos);
  result = dispatch(host, "{\"id\":5,\"method\":\"runtime.pump\"}");
  assert(result.find("error\":") == std::string::npos);
  nh_host_destroy(host);
  std::cout
      << "PASS: actual Hermes identity, native command capabilities/ownership/reentrancy, owner-thread rejection, malformed input recovery, hook gating";
#ifdef NH_TEST_HOOKS
  std::cout << ", unpublished Yoga layout and commit publication";
#endif
  std::cout << '\n';
}
