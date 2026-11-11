/* Every way a C program starts a thread that CodeGraph recognises. */
#include <pthread.h>
#include <stdio.h>
#include <threads.h>

static void *reader(void *arg) { (void)arg; return NULL; }
static void *writer(void *arg) { (void)arg; return NULL; }
static int ticker(void *arg) { (void)arg; return 0; }      /* C11 threads */

typedef void *(*entry_fn)(void *);
static entry_fn pick(int i) { return i ? writer : reader; }

int main(void) {
  pthread_t a, b, c;
  thrd_t t;
  pthread_create(&a, NULL, reader, NULL);                  /* POSIX */
  pthread_create(&b, NULL, &writer, NULL);                 /* with & */
  thrd_create(&t, ticker, NULL);                           /* C11 */
  pthread_create(&c, NULL, pick(1), NULL);                 /* through a pointer: seen when it runs */
  pthread_join(a, NULL);
  pthread_join(b, NULL);
  pthread_join(c, NULL);
  thrd_join(t, NULL);
  puts("done");
  return 0;
}
