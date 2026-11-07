#pragma once
#include <atomic>
#include <memory>
#include <thread>
#include <vector>

#include "net/interface.h"
#include "net/queue.h"
#include "net/route_table.h"

namespace net {

// One RX thread feeds a queue, N TX workers drain it and forward packets.
class Router {
 public:
  explicit Router(int workers);
  ~Router();

  void addInterface(std::unique_ptr<Interface> iface);
  void start();
  void stop();
  void receive(const Packet& pkt);
  bool route(const Packet& pkt);

 private:
  void rxLoop();
  void txLoop(int id);
  bool validate(const Packet& pkt) const;

  RouteTable table_;
  PacketQueue queue_;
  std::vector<std::unique_ptr<Interface>> ifaces_;
  std::vector<std::thread> workers_;
  std::thread rx_;
  std::atomic<bool> running_{false};
  int workerCount_;
};

}  // namespace net
