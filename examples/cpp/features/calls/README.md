# C++ · calls

Open this folder, *Function* level (or *Class* / *Namespace* to see the same wires merged).

- [ ] `main` ✚ `Point` (from `Point p(1, 2);`) and ✚ `Circle` (from `std::make_unique<g::Circle>`)
- [ ] `main` → `app::geo::distance` — both overloads, one through the namespace alias `g::`, one through the
      block's `using app::geo::distance;`
- [ ] `Circle` and `Square` △ inherit `Shape`
- [ ] `main` → `checksum`: C++ calling the C file through the `extern "C"` header
- [ ] `area` → `Shape::area` only: which override runs is not known statically. **Run & Trace** adds
      `area` → `Circle::area` and `Square::area` (`via runtime`)
