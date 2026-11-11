#pragma once
#include <string>

namespace telemetry {

void logReading(const std::string& name, double value);
void flush();  // TODO: never implemented, but main() calls it

}  // namespace telemetry
