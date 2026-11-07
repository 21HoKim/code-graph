#include "net/router.h"

#include <chrono>

#include "util/log.h"

namespace net {

Router::Router(int workers) : workerCount_(workers) {
  table_.add(0x0A000000, 8, 0);  // 10.0.0.0/8  -> eth0
  table_.add(0x7F000000, 8, 1);  // 127.0.0.0/8 -> lo
}

Router::~Router() { stop(); }

void Router::addInterface(std::unique_ptr<Interface> iface) {
  util::log("attach %s", iface->name().c_str());
  ifaces_.push_back(std::move(iface));
}

void Router::start() {
  running_ = true;
  rx_ = std::thread(&Router::rxLoop, this);
  for (int i = 0; i < workerCount_; ++i) {
    workers_.emplace_back(&Router::txLoop, this, i);
  }
}

void Router::stop() {
  if (!running_.exchange(false)) return;
  queue_.close();
  if (rx_.joinable()) rx_.join();
  for (auto& t : workers_) t.join();
  workers_.clear();
}

void Router::receive(const Packet& pkt) {
  if (validate(pkt)) queue_.push(pkt);
}

void Router::rxLoop() {
  util::log("rx thread up");
  uint32_t seq = 0;
  while (running_) {
    Packet pkt;
    pkt.src = 0x0A000002;
    // every fourth packet is addressed to the loopback interface
    pkt.dst = seq % 4 == 3 ? 0x7F000001 : 0x0A000001 + seq % 3;
    pkt.port = static_cast<uint16_t>(5000 + seq % 8);
    for (int i = 0; i < 16; ++i) pkt.payload.push_back(static_cast<uint8_t>(seq * 31 + i));
    receive(pkt);
    ++seq;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
}

void Router::txLoop(int id) {
  util::log("tx worker %d up", id);
  Packet pkt;
  while (queue_.pop(pkt, 100)) {
    route(pkt);
  }
}

bool Router::route(const Packet& pkt) {
  int port = table_.lookup(pkt.dst);
  if (port < 0 || port >= static_cast<int>(ifaces_.size())) return false;
  return ifaces_[port]->send(pkt);
}

bool Router::validate(const Packet& pkt) const {
  return pkt.checksum() != 0 || pkt.payload.empty();
}

}  // namespace net
