#include "config.hpp"

#include <fstream>

namespace net {

static std::string trim(const std::string &s) {
  const auto b = s.find_first_not_of(" \t\r");
  if (b == std::string::npos) return "";
  return s.substr(b, s.find_last_not_of(" \t\r") - b + 1);
}

bool Config::load(const std::string &path) {
  std::ifstream in(path);
  if (!in) return false;
  std::string line;
  while (std::getline(in, line)) {
    line = trim(line);
    if (line.empty() || line[0] == ';') continue;
    const auto eq = line.find('=');
    if (eq == std::string::npos) continue;
    values_[trim(line.substr(0, eq))] = trim(line.substr(eq + 1));
  }
  return true;
}

std::string Config::get(const std::string &key, const std::string &fallback) const {
  const auto it = values_.find(key);
  return it == values_.end() ? fallback : it->second;
}

int Config::getInt(const std::string &key, int fallback) const {
  const auto v = get(key);
  return v.empty() ? fallback : std::stoi(v);
}

bool splitAddr(const std::string &addr, std::string &host, int &port) {
  const auto colon = addr.rfind(':');
  if (colon == std::string::npos) return false;
  host = addr.substr(0, colon);
  port = std::stoi(addr.substr(colon + 1));
  return !host.empty() && port > 0;
}

}  // namespace net
