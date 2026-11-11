#include "net/queue.h"

#include <chrono>

namespace net {

void PacketQueue::push(const Packet& pkt) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    items_.push(pkt);
  }
  cv_.notify_one();
}

bool PacketQueue::pop(Packet& out, int timeoutMs) {
  std::unique_lock<std::mutex> lock(mu_);
  auto ready = [this] { return closed_ || !items_.empty(); };
  if (!cv_.wait_for(lock, std::chrono::milliseconds(timeoutMs), ready)) return false;
  if (items_.empty()) return false;
  out = items_.front();
  items_.pop();
  return true;
}

void PacketQueue::close() {
  std::lock_guard<std::mutex> lock(mu_);
  closed_ = true;
  cv_.notify_all();
}

}  // namespace net
