# C · failures

Press **▶ Run & Trace**. The program crashes on purpose.

- [ ] `read_slot` turns red with `SIGSEGV`; the run summary shows where every thread was (`idler` in `sleep`)
- [ ] The ✕ in the timeline head jumps to the moment of the crash
