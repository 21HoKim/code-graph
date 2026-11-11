// Calls in return statements, and returns that belong to a lambda or a local class, not to the function.
#include <cstdio>

int base(int x) { return x + 1; }
int twice(int x) { return 2 * base(x); }
int pick(int x) { return x > 0 ? base(x) : twice(-x); }

struct Box { int v; Box& grow(int n) { v += n; return *this; } int amount() const { return v; } };
int chain(int x) { return Box{x}.grow(base(x)).amount(); }    // a chained call

void visit(int n) {                                          // returns nothing itself...
  auto f = [](int y) { return base(y); };                    // ...this return is the lambda's
  struct Local { static int g(int y) { return y * 3; } };     // ...and this one the local class's
  std::printf("%d %d\n", f(n), Local::g(n));
}

int main() {
  visit(pick(-3));
  return chain(1) == 3 ? 0 : 1;
}
