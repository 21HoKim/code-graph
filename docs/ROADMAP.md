# Roadmap

- Possible next steps for CodeGraph — no promises, no dates
- Released work: [changelog](../CHANGELOG.md), [VERSIONING](VERSIONING.md)
- Ideas and requests: welcome as issues

## Seeing more of a function

- **Method blocks as nodes with pins**
  - Input pin per parameter (name and type), output pin for the return value
  - One row per call: which argument into which parameter, what comes back and where it is stored, the wire leaving from that row
  - Values of the moment on the pins during a replay
- **Members from configuration**
  - A value read from a configuration file followed to the member chain it ends up in
  - Types the analysis can only guess (`auto`, templates) marked as guesses

## Between programs

- **An *Outside* block**: what a program talks to beyond the workspace
  - One child per endpoint (host, port, path)
  - Resolved from the code with a confidence, confirmed by a run
- **Messages between processes**: a `send` in one container paired with the `recv` in another, the hop drawn as a wire between their blocks
- **Kubernetes pods** and dev containers, with the same wrappers as Compose

## Runtime

- **Stop on a wire**: program paused when a call goes along a chosen wire, optionally only under a condition on its values
- **System calls**: optional interception layer for the C library (files, sockets, processes)
  - Shown on the blocks that made them
  - Traced libraries chosen in `.codegraph.json`
- **Follow a value**: one value (a request id, a key) tracked through every function and thread it passes, as a fingerprint rather than the value itself
- **Hot spots and data volume**: time per block as heat, bytes per wire as thickness
- **Locks and waiting**: mutex, lock, condition and queue waits, contention between threads
- **Attach without rebuilding** (Linux uprobes) and **coverage** of the lines that ran

## Precision

- **Language-server confirmation**: call hierarchies from clangd, the Microsoft C/C++ extension or Pylance; confirmed `guess` / `likely` wires upgraded to `exact`
- **Virtual dispatch fan-out**: optional dashed wires from a virtual method to every override
- **Callbacks and function pointers** as a relation of their own (`signal(SIGINT, onSignal)`, registration tables)
- **Macros**: defines of `compile_commands.json` honoured in `#if` branches

## Change impact

- **What a change touches**: from a `git diff`, the changed functions and everything calling them, as a highlighted region of the circuit

## More languages and places

- **JavaScript / TypeScript, Go, Rust**
  - An extractor per language with the same rules as the others (*Adding a language* in [ARCHITECTURE](ARCHITECTURE.md))
  - A tracer per runtime
- **A standalone viewer** in the browser, later plugins for other IDEs
