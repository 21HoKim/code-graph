/* Broken on purpose: the compile check marks what does not build, what depends on it and what gets no current. */
#include <stdio.h>
#include "sensor.h"

int main(void) {
  struct sensor s = { 0, 2 };
  printf("%d\n", sensor_read(&s));
  log_flush();                       /* declared in sensor.h, never defined: link error */
  return 0;
}
