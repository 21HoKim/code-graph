#ifndef RINGBUF_H
#define RINGBUF_H

#include <pthread.h>
#include <stddef.h>

typedef struct ringbuf {
    int *data;
    size_t cap, head, tail, count;
    pthread_mutex_t lock;
    pthread_cond_t not_empty, not_full;
} ringbuf_t;

int  rb_init(ringbuf_t *rb, size_t cap);
void rb_free(ringbuf_t *rb);
void rb_put(ringbuf_t *rb, int value);
int  rb_get(ringbuf_t *rb);

#endif /* RINGBUF_H */
