#include "checksum.h"

unsigned checksum(const void *data, size_t n) {
  const unsigned char *p = data;
  unsigned s = 0;
  for (size_t i = 0; i < n; i++) s = s * 31 + p[i];
  return s;
}
