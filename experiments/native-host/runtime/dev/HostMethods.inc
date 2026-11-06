// Included inside NHHost only for NH_DEV_UPDATES builds.
struct DevPatch {
  uint64_t sequence;
  std::string base, target, payload;
  nhdev::Digest digest;
};
struct DevState {
  nhdev::Digest initialDigest = nhdev::sha256(nullptr, 0);
  bool opened = false;
  bool poisoned = false;
  std::array<uint8_t, 16> session{};
  std::string revision;
  uint64_t acceptedSequence = 0;
  std::unique_ptr<DevPatch> pending;
  // Only identity retained for replay; never retain a completed source buffer.
  uint64_t lastSequence = 0;
  std::string lastBase, lastTarget, terminal;
  nhdev::Digest lastDigest{};
  std::string failurePhase, failureMessage;
} dev;
static void devRequire(bool condition, const char* code, const char* message) {
  if (!condition)
    throw std::runtime_error(std::string(code) + ": " + message);
}
static std::string devRevision(const char* text) {
  auto size = strnlen(text, 65);
  devRequire(size > 0 && size <= 64, "DEV_SCHEMA", "invalid revision length");
  for (size_t i = 0; i < size; ++i) {
    auto c = text[i];
    devRequire(
        (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-',
        "DEV_SCHEMA",
        "invalid revision character");
  }
  return std::string(text, size);
}
std::string devStatus() {
  assertEntry(true);
  return "{\"id\":null,\"result\":{\"version\":1,\"generation\":" +
      std::to_string(generation) +
      ",\"enabled\":true,\"opened\":" + (dev.opened ? "true" : "false") +
      ",\"reloadRequired\":" + (dev.poisoned ? "true" : "false") +
      ",\"sessionId\":" +
      quote(nhdev::hex(dev.session.data(), dev.session.size())) +
      ",\"initialBundleSha256\":" + quote(nhdev::hex(dev.initialDigest)) +
      ",\"revision\":" + quote(dev.revision) +
      ",\"acceptedSequence\":" + quote(std::to_string(dev.acceptedSequence)) +
      ",\"pending\":" + (dev.pending ? "true" : "false") +
      ",\"retainedPayloadBytes\":" +
      std::to_string(dev.pending ? dev.pending->payload.size() : 0) +
      ",\"failurePhase\":" + quote(dev.failurePhase) +
      ",\"failureMessage\":" + quote(dev.failureMessage) + "}}";
}
std::string devOpen(const NHDevSessionV1* session) {
  assertEntry();
  devRequire(
      session && session->version == NH_DEV_UPDATES_VERSION &&
          session->size >= sizeof(NHDevSessionV1),
      "DEV_SCHEMA",
      "invalid session version/size");
  devRequire(!dev.opened, "DEV_ALREADY_OPEN", "session cannot be replaced");
  devRequire(
      session->generation == generation,
      "STALE_GENERATION",
      "different host generation");
  devRequire(
      std::any_of(
          std::begin(session->session_id),
          std::end(session->session_id),
          [](uint8_t b) { return b != 0; }),
      "DEV_SCHEMA",
      "nonzero session id required");
  auto revision = devRevision(session->initial_revision);
  devRequire(
      std::equal(
          dev.initialDigest.begin(),
          dev.initialDigest.end(),
          session->initial_bundle_sha256),
      "DEV_HASH_MISMATCH",
      "initial bundle digest mismatch");
  std::copy(
      std::begin(session->session_id),
      std::end(session->session_id),
      dev.session.begin());
  dev.revision = std::move(revision);
  dev.opened = true;
  return devStatus();
}
std::string devQueued(const DevPatch& patch) const {
  return "{\"id\":null,\"result\":{\"status\":\"queued\",\"sequence\":" +
      quote(std::to_string(patch.sequence)) +
      ",\"baseRevision\":" + quote(patch.base) +
      ",\"targetRevision\":" + quote(patch.target) +
      ",\"payloadSha256\":" + quote(nhdev::hex(patch.digest)) + "}}";
}
std::string devEnqueue(const NHDevPatchV1* patch) {
  assertEntry();
  devRequire(dev.opened, "DEV_NOT_OPEN", "open a development session first");
  devRequire(
      patch && patch->version == NH_DEV_UPDATES_VERSION &&
          patch->size >= sizeof(NHDevPatchV1),
      "DEV_SCHEMA",
      "invalid patch version/size");
  devRequire(
      patch->generation == generation,
      "STALE_GENERATION",
      "different host generation");
  devRequire(
      std::equal(dev.session.begin(), dev.session.end(), patch->session_id),
      "DEV_STALE_SESSION",
      "different development session");
  auto base = devRevision(patch->base_revision);
  auto target = devRevision(patch->target_revision);
  devRequire(base != target, "DEV_SCHEMA", "target must differ from base");
  devRequire(
      patch->payload && patch->payload_length > 0 &&
          patch->payload_length <= NH_DEV_PATCH_MAX_BYTES,
      "DEV_SCHEMA",
      "payload length outside supported bounds");
  // Copy first, then hash exactly the immutable bytes that will execute.
  auto pending = std::make_unique<DevPatch>();
  pending->sequence = patch->sequence;
  pending->base = std::move(base);
  pending->target = std::move(target);
  pending->payload.assign(
      reinterpret_cast<const char*>(patch->payload), patch->payload_length);
  devRequire(
      pending->payload.find('\0') == std::string::npos,
      "DEV_SCHEMA",
      "source text required; embedded NUL/bytecode unsupported");
  pending->digest = nhdev::sha256(pending->payload);
  devRequire(
      std::equal(
          pending->digest.begin(),
          pending->digest.end(),
          patch->payload_sha256),
      "DEV_HASH_MISMATCH",
      "payload digest mismatch");
  if (dev.pending && patch->sequence == dev.pending->sequence) {
    devRequire(
        pending->base == dev.pending->base &&
            pending->target == dev.pending->target &&
            pending->digest == dev.pending->digest,
        "DEV_SEQUENCE_CONFLICT",
        "sequence identity differs");
    return devQueued(*dev.pending);
  }
  if (!dev.terminal.empty() && patch->sequence == dev.lastSequence) {
    devRequire(
        pending->base == dev.lastBase && pending->target == dev.lastTarget &&
            pending->digest == dev.lastDigest,
        "DEV_SEQUENCE_CONFLICT",
        "sequence identity differs");
    return dev.terminal;
  }
  devRequire(!dev.pending, "DEV_QUEUE_FULL", "one patch is already pending");
  devRequire(
      dev.acceptedSequence != UINT64_MAX &&
          patch->sequence == dev.acceptedSequence + 1,
      "DEV_SEQUENCE",
      "expected next sequence");
  devRequire(
      pending->base == dev.revision,
      "DEV_BASE_MISMATCH",
      "base is not current applied revision");
  auto response = devQueued(*pending);
  dev.acceptedSequence = pending->sequence;
  dev.pending = std::move(pending);
  return response;
}
std::string devFinish(
    const DevPatch& patch,
    const char* status,
    const std::string& phase,
    const std::string& message) {
  dev.lastSequence = patch.sequence;
  dev.lastBase = patch.base;
  dev.lastTarget = patch.target;
  dev.lastDigest = patch.digest;
  dev.terminal = "{\"id\":null,\"result\":{\"status\":" + quote(status) +
      ",\"sequence\":" + quote(std::to_string(patch.sequence)) +
      ",\"generation\":" + std::to_string(generation) +
      ",\"baseRevision\":" + quote(patch.base) +
      ",\"targetRevision\":" + quote(patch.target) +
      ",\"appliedRevision\":" + quote(dev.revision) +
      ",\"payloadSha256\":" + quote(nhdev::hex(patch.digest)) +
      ",\"phase\":" + quote(phase) + ",\"message\":" + quote(message) +
      ",\"reloadRequired\":" + (dev.poisoned ? "true" : "false") + "}}";
  return dev.terminal;
}
std::string devDrain() {
  assertEntry();
  devRequire(dev.opened, "DEV_NOT_OPEN", "open a development session first");
  if (!dev.pending)
    return "{\"id\":null,\"result\":{\"status\":\"idle\"}}";
  TaskScope task(taskDepth);
  auto patch = std::move(dev.pending);
  std::shared_ptr<const jsi::PreparedJavaScript> prepared;
  try {
    prepared = runtime->prepareJavaScript(
        std::make_shared<StringBuffer>(patch->payload),
        "native-host:dev/" + patch->target + "/" + nhdev::hex(patch->digest) +
            ".js");
  } catch (const std::exception& error) {
    return devFinish(
        *patch,
        "rejected",
        "prepare",
        std::string(error.what()).substr(0, 4096));
  } catch (...) {
    return devFinish(
        *patch, "rejected", "prepare", "unknown preparation error");
  }
  struct ExecutionLimit {
    facebook::hermes::HermesRuntime& runtime;
    explicit ExecutionLimit(facebook::hermes::HermesRuntime& r) : runtime(r) {
      runtime.watchTimeLimit(1000);
    }
    ~ExecutionLimit() {
      runtime.unwatchTimeLimit();
    }
  } executionLimit(*runtime);
  std::string phase = "evaluate";
  // From this point, arbitrary module side effects cannot be rolled back.
  dev.poisoned = true;
  try {
    auto result = runtime->evaluatePreparedJavaScript(prepared);
    devRequire(
        result.isObject(),
        "DEV_COMPLETION",
        "patch must return {status:'applied'}");
    auto object = result.getObject(*runtime);
    devRequire(
        !object.isArray(*runtime) && !object.isFunction(*runtime),
        "DEV_COMPLETION",
        "patch must return a completion object");
    auto prototype = object.getPrototype(*runtime);
    auto plainPrototype = jsi::Object(*runtime).getPrototype(*runtime);
    devRequire(
        prototype.isObject() && plainPrototype.isObject() &&
            jsi::Object::strictEquals(
                *runtime,
                prototype.getObject(*runtime),
                plainPrototype.getObject(*runtime)),
        "DEV_COMPLETION",
        "completion must be a plain object, not a promise/class instance");
    auto status = object.getProperty(*runtime, "status");
    devRequire(
        status.isString() &&
            status.getString(*runtime).utf8(*runtime) == "applied",
        "DEV_COMPLETION",
        "patch did not synchronously complete Refresh");
    phase = "microtasks";
    microtasks();
    phase = "mount";
    flushMount();
    dev.revision = patch->target;
    dev.poisoned = false;
    return devFinish(*patch, "applied", "mount-submitted", "");
  } catch (const std::exception& error) {
    dev.failurePhase = phase;
    dev.failureMessage = std::string(error.what()).substr(0, 4096);
  } catch (...) {
    dev.failurePhase = phase;
    dev.failureMessage = "unknown update execution error";
  }
  return devFinish(
      *patch, "reload-required", dev.failurePhase, dev.failureMessage);
}
