#include "telemetry/logger.h"

#include <cstdio>

namespace telemetry {

void logReading(const std::string& name, double value) {
  std::printf("%s=%.2f\n", name.c_str(), value);
}

}  // namespace telemetry
