#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include "host.h"

int main(int argc, char** argv) {
  std::string bundle;
  double width = 390, height = 844;
  for (int i = 1; i < argc; ++i) {
    std::string option = argv[i];
    if ((option == "--bundle" || option == "--width" || option == "--height") &&
        i + 1 < argc) {
      std::string value = argv[++i];
      if (option == "--bundle")
        bundle = value;
      else if (option == "--width")
        width = std::stod(value);
      else
        height = std::stod(value);
    } else {
      std::cerr
          << "usage: native-host [--bundle path] [--width n] [--height n]\n";
      return 2;
    }
  }
  NHHost* host = nh_host_create(
      bundle.c_str(), width, height, "headless", nullptr, nullptr);
  if (!host) {
    std::cerr << nh_host_last_error() << '\n';
    return 1;
  }
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty())
      continue;
    char* response = nh_host_dispatch(host, line.c_str());
    if (!response) {
      std::cerr << "host response allocation failed\n";
      nh_host_destroy(host);
      return 1;
    }
    std::cout << response << std::endl;
    nh_host_string_free(response);
  }
  nh_host_destroy(host);
  return 0;
}
