#include "sensor.h"

static int clamp(int v) { return v < 0 ? 0 : v; }        /* only reachable through calibrate */

static int calibrate(struct sensor *s) { return clamp(s->raw - s->ofset); } /* typo: does not compile */

int sensor_read(struct sensor *s) { return calibrate(s) + 1; }
