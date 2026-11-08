#include <iostream>
#include <string>

#include "config.hpp"
#include "link.hpp"

// One program, two roles: the makefile builds node-a (client) and node-b (server).
int main() {
#if defined(NODE_A)
  const std::string conf = "../cfg/node-a.conf";
#elif defined(NODE_B)
  const std::string conf = "../cfg/node-b.conf";
#else
#error "build with -DNODE_A or -DNODE_B (see makefile)"
#endif
  net::Config cfg;
  if (!cfg.load(conf)) {
    std::cerr << "cannot read " << conf << " (run from src/)" << std::endl;
    return 1;
  }
#if defined(NODE_A)
  std::string host;
  int port = 0;
  if (!net::splitAddr(cfg.get("peer_addr"), host, port)) {
    std::cerr << "peer_addr missing in " << conf << std::endl;
    return 1;
  }
  return net::Client(host, port, cfg.getInt("rounds", 3)).run();
#else
  return net::Server(cfg.get("local_ip", "0.0.0.0"), cfg.getInt("listen_port", 7000)).run();
#endif
}
