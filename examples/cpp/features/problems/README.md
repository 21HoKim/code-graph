# C++ · problems

Broken on purpose. Open the folder and let the compile check run (**✓ Check**).

- [ ] `Sensor::calibrate` is red (typo `ofset_`); `Sensor::read` and `main` are orange: they depend on it
- [ ] `telemetry::flush` is red: declared, called, never defined (link error)
- [ ] `clampRange` is grey: only reachable through the broken `calibrate`
- [ ] **▶ Run & Trace** stops at the build and shows the same errors in red
