# Changelog

From 0.2.1 on, every change to the extension pushed to `main` is published automatically as the next patch
version; the notes for each one are on the [Releases](https://github.com/21HoKim/code-graph/releases) page.

## 0.3.0

**Run & Trace builds your program the way your project does**
- Makefiles (a `make -n` dry run) and CMake (`compile_commands.json` + link files) give each program's sources,
  defines, include and library flags, and the directory it runs from — so `-DNODE_A`, `-lssl -lcrypto
  -lboost_json` and relative paths like `../../cfg` just work. When one `main.cpp` goes into several programs,
  CodeGraph asks which (or set `codeGraph.run.target`). The compile check uses the same flags.
- A link that misses symbols is retried with the libraries that usually provide them (OpenSSL, Boost.JSON, libm,
  …, with `-L` for libraries under `/opt`), and a failed link is reported in a few lines on `main` instead of
  hundreds of linker messages.

**Run & Trace with Docker Compose**
- Runs the workspace's compose project — its images, network and healthchecks — with the services that mount
  the workspace building a traced copy inside their containers (compiler shims on `PATH`, nothing to change in
  the project). Every container's threads are merged into one timeline on a common clock; the run summary lists
  how each container ended. In the CodeGraph panel, the command palette, and the CLI (`trace --compose`).
- `samples/net-pair`: a client and a server on their own Compose network.

**Other**
- Stopping a run at the time limit is no longer shown as a failure.
- Traces record their clock, process id and program name; `{pid}` in `CODE_GRAPH_TRACE` gives each process its
  own file.

## 0.2.1

- CodeGraph icon in the activity bar: a panel with a button for each step (open the circuit, show the current
  file, compile check, Run & Trace, load a trace) and a short guide; re-analyze from its title bar.
- Published on the VS Code Marketplace as `21HoKim.code-graph-vscode`.

## 0.2.0

**Compile check — only what is broken turns red**
- Verify with the real toolchain: `gcc`/`clang -fsyntax-only` per translation unit (`compile_commands.json`
  aware), Python `compile()` + pyflakes undefined names. On open and on save (affected units only), or manually.
- Static problems without a compiler: parse errors, declared-but-undefined functions, called
  `NotImplementedError` stubs, undefined Python names, missing relative imports and local includes.
- Impact overlay: broken blocks red, dependent callers orange with distance, blocks only reachable through a break
  grey; cut wires with a break mark where the current sparks out. Problems panel with impact paths.
- Optional language-server errors; disabled in untrusted workspaces. CLI `--verify` (exit code 2 on errors).

**Run & Trace — threads, data and crashes**
- Python tracer (`sys.monitoring` / `sys.setprofile`) and C/C++ source instrumentation with a small runtime:
  per-thread calls, argument (and Python return) values, object identities, uncaught exceptions, crash stacks.
- Builds the translation units `main` needs; build, link and runtime failures show up red.
- Replay: thread swimlanes with play / scrub / step, glowing call stacks, thread-coloured pulses, values riding
  into blocks, unexecuted code faded, runtime-only wires, solo a thread, run summary with the thread tree and
  objects shared between threads, data trail for any object.
- CLI `trace` writes a replayable trace; `Load Trace File…` opens it.

**Other**
- Abstraction levels follow the language: Namespace only with C++, File → Function for C, Package → Module →
  Class → Function for Python.
- Broken C++/Python samples; the C++ router sample sends real payloads and loopback traffic.

## 0.1.0

- First release: static circuit view for C, C++ and Python.
- Five abstraction levels, files/symbols grouping, circuit/network layouts.
- Electric flow animation (arguments forward, return values backward).
- Static thread-spawn detection (std::thread, std::async, pthread_create, threading, executors, asyncio).
- Confidence levels for every link; search, focus, follow-cursor, incremental re-analysis, CLI.
