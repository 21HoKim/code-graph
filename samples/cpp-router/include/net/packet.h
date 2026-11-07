#pragma once
#include <cstdint>
#include <vector>

namespace net {

struct Packet {
  uint32_t src = 0;
  uint32_t dst = 0;
  uint16_t port = 0;
  std::vector<uint8_t> payload;

  uint32_t checksum() const;
};

}  // namespace net
