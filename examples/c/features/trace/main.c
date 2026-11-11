/* Run & Trace: threads, argument values, one object shared by two threads, a callback only the run reveals. */
#include <pthread.h>
#include <stdio.h>
#include <string.h>

struct counter { pthread_mutex_t mu; long total; };
typedef void (*on_add)(long);

static void report(long v) { if (v % 50 == 0) printf("at %ld\n", v); }
static on_add listener = report;                        /* called through a pointer */

static void add(struct counter *c, long n, const char *who) {
  pthread_mutex_lock(&c->mu);
  c->total += n;
  pthread_mutex_unlock(&c->mu);
  listener(c->total);
  (void)strlen(who);
}

static void *worker(void *arg) {
  struct counter *c = arg;
  for (long i = 0; i < 50; i++) add(c, 1, "worker");
  return NULL;
}

int main(void) {
  struct counter c = { PTHREAD_MUTEX_INITIALIZER, 0 };
  pthread_t a, b;
  pthread_create(&a, NULL, worker, &c);
  pthread_create(&b, NULL, worker, &c);
  pthread_join(a, NULL);
  pthread_join(b, NULL);
  printf("total %ld\n", c.total);
  return 0;
}
