#include "config.hpp"

namespace net {

Link::Link(Config& cfg) : cfg_(cfg) {}           // writes Link.cfg_

void Link::open() {
  if (cfg_.link.retries > 0) open_ = true;       // reads LinkCfg.retries, writes Link.open_
  cfg_.link.peer.port += 1;                      // writes Peer.port through two members
}

void Link::send(const Packet& p) {
  if (open_ && p.len >= 0) sent_++;              // reads Packet.len; writes Endpoint.sent_ (a base member)
}

}  // namespace net
