#include <cassert>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>
#include "Integrity.h"
#include "host.h"

std::string take(char* value) {
  assert(value);
  std::string result(value);
  nh_host_string_free(value);
  return result;
}
void contains(const std::string& value, const char* needle) {
  if (value.find(needle) == std::string::npos) {
    std::cerr << "missing " << needle << " in " << value << '\n';
    std::abort();
  }
}
uint64_t generation(NHHost* host) {
  auto status = take(nh_host_dev_status(host));
  auto at = status.find("\"generation\":");
  assert(at != std::string::npos);
  return std::stoull(status.substr(at + 13));
}
NHDevSessionV1 session(NHHost* host, const std::string& initial = "") {
  NHDevSessionV1 value{};
  value.version = 1;
  value.size = sizeof(value);
  value.generation = generation(host);
  value.session_id[0] = 42;
  std::strcpy(value.initial_revision, "base");
  auto digest = nhdev::sha256(initial);
  std::copy(digest.begin(), digest.end(), value.initial_bundle_sha256);
  return value;
}
NHDevPatchV1 patch(
    const NHDevSessionV1& session,
    const std::string& source,
    uint64_t sequence = 1,
    const char* base = "base",
    const char* target = "next") {
  NHDevPatchV1 value{};
  value.version = 1;
  value.size = sizeof(value);
  value.generation = session.generation;
  std::copy(
      std::begin(session.session_id),
      std::end(session.session_id),
      value.session_id);
  value.sequence = sequence;
  std::strcpy(value.base_revision, base);
  std::strcpy(value.target_revision, target);
  auto digest = nhdev::sha256(source);
  std::copy(digest.begin(), digest.end(), value.payload_sha256);
  value.payload = reinterpret_cast<const uint8_t*>(source.data());
  value.payload_length = source.size();
  return value;
}
std::string dispatch(NHHost* host, const char* method) {
  return take(nh_host_dispatch(host, method));
}
const std::string initial = R"JS(
globalThis.counter=0;globalThis.timerRan=0;globalThis.serviceEvents=0;
globalThis.__nhFlushMount=function(){};
globalThis.__nhApplyDevUpdate=function(){return {status:'applied'}};
globalThis.__nhServiceEvent=function(){serviceEvents++};
globalThis.__nhDispatch=function(){return {counter,timerRan,serviceEvents}};
)JS";
NHHost* create(
    const std::string& source = initial,
    NHCommitCallback callback = nullptr,
    void* context = nullptr) {
  static unsigned id = 0;
  auto file = std::filesystem::temp_directory_path() /
      ("nh-dev-test-" + std::to_string(++id) + ".js");
  {
    std::ofstream out(file);
    out << source;
  }
  auto host =
      nh_host_create(file.c_str(), 100, 100, "headless", callback, context);
  std::filesystem::remove(file);
  if (!host) {
    std::cerr << nh_host_last_error() << '\n';
    std::abort();
  }
  auto config = session(host, source);
  contains(take(nh_host_dev_open(host, &config)), "\"opened\":true");
  return host;
}
void integrity() {
  assert(
      nhdev::hex(nhdev::sha256("")) ==
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert(
      nhdev::hex(nhdev::sha256("abc")) ==
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert(
      nhdev::hex(nhdev::sha256(std::string(1000000, 'a'))) ==
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  assert(
      nhdev::hex(
          nhdev::sha256(
              "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")) ==
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
}
void schemaAndQueue() {
  auto host = nh_host_create(nullptr, 100, 100, "headless", nullptr, nullptr);
  assert(host);
  auto config = session(host);
  auto bad = config;
  bad.size = 0;
  contains(take(nh_host_dev_open(host, &bad)), "DEV_SCHEMA");
  bad = config;
  bad.initial_bundle_sha256[0] ^= 1;
  contains(take(nh_host_dev_open(host, &bad)), "DEV_HASH_MISMATCH");
  contains(take(nh_host_dev_open(host, &config)), "\"opened\":true");
  contains(take(nh_host_dev_open(host, &config)), "DEV_ALREADY_OPEN");
  std::string source = "globalThis.testValue=1;({status:'applied'})";
  auto p = patch(config, source);
  auto invalid = p;
  invalid.version = 2;
  contains(take(nh_host_dev_enqueue(host, &invalid)), "DEV_SCHEMA");
  invalid = p;
  invalid.size = 1;
  contains(take(nh_host_dev_enqueue(host, &invalid)), "DEV_SCHEMA");
  invalid = p;
  invalid.generation++;
  contains(take(nh_host_dev_enqueue(host, &invalid)), "STALE_GENERATION");
  invalid = p;
  invalid.session_id[0]++;
  contains(take(nh_host_dev_enqueue(host, &invalid)), "DEV_STALE_SESSION");
  invalid = p;
  invalid.sequence = 2;
  contains(take(nh_host_dev_enqueue(host, &invalid)), "DEV_SEQUENCE");
  invalid = p;
  std::strcpy(invalid.base_revision, "old");
  contains(take(nh_host_dev_enqueue(host, &invalid)), "DEV_BASE_MISMATCH");
  invalid = p;
  invalid.payload_length = NH_DEV_PATCH_MAX_BYTES + 1;
  contains(take(nh_host_dev_enqueue(host, &invalid)), "DEV_SCHEMA");
  invalid = p;
  invalid.payload_sha256[0] ^= 1;
  contains(take(nh_host_dev_enqueue(host, &invalid)), "DEV_HASH_MISMATCH");
  std::thread thread([&] {
    contains(take(nh_host_dev_enqueue(host, &p)), "non-owner");
    contains(take(nh_host_dev_status(host)), "non-owner");
  });
  thread.join();
  auto queued = take(nh_host_dev_enqueue(host, &p));
  contains(queued, "queued");
  assert(take(nh_host_dev_enqueue(host, &p)) == queued);
  invalid = p;
  invalid.sequence = 2;
  contains(take(nh_host_dev_enqueue(host, &invalid)), "DEV_QUEUE_FULL");
  invalid = p;
  std::strcpy(invalid.target_revision, "conflict");
  contains(take(nh_host_dev_enqueue(host, &invalid)), "DEV_SEQUENCE_CONFLICT");
  auto original = source;
  source.assign(
      source.size(), '!'); // Caller buffer may be released/mutated immediately.
  auto applied = take(nh_host_dev_drain(host));
  contains(applied, "\"status\":\"applied\"");
  p = patch(config, original);
  assert(take(nh_host_dev_enqueue(host, &p)) == applied);
  contains(take(nh_host_dev_status(host)), "\"retainedPayloadBytes\":0");
  contains(take(nh_host_dev_status(host)), "\"revision\":\"next\"");
  auto pending = patch(config, original, 2, "next", "later");
  contains(take(nh_host_dev_enqueue(host, &pending)), "queued");
  nh_host_destroy(
      host); // Pending source ownership is released during teardown.
  auto next = nh_host_create(nullptr, 100, 100, "headless", nullptr, nullptr);
  auto nextConfig = session(next);
  take(nh_host_dev_open(next, &nextConfig));
  contains(take(nh_host_dev_enqueue(next, &p)), "STALE_GENERATION");
  nh_host_destroy(next);
}
void prepareAndLifetime() {
  auto host = create();
  auto config = session(host, initial);
  std::string source = "globalThis.counter=99; function broken( {";
  auto p = patch(config, source);
  take(nh_host_dev_enqueue(host, &p));
  contains(take(nh_host_dev_drain(host)), "\"phase\":\"prepare\"");
  contains(take(nh_host_dev_status(host)), "\"revision\":\"base\"");
  contains(dispatch(host, R"({"method":"app.event"})"), "\"counter\":0");
  source =
      "counter++;setTimeout(()=>timerRan++,0);__nhEcho('pending',0);__nhApplyDevUpdate({})";
  p = patch(config, source, 2);
  take(nh_host_dev_enqueue(host, &p));
  contains(take(nh_host_dev_drain(host)), "\"status\":\"applied\"");
  assert(generation(host) == config.generation);
  // A second patch observes that the first drain did not run timers/service
  // callbacks.
  source =
      "if(timerRan||serviceEvents)throw Error('drain pumped unrelated work');counter++;__nhApplyDevUpdate({})";
  p = patch(config, source, 3, "next", "third");
  take(nh_host_dev_enqueue(host, &p));
  contains(take(nh_host_dev_drain(host)), "\"status\":\"applied\"");
  contains(dispatch(host, R"({"method":"app.event"})"), "\"counter\":2");
  contains(take(nh_host_dev_status(host)), "\"reloadRequired\":false");
  nh_host_destroy(host);
}
void poison() {
  for (
      const std::string source :
      {"counter++;throw Error('module failure')",
       "while(true){}",
       "counter++;({status:'not-applied'})",
       "Promise.resolve({status:'applied'})",
       "Object.assign(Promise.resolve(),{status:'applied'})",
       "__nhFlushMount=()=>{throw Error('mount failure')};({status:'applied'})",
       "queueMicrotask(function loop(){queueMicrotask(loop)});({status:'applied'})"}) {
    auto host = create();
    auto config = session(host, initial);
    auto p = patch(config, source);
    take(nh_host_dev_enqueue(host, &p));
    auto failed = take(nh_host_dev_drain(host));
    contains(failed, "reload-required");
    contains(take(nh_host_dev_status(host)), "\"revision\":\"base\"");
    contains(take(nh_host_dev_status(host)), "\"reloadRequired\":true");
    contains(take(nh_host_dev_drain(host)), "DEV_RELOAD_REQUIRED");
    contains(take(nh_host_dev_enqueue(host, &p)), "DEV_RELOAD_REQUIRED");
    contains(take(nh_host_pump(host)), "DEV_RELOAD_REQUIRED");
    contains(
        dispatch(host, R"({"method":"app.event"})"), "DEV_RELOAD_REQUIRED");
    nh_host_destroy(host);
  }
  auto recovered = create();
  contains(take(nh_host_dev_status(recovered)), "\"reloadRequired\":false");
  nh_host_destroy(recovered);
}
struct Reentry {
  NHHost* host = nullptr;
  unsigned count = 0;
};
void reentry() {
  Reentry r;
  auto host = create(
      initial,
      [](void* context, const char*) {
        auto& r = *static_cast<Reentry*>(context);
        assert(r.host);
        contains(take(nh_host_dev_drain(r.host)), "REENTRANT_HOST_CALL");
        contains(take(nh_host_dev_status(r.host)), "REENTRANT_HOST_CALL");
        contains(
            take(nh_host_dev_enqueue(r.host, nullptr)), "REENTRANT_HOST_CALL");
        contains(take(nh_host_pump(r.host)), "REENTRANT_HOST_CALL");
        nh_host_destroy(r.host);
        assert(std::strstr(nh_host_last_error(), "REENTRANT_HOST_CALL"));
        r.count++;
      },
      &r);
  r.host = host;
  auto config = session(host, initial);
  std::string source =
      R"(globalThis.__nhFlushMount=()=>__nhCommit('{"revision":1,"children":[]}');({status:'applied'}))";
  auto p = patch(config, source);
  take(nh_host_dev_enqueue(host, &p));
  contains(take(nh_host_dev_drain(host)), "\"status\":\"applied\"");
  assert(r.count == 1);
  nh_host_destroy(host);
}
void appStateContinuity() {
  auto file = std::filesystem::temp_directory_path() / "nh-dev-appstate.js";
  std::string source = initial + R"JS(
    globalThis.states=[];
    globalThis.subscription=__nhAppStateSubscribe();
    globalThis.__nhServiceEvent=function(event){states.push(JSON.parse(event))};
    globalThis.__nhDispatch=function(){return states};
  )JS";
  {
    std::ofstream out(file);
    out << source;
  }
  NHHostOptions options{};
  options.version = NH_HOST_OPTIONS_VERSION;
  options.size = sizeof(options);
  options.initial_app_state = "active";
  auto host =
      nh_host_create_with_options(file.c_str(), 100, 100, "ios", &options);
  assert(host);
  std::filesystem::remove(file);
  auto config = session(host, source);
  take(nh_host_dev_open(host, &config));
  contains(
      take(nh_host_app_state_update(host, config.generation, "background")),
      "\"changed\":true");
  std::string update =
      "if(states.length)throw Error('unexpected service drain');__nhAppStateSnapshot();({status:'applied'})";
  auto p = patch(config, update);
  take(nh_host_dev_enqueue(host, &p));
  contains(take(nh_host_dev_drain(host)), "\"status\":\"applied\"");
  contains(
      take(nh_host_app_state_update(host, config.generation, "active")),
      "\"changed\":true");
  contains(dispatch(host, R"({"method":"app.event"})"), "subscription");
  contains(take(nh_host_pump(host)), "\"appStateSubscriptions\":1");
  update = "__nhUnsubscribe(subscription);states=[];({status:'applied'})";
  p = patch(config, update, 2, "next", "unsubscribed");
  take(nh_host_dev_enqueue(host, &p));
  contains(take(nh_host_dev_drain(host)), "\"status\":\"applied\"");
  take(nh_host_app_state_update(host, config.generation, "background"));
  contains(take(nh_host_pump(host)), "\"appStateSubscriptions\":0");
  nh_host_destroy(host);
}
int main() {
  appStateContinuity();
  integrity();
  schemaAndQueue();
  prepareAndLifetime();
  poison();
  reentry();
  std::cout << "dev ingress contracts passed\n";
}
