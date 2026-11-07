# Roadmap

## v0.1 — static circuit

C/C++/Python extraction, cross-file linking with confidence, abstraction levels, files/symbols grouping,
circuit/network layouts, electric flow (arguments and return values), static thread-spawn detection, search,
focus, follow-cursor, incremental re-analysis, CLI.

## v0.2 — problems and runtime (this release)

- Language-aware levels (namespaces only for C++, packages/modules for Python).
- Compile check with the real toolchain, static problem checks, impact overlay (broken / affected / no current),
  problems panel, re-check on save, CLI `--verify`.
- Run & Trace for Python and C/C++: threads, values, object identities, crashes; swimlane replay, data trail,
  shared objects, runtime-only wires, CLI `trace`.

## Next — precision

- **Language-server confirmation**: ask the active language server through `vscode.prepareCallHierarchy` /
  `vscode.provideOutgoingCalls` (clangd, Microsoft C/C++, Pylance); matching results upgrade `guess`/`likely`
  links to `exact`.
- **Virtual dispatch fan-out**: optional dashed wires from `Base::send` to every override.
- **Callbacks & function pointers** as a separate `ref` relation kind (`signal(SIGINT, onSignal)`,
  `add_done_callback(self._collect)`, registration tables).
- **Macros**: honour `compile_commands.json` defines for `#if` branches.

## Next — runtime

- **Locks and waiting**: record `mutex`/`Lock`/`Condition`/`Queue.get` waits, draw contention heat on blocks and
  lock pseudo-blocks between threads.
- **Return values in C/C++** (rewrite `return` statements) and field writes of shared objects.
- **Attach without rebuilding** (Linux eBPF uprobes) and **live streaming** of a debug session (DAP).
- **Coverage view** from traces (lines, not only functions).

## More languages

Rust, Go, Java, TypeScript via tree-sitter adapters (one extractor file + linker rules each), plus a tracer per
runtime.
