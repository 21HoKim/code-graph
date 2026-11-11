# C · threads

Thread starts drawn as ⚡ dashed wires: `pthread_create` (with or without `&`), C11 `thrd_create`, and a start
function chosen at run time.

- [ ] `main` ⚡ `reader`, `writer`, `ticker`
- [ ] **Run & Trace**: four thread lanes, each branching off `main`; the one started through `pick(1)` runs `writer`
      and its ⚡ wire comes from the run itself (the analysis cannot know which function `pick` returns)
