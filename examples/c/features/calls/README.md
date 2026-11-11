# C · calls

How C calls become wires: across files through a header, to `static` (file-local) functions, inside arguments and
`return`, and through a function pointer.

Open this folder and look at the circuit at the *Function* level:

- [ ] `main` → `rect_make`, `rect_area` (defined in `shapes.c`, declared in `shapes.h`: one block each)
- [ ] `rect_make` → `clamp` and `main` → `apply`: `static` functions stay in their file
- [ ] `main` → `rect_area` also from the `return` line
- [ ] `main` hands `square` to `apply` as a value: no wire for that. `apply` → `square` is not drawn yet either,
      `op` is a pointer. **Run & Trace** adds `apply` → `square` (`via runtime`)
