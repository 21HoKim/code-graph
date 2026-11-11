#include "telemetry/filters.h"

namespace telemetry {

double clampRange(double v, double lo, double hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

double movingAverage(const std::vector<double>& window) {
  double sum = 0;
  for (double v : window) sum += v;
  return window.empty() ? 0 : sum / window.size();
}

}  // namespace telemetry
