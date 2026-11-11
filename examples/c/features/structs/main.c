/* What the class panel shows for C structs: members, where values of a struct live, and who reads or writes them. */
#include <stdio.h>
#include "buffer.h"

struct pool { buffer_t *free; int size; };              /* holds a buffer_t: the typedef counts as the struct */

static void pool_init(struct pool *p, buffer_t *first) {
  p->free = first;                                      /* writes pool.free */
  p->size = 1;
}

int main(void) {
  struct buffer b;
  struct pool p;
  buf_init(&b);
  pool_init(&p, &b);
  printf("%d %d\n", buf_len(&b), p.size);              /* reads pool.size */
  return 0;
}
