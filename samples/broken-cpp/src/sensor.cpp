#include "telemetry/sensor.h"

#include <cstdlib>

#include "telemetry/filters.h"

namespace telemetry {

Sensor::Sensor(double gain) : gain_(gain) {}

double Sensor::sample() { return std::rand() % 1000 / 10.0; }

double Sensor::read() { return calibrate(sample()); }

// BUG: typo in the member name, so this translation unit does not compile.
double Sensor::calibrate(double raw) const {
  return clampRange(raw * gain_ + ofset_, 0.0, 100.0);
}

}  // namespace telemetry
