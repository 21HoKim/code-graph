#include "buffer.h"

void buf_init(buffer_t *b) { b->len = 0; }               /* writes buffer.len */
int buf_len(const buffer_t *b) { return b->len; }        /* reads buffer.len */
