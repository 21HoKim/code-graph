# C · problems

Broken on purpose. Open the folder and let the compile check run (**✓ Check**).

- [ ] `calibrate` is red (`ofset` is not a member); `sensor_read` and `main` are orange: they depend on it
- [ ] `log_flush` is red: declared, called, never defined
- [ ] `clamp` is grey: only reachable through the broken `calibrate`
- [ ] The problems panel lists each one; click to jump to the line
