# Roadmap

## v0.1 — static circuit

C/C++/Python extraction, cross-file linking with confidence, abstraction levels, files/symbols grouping,
circuit/network layouts, electric flow (arguments and return values), static thread-spawn detection, search,
focus, follow-cursor, incremental re-analysis, CLI.

## v0.2 — problems and runtime

- Language-aware levels (namespaces only for C++, packages/modules for Python).
- Compile check with the real toolchain, static problem checks, impact overlay (broken / affected / no current),
  problems panel, re-check on save, CLI `--verify`.
- Run & Trace for Python and C/C++: threads, values, object identities, crashes; swimlane replay, data trail,
  shared objects, runtime-only wires, CLI `trace`.

## v0.3 — real projects (this release)

- Run & Trace builds programs from the project's makefile (`make -n`) or CMake link files: flags, libraries,
  run directory, a pick when one `main` goes into several programs; library guesses for failed links.
- Run & Trace with Docker Compose: services traced inside their own containers and network, merged on one
  timeline per container.

## Next — distributed runs

- **Messages between processes**: pair a `send` in one container with the `recv` in another (socket addresses,
  payload digests) and draw the hop as a wire between their blocks.
- **Python services** in Compose (an interpreter shim), images that bake the sources in, Kubernetes pods.

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
