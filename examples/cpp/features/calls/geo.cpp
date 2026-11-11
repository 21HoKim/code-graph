#include "geo.hpp"
#include <cmath>

namespace app::geo {

Point::Point(double x, double y) : x(x), y(y) {}
Shape::Shape(Point origin) : origin_(origin) {}
Circle::Circle(Point origin, double r) : Shape(origin), r_(r) {}
Square::Square(Point origin, double side) : Shape(origin), side_(side) {}

double Circle::area() const { return 3.14159 * r_ * r_; }
double Square::area() const { return side_ * side_; }

double distance(const Point& a, const Point& b) { return std::hypot(a.x - b.x, a.y - b.y); }
double distance(const Point& a, double radius) { return distance(a, Point(0, 0)) - radius; }

}  // namespace app::geo
