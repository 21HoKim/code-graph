#ifndef SHAPES_H
#define SHAPES_H
struct rect { int w, h; };
struct rect rect_make(int w, int h);
int rect_area(const struct rect *r);
#endif
