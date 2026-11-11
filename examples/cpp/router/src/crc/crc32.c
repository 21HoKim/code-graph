/* Table-driven CRC-32 (IEEE 802.3). Plain C, linked into the C++ router. */
#include "crc32.h"

static uint32_t table[256];
static int table_ready = 0;

static void build_table(void) {
  for (uint32_t i = 0; i < 256; i++) {
    uint32_t c = i;
    for (int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
    table[i] = c;
  }
  table_ready = 1;
}

uint32_t crc32_update(uint32_t crc, const uint8_t *data, size_t len) {
  if (!table_ready) build_table();
  crc = ~crc;
  for (size_t i = 0; i < len; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
  return ~crc;
}

uint32_t crc32(const uint8_t *data, size_t len) { return crc32_update(0, data, len); }
