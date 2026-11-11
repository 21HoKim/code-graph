# C++ · trace

Press **▶ Run & Trace**.

- [ ] Lanes `main`, `produce`, `consume`, both branching off `main`
- [ ] Select a `Queue::push` call: `v = …`, and `this` is the same `Queue` in both threads (*Shared data*)
- [ ] New wires `via runtime`: `consume` → `Console::put` (virtual) and `consume` → `count` (through `std::function`)
- [ ] Click the `Queue` under *Shared data*: every function it passed through lights up, in order
