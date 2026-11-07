#include "net/packet.h"

#include "crc/crc32.h"

namespace net {

uint32_t Packet::checksum() const {
  return crc32(payload.data(), payload.size());
}

}  // namespace net
