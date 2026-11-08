#pragma once
#include <map>
#include <string>

namespace net {

/** key = value lines; ';' starts a comment. */
class Config {
 public:
  bool load(const std::string &path);
  std::string get(const std::string &key, const std::string &fallback = "") const;
  int getInt(const std::string &key, int fallback) const;

 private:
  std::map<std::string, std::string> values_;
};

/** "198.51.100.20:7000" → host and port. */
bool splitAddr(const std::string &addr, std::string &host, int &port);

}  // namespace net
