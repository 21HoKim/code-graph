// What the class panel shows: members, family, where objects of a class live, who reads and writes each member.
#include <cstdio>
#include "config.hpp"

int main() {
  net::Config cfg;
  net::Link link(cfg);
  link.open();
  net::Frame f{};                      // a `using` name for Packet counts as Packet
  link.send(f);
  std::printf("%d\n", cfg.link.peer.port);           // reads Config.link → Peer.port
  return 0;
}
