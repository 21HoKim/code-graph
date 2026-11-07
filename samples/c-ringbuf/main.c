/* Producer/consumer over a bounded ring buffer (pthreads). */
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

#include "ringbuf.h"

#define N_ITEMS 1000

static void *producer(void *arg) {
    ringbuf_t *rb = arg;
    for (int i = 0; i < N_ITEMS; i++) rb_put(rb, i);
    rb_put(rb, -1);
    return NULL;
}

static long consume_all(ringbuf_t *rb) {
    long sum = 0;
    for (int v; (v = rb_get(rb)) >= 0;) sum += v;
    return sum;
}

static void *consumer(void *arg) {
    long *result = malloc(sizeof *result);
    *result = consume_all(arg);
    return result;
}

int main(void) {
    ringbuf_t rb;
    pthread_t prod, cons;
    if (rb_init(&rb, 64) != 0) return 1;
    pthread_create(&prod, NULL, producer, &rb);
    pthread_create(&cons, NULL, consumer, &rb);
    void *res;
    pthread_join(prod, NULL);
    pthread_join(cons, &res);
    printf("sum=%ld\n", *(long *)res);
    rb_free(&rb);
    return 0;
}
