#include "net/interface.h"

#include "util/log.h"

namespace net {

EthInterface::EthInterface(std::string name) : Interface(std::move(name)) {}

bool EthInterface::send(const Packet& pkt) {
  util::log("%s: tx %zu bytes (crc=%08x)", name_.c_str(), pkt.payload.size(), pkt.checksum());
  return fd_ >= 0;
}

bool LoopbackInterface::send(const Packet& pkt) {
  util::log("lo: %u -> %u", pkt.src, pkt.dst);
  return true;
}

}  // namespace net
