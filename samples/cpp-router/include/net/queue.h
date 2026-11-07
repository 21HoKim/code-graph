#pragma once
#include <condition_variable>
#include <mutex>
#include <queue>

#include "net/packet.h"

namespace net {

// Thread-safe FIFO shared by the RX thread and the TX workers.
class PacketQueue {
 public:
  void push(const Packet& pkt);
  bool pop(Packet& out, int timeoutMs);
  void close();

 private:
  std::mutex mu_;
  std::condition_variable cv_;
  std::queue<Packet> items_;
  bool closed_ = false;
};

}  // namespace net
