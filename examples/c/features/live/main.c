/* Runs until you press Stop: something to watch in the live view. */
#include <pthread.h>
#include <unistd.h>

static volatile long sink;

static void parse(long i) { sink += i % 7; }
static void store(long i) { sink += i; usleep(300); }
static void handle(long i) { parse(i); store(i); }

static void *serve(void *arg) {
  for (long i = 0;; i++) {
    handle(i);
    if (i % 100 == 0) usleep(20000);
  }
  return arg;
}

static void *flush(void *arg) {
  for (;;) { store(-1); usleep(200000); }
  return arg;
}

int main(void) {
  pthread_t a, b, c;
  pthread_create(&a, NULL, serve, NULL);
  pthread_create(&b, NULL, serve, NULL);
  pthread_create(&c, NULL, flush, NULL);
  pthread_join(a, NULL);
  return 0;
}
