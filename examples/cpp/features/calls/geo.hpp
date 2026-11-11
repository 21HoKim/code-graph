#pragma once

namespace app::geo {

struct Point {
  double x, y;
  Point(double x, double y);
};

class Shape {
public:
  explicit Shape(Point origin);
  virtual ~Shape() = default;
  virtual double area() const = 0;
protected:
  Point origin_;
};

class Circle : public Shape {
public:
  Circle(Point origin, double r);
  double area() const override;
private:
  double r_;
};

class Square : public Shape {
public:
  Square(Point origin, double side);
  double area() const override;
private:
  double side_;
};

double distance(const Point& a, const Point& b);
double distance(const Point& a, double radius);

}  // namespace app::geo
