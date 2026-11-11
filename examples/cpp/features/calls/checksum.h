#ifndef CHECKSUM_H
#define CHECKSUM_H
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
unsigned checksum(const void *data, size_t n);
#ifdef __cplusplus
}
#endif
#endif
