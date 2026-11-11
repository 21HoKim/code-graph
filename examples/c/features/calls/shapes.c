#include "shapes.h"

static int clamp(int v) { return v < 0 ? 0 : v; }

struct rect rect_make(int w, int h) {
  struct rect r = { clamp(w), clamp(h) };
  return r;
}

int rect_area(const struct rect *r) { return r->w * r->h; }
