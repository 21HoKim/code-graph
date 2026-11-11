/* Calls CodeGraph draws for C: across files, to file-local functions, inside expressions and returns. */
#include <stdio.h>
#include "shapes.h"

static int square(int x) { return x * x; }          /* static: only this file sees it */

static int apply(int (*op)(int), int x) { return op(x); } /* through a pointer: shown once it runs */

int main(void) {
  struct rect r = rect_make(3, 4);                 /* a function in shapes.c, declared in shapes.h */
  printf("area %d\n", rect_area(&r));               /* a call inside another call's arguments */
  printf("square %d\n", apply(square, 5));
  return rect_area(&r) > 10 ? 0 : 1;                /* a call in a return */
}
