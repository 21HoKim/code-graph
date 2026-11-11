// Calls CodeGraph draws for C++: namespaces, methods, inheritance, overloads, using-declarations and aliases,
// objects created, and a call into C.
#include <cstdio>
#include <memory>
#include "geo.hpp"
#include "checksum.h"

namespace g = app::geo;                        // a namespace alias
using app::geo::Point;                         // a using-declaration for a type

static double area(const app::geo::Shape& s) { return s.area(); } // virtual: which override runs is seen at run time

int main() {
  Point p(1, 2);                               // `Point p(1, 2);`: creates a Point
  auto c = std::make_unique<g::Circle>(p, 2.0); // make_unique<T>: creates a Circle
  g::Square sq(p, 3);
  std::printf("%.1f %.1f\n", area(*c), area(sq));
  std::printf("%.1f\n", g::distance(p, Point(4, 6)));  // through the alias
  std::printf("%.1f\n", g::distance(p, 3.0));          // an overload
  {
    using app::geo::distance;                  // inside a block: plain `distance` means app::geo::distance
    std::printf("%.1f\n", distance(p, 1.0));
  }
  return checksum(&p, sizeof p) ? 0 : 1;       // a C function (checksum.c, extern "C" in the header)
}
