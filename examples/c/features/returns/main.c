/* Calls inside return statements are calls of the function, whatever the expression around them. */
#include <stdio.h>

static int base(int x) { return x + 1; }
static int twice(int x) { return 2 * base(x); }                  /* inside arithmetic */
static int pick(int x) { return x > 0 ? base(x) : twice(-x); }   /* both branches of ?: */
static int nested(int x) { return base(twice(x)); }              /* nested calls */

int main(void) {
  printf("%d %d %d\n", twice(1), pick(-2), nested(3));
  return 0;
}
