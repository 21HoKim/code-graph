# C · trace

Press **▶ Run & Trace** (the program ends by itself).

- [ ] Three lanes: `main` and two `worker` threads, each branching off `main`; play, scrub, step
- [ ] Select an `add` call: its values `n = 1`, `who = "worker"` and the `struct counter` pointer
- [ ] *Shared data*: the same `struct counter` in both workers — click it to light up every function it passed
- [ ] `add` → `report` appears as a new wire (`via runtime`): the call goes through the pointer `listener`
