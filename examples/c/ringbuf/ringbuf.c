#include "ringbuf.h"

#include <stdlib.h>

static size_t next_index(const ringbuf_t *rb, size_t i) { return (i + 1) % rb->cap; }

int rb_init(ringbuf_t *rb, size_t cap) {
    rb->data = calloc(cap, sizeof(int));
    if (!rb->data) return -1;
    rb->cap = cap;
    rb->head = rb->tail = rb->count = 0;
    pthread_mutex_init(&rb->lock, NULL);
    pthread_cond_init(&rb->not_empty, NULL);
    pthread_cond_init(&rb->not_full, NULL);
    return 0;
}

void rb_free(ringbuf_t *rb) {
    free(rb->data);
    pthread_mutex_destroy(&rb->lock);
}

void rb_put(ringbuf_t *rb, int value) {
    pthread_mutex_lock(&rb->lock);
    while (rb->count == rb->cap) pthread_cond_wait(&rb->not_full, &rb->lock);
    rb->data[rb->tail] = value;
    rb->tail = next_index(rb, rb->tail);
    rb->count++;
    pthread_cond_signal(&rb->not_empty);
    pthread_mutex_unlock(&rb->lock);
}

int rb_get(ringbuf_t *rb) {
    pthread_mutex_lock(&rb->lock);
    while (rb->count == 0) pthread_cond_wait(&rb->not_empty, &rb->lock);
    int v = rb->data[rb->head];
    rb->head = next_index(rb, rb->head);
    rb->count--;
    pthread_cond_signal(&rb->not_full);
    pthread_mutex_unlock(&rb->lock);
    return v;
}
