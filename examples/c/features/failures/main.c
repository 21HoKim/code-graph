/* A crash in one thread: the function turns red, and the stack of every thread at that moment is kept. */
#include <pthread.h>
#include <stdio.h>
#include <unistd.h>

struct job { int *slot; };

static int read_slot(const struct job *j) { return *j->slot; }   /* NULL here: SIGSEGV */

static void *crasher(void *arg) {
  usleep(20000);
  printf("%d\n", read_slot(arg));
  return NULL;
}

static void *idler(void *arg) { (void)arg; sleep(1); return NULL; }

int main(void) {
  struct job j = { NULL };
  pthread_t a, b;
  pthread_create(&b, NULL, idler, NULL);
  pthread_create(&a, NULL, crasher, &j);
  pthread_join(a, NULL);
  pthread_join(b, NULL);
  return 0;
}
