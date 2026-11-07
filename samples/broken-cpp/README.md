Deliberately broken sample for CodeCurrent's verification overlay:

- `Sensor::calibrate` does not compile (typo `ofset_`) → red; `Sensor::read` and `main` depend on it → orange
- `telemetry::flush` is declared but never implemented → red (link error)
- `clampRange` is only reachable through the broken `calibrate` → unpowered (grey)
