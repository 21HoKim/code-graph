#pragma once
#include <vector>

namespace telemetry {

double clampRange(double v, double lo, double hi);
double movingAverage(const std::vector<double>& window);

}  // namespace telemetry
