#include <vector>

#include "telemetry/filters.h"
#include "telemetry/logger.h"
#include "telemetry/sensor.h"

int main() {
  telemetry::Sensor sensor(1.5);
  std::vector<double> window;
  for (int i = 0; i < 10; ++i) {
    window.push_back(sensor.read());
    telemetry::logReading("temperature", telemetry::movingAverage(window));
  }
  telemetry::flush();
  return 0;
}
