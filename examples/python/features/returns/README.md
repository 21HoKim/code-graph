# Python · returns

- [ ] `pick` → `base`, `numbers` → `base` (`yield from`), `later` → `base` (`return await`)
- [ ] `outer` → `base` (the lambda counts for the function that writes it) and → `inner`, a block of its own,
      which → `pick`
- [ ] Select `outer`: no `return` lines — they belong to `inner` and the lambda
