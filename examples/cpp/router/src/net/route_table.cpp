#include "net/route_table.h"

#include "util/log.h"

namespace net {

void RouteTable::add(uint32_t prefix, int length, int port) {
  routes_.push_back({prefix, length, port});
  util::log("route add %08x/%d -> %d", prefix, length, port);
}

int RouteTable::lookup(uint32_t dst) const {
  int best = -1;
  int bestLen = -1;
  for (const Route& r : routes_) {
    if (matches(r, dst) && r.length > bestLen) {
      best = r.port;
      bestLen = r.length;
    }
  }
  return best;
}

bool RouteTable::matches(const Route& r, uint32_t dst) {
  uint32_t mask = r.length == 0 ? 0 : ~0u << (32 - r.length);
  return (dst & mask) == (r.prefix & mask);
}

}  // namespace net
