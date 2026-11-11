#pragma once

namespace telemetry {

class Sensor {
 public:
  explicit Sensor(double gain);
  double read();

 private:
  double sample();
  double calibrate(double raw) const;
  double gain_;
  double offset_ = 0.5;
};

}  // namespace telemetry
