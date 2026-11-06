// Isolated owner-thread C-ABI exerciser. Not a networking or application
// binary.
#include <algorithm>
#include <cctype>
#include <cstring>
#include <iostream>
#include <limits>
#include <map>
#include <stdexcept>
#include <string>
#include "Integrity.h"
#include "host.h"

namespace {
// Development control envelopes intentionally contain flat ASCII string fields.
// Executable bytes are hex, never decoded by an auxiliary JavaScript runtime.
// Only an unescaped top-level method selects this driver's flat dev protocol.
// Nested strings and ordinary protocol payloads must never affect routing.
std::string topLevelMethod(const std::string& input) {
  unsigned depth = 0;
  for (size_t i = 0; i < input.size(); ++i) {
    char c = input[i];
    if (c == '{' || c == '[') {
      ++depth;
      continue;
    }
    if (c == '}' || c == ']') {
      if (depth)
        --depth;
      continue;
    }
    if (c != '"')
      continue;
    size_t start = ++i;
    while (i < input.size() && input[i] != '"') {
      if (input[i] == '\\' && i + 1 < input.size())
        ++i;
      ++i;
    }
    if (i == input.size())
      return {};
    if (depth != 1 || input.compare(start, i - start, "method") != 0)
      continue;
    size_t at = i + 1;
    while (at < input.size() &&
           std::isspace(static_cast<unsigned char>(input[at])))
      ++at;
    if (at == input.size() || input[at++] != ':')
      continue;
    while (at < input.size() &&
           std::isspace(static_cast<unsigned char>(input[at])))
      ++at;
    if (at == input.size() || input[at++] != '"')
      return {};
    auto end = input.find('"', at);
    if (end == std::string::npos)
      return {};
    return input.substr(at, end - at);
  }
  return {};
}
std::map<std::string, std::string> fields(const std::string& input) {
  size_t at = 0;
  auto skip = [&] {
    while (at < input.size() &&
           std::isspace(static_cast<unsigned char>(input[at])))
      ++at;
  };
  auto character = [&](char c) {
    skip();
    if (at == input.size() || input[at++] != c)
      throw std::runtime_error("invalid flat control JSON");
  };
  auto string = [&] {
    character('"');
    std::string value;
    while (at < input.size() && input[at] != '"') {
      auto c = static_cast<unsigned char>(input[at++]);
      if (c < 32 || c > 126 || c == '\\')
        throw std::runtime_error(
            "control fields require unescaped ASCII; use payloadHex");
      value += char(c);
    }
    character('"');
    return value;
  };
  std::map<std::string, std::string> result;
  character('{');
  skip();
  if (at < input.size() && input[at] == '}')
    ++at;
  else
    for (;;) {
      auto key = string();
      character(':');
      auto value = string();
      if (!result.emplace(key, value).second)
        throw std::runtime_error("duplicate field");
      skip();
      if (at < input.size() && input[at] == '}') {
        ++at;
        break;
      }
      character(',');
    }
  skip();
  if (at != input.size())
    throw std::runtime_error("trailing input");
  return result;
}
std::string unhex(const std::string& text, size_t limit) {
  if (text.size() % 2 || text.size() / 2 > limit)
    throw std::runtime_error("invalid hex length");
  auto nibble = [](char c) -> unsigned {
    if (c >= '0' && c <= '9')
      return c - '0';
    if (c >= 'a' && c <= 'f')
      return c - 'a' + 10;
    throw std::runtime_error("hex must be lowercase");
  };
  std::string value;
  value.reserve(text.size() / 2);
  for (size_t i = 0; i < text.size(); i += 2)
    value += char(nibble(text[i]) * 16 + nibble(text[i + 1]));
  return value;
}
uint64_t number(const std::string& text) {
  if (text.empty() || text.size() > 20 ||
      !std::all_of(text.begin(), text.end(), [](char c) {
        return c >= '0' && c <= '9';
      }))
    throw std::runtime_error("invalid decimal integer");
  size_t consumed;
  auto n = std::stoull(text, &consumed);
  if (consumed != text.size())
    throw std::runtime_error("invalid integer");
  return n;
}
template <size_t N>
void fixed(uint8_t (&out)[N], const std::string& text) {
  auto bytes = unhex(text, N);
  if (bytes.size() != N)
    throw std::runtime_error("incorrect fixed hex length");
  std::memcpy(out, bytes.data(), N);
}
void revision(char (&out)[65], const std::string& value) {
  if (value.size() > 64)
    throw std::runtime_error("revision too long");
  std::memcpy(out, value.c_str(), value.size() + 1);
}
void emit(char* value) {
  if (!value)
    throw std::runtime_error("host allocation failed");
  std::cout << value << std::endl;
  nh_host_string_free(value);
}
} // namespace
int main(int argc, char** argv) {
  if (argc != 3 || std::string(argv[1]) != "--bundle") {
    std::cerr << "usage: native-host-dev-driver --bundle path\n";
    return 2;
  }
  auto host = nh_host_create(argv[2], 390, 844, "headless", nullptr, nullptr);
  if (!host) {
    std::cerr << nh_host_last_error() << '\n';
    return 1;
  }
  constexpr size_t maxLine = NH_DEV_PATCH_MAX_BYTES * 2 + 8192;
  std::string line;
  for (;;) {
    line.clear();
    bool oversized = false;
    char c;
    while (std::cin.get(c) && c != '\n') {
      if (line.size() < maxLine)
        line += c;
      else
        oversized = true;
    }
    if (line.empty() && !std::cin)
      break;
    if (oversized) {
      std::cout
          << "{\"error\":{\"code\":\"DRIVER_SCHEMA\",\"message\":\"envelope exceeds limit\"}}"
          << std::endl;
      continue;
    }
    try {
      if (line.size() > maxLine)
        throw std::runtime_error("control envelope too large");
      // Non-dev requests retain the existing protocol and hook restrictions.
      if (topLevelMethod(line).rfind("dev.", 0) != 0) {
        emit(nh_host_dispatch(host, line.c_str()));
        continue;
      }
      auto f = fields(line);
      auto method = f.at("method");
      if (method == "dev.status")
        emit(nh_host_dev_status(host));
      else if (method == "dev.drain")
        emit(nh_host_dev_drain(host));
      else if (method == "dev.hash") {
        auto bytes = unhex(f.at("payloadHex"), NH_DEV_PATCH_MAX_BYTES);
        std::cout << "{\"result\":{\"sha256\":\""
                  << nhdev::hex(nhdev::sha256(bytes)) << "\"}}" << std::endl;
      } else if (method == "dev.open") {
        NHDevSessionV1 value{};
        value.version = 1;
        value.size = sizeof(value);
        value.generation = number(f.at("generation"));
        fixed(value.session_id, f.at("sessionId"));
        fixed(value.initial_bundle_sha256, f.at("initialBundleSha256"));
        revision(value.initial_revision, f.at("initialRevision"));
        emit(nh_host_dev_open(host, &value));
      } else if (method == "dev.enqueue") {
        NHDevPatchV1 value{};
        value.version = 1;
        value.size = sizeof(value);
        value.generation = number(f.at("generation"));
        value.sequence = number(f.at("sequence"));
        fixed(value.session_id, f.at("sessionId"));
        fixed(value.payload_sha256, f.at("payloadSha256"));
        revision(value.base_revision, f.at("baseRevision"));
        revision(value.target_revision, f.at("targetRevision"));
        auto bytes = unhex(f.at("payloadHex"), NH_DEV_PATCH_MAX_BYTES);
        value.payload = reinterpret_cast<const uint8_t*>(bytes.data());
        value.payload_length = bytes.size();
        emit(nh_host_dev_enqueue(host, &value));
      } else
        throw std::runtime_error("unknown development control method");
    } catch (const std::exception&) {
      std::cout
          << "{\"error\":{\"code\":\"DRIVER_SCHEMA\",\"message\":\"invalid bounded flat control envelope\"}}"
          << std::endl;
    }
  }
  nh_host_destroy(host);
  return 0;
}
