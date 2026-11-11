# Roadmap

What CodeGraph may do next. Nothing here is promised or dated; what each released version brought is in the
[changelog](../CHANGELOG.md) and [VERSIONING](VERSIONING.md). Ideas and requests are welcome as issues.

## Seeing more of a function

- **Method blocks as nodes with pins**: open a function block to see an input pin per parameter (name and type), an
  output pin for the return value, and one row per call it makes — which argument goes into which parameter, what
  comes back and where it is stored — with the wire leaving from that row. During a replay the pins show the values
  of that moment.
- **Members from configuration**: follow a value read from a configuration file to the member chain it ends up in;
  mark types the analysis can only guess (`auto`, templates) as guesses.

## Between programs

- **An *Outside* block** for what a program talks to beyond the workspace — one child per endpoint (host, port,
  path), resolved from the code with a confidence and confirmed by a run.
- **Messages between processes**: pair a `send` in one container with the `recv` in another and draw the hop as a
  wire between their blocks.
- **Kubernetes pods** and dev containers, with the same wrappers as Compose.

## Runtime

- **Stop on a wire**: pause the program when a call goes along a chosen wire, optionally only when a condition on its
  values holds.
- **System calls**: an optional interception layer for the C library — files, sockets, processes — shown on the blocks
  that made them; which libraries are traced is set in `.codegraph.json`.
- **Follow a value**: track one value (a request id, a key) through every function and thread it passes, recording
  a fingerprint rather than the value itself.
- **Hot spots and data volume**: time spent per block as heat, bytes passed per wire as its thickness.
- **Locks and waiting**: mutex, lock, condition and queue waits, with contention shown between threads.
- **Attach without rebuilding** (Linux uprobes) and **coverage** of the lines that ran.

## Precision

- **Language-server confirmation**: ask clangd, the Microsoft C/C++ extension or Pylance for call hierarchies and
  upgrade `guess` / `likely` wires they confirm to `exact`.
- **Virtual dispatch fan-out**: optional dashed wires from a virtual method to every override.
- **Callbacks and function pointers** as a relation of their own (`signal(SIGINT, onSignal)`, registration tables).
- **Macros**: honour the defines of `compile_commands.json` in `#if` branches.

## Change impact

- **What a change touches**: from a `git diff`, the functions it changes and everything that calls them, as a
  highlighted region of the circuit.

## More languages and places

- **JavaScript / TypeScript, Go, Rust**: an extractor per language with the same rules as the others (see
  *Adding a language* in [ARCHITECTURE](ARCHITECTURE.md)), and a tracer per runtime.
- **A standalone viewer** in the browser, and later plugins for other IDEs.
