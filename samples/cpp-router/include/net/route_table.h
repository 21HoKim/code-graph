#pragma once
#include <cstdint>
#include <vector>

namespace net {

struct Route {
  uint32_t prefix;
  int length;
  int port;
};

// Longest-prefix-match routing table.
class RouteTable {
 public:
  void add(uint32_t prefix, int length, int port);
  int lookup(uint32_t dst) const;

 private:
  static bool matches(const Route& r, uint32_t dst);
  std::vector<Route> routes_;
};

}  // namespace net
