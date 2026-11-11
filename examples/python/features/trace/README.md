# Python · trace

Press **▶ Run & Trace**.

- [ ] Lanes `MainThread`, `alice`, `bob` (names from `Thread(name=…)`), branching off `MainThread`
- [ ] Select a `Ledger.add` call: `who = 'alice'`, `amount = 3`, and its return value
- [ ] *Shared data*: the same `Ledger` in both threads — click it to follow it
- [ ] `work` → `on_total` appears `via runtime`: the analysis only sees a parameter named `report`
