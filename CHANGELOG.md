# Changelog

From 0.2.1 on, every change to the extension pushed to `main` is published automatically as the next patch
version; the notes for each one are on the [Releases](https://github.com/21HoKim/code-graph/releases) page.

## 0.4.0

**Traces your setup as it is**
- Docker Compose: every service whose container has your sources is traced, whether they are mounted
  (`- ./:/app`) or copied into its image by its Dockerfile (`COPY`, multi-stage builds, `RUN --mount=type=bind`).
  Such images are rebuilt from the traced copy with the compiler wrappers added right before the first copy, so
  the layers above stay cached. Services without your code (databases, proxies) run as they are.
- In a traced container every C/C++ compiler on `PATH` is wrapped (`g++-12`, `clang++-17`, cross compilers,
  `CC`/`CXX` given by full path, `ccache` in front), and Python is traced however it is started: by name, by full
  path, through gunicorn or as a multiprocessing child. A forked process gets a trace of its own.
- Several compose files, the override file and profiles; trace files are named `<host>-<pid>`, so replicas do not
  collide.

**`.codegraph.json` for unusual setups**
- One file at the workspace root for what CodeGraph cannot find out by itself: a build script (`run.build` +
  `run.program`, run in a traced copy with every compiler wrapped), the program, its arguments and folder, compose
  files and profiles, which services to trace, a build to run in a container first (`compose.build`), and where
  the code is in a container (`compose.sourcePath`). When a run cannot be set up, CodeGraph says what is missing
  and offers to create the file; **CodeGraph: Create / Open .codegraph.json** writes a starter with what it
  detected. The editor completes and explains every key, and the CLI reads the file too.

**Fixes**
- Python scripts in containers: the interpreter wrapper passed its arguments in the wrong order.
- A CMake build folder copied into the traced copy no longer builds back into the workspace.

**Docs**
- The README now has only usage, examples and GIFs; everything else is in [docs/GUIDE.md](docs/GUIDE.md).

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
