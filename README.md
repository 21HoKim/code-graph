# CodeGraph

**See your C, C++ and Python code as a live circuit.**
Folders, files, namespaces, classes and functions become blocks; calls, thread spawns, object creation and
inheritance become wires — and data flows along them like current. Compile it and broken parts turn red with
their impact spreading along the wires; run it and every thread lights up its own path, carrying real values.

[한국어 README](README.ko.md) · [Architecture](docs/ARCHITECTURE.md) · [Roadmap](docs/ROADMAP.md) · [Changelog](CHANGELOG.md)

![Replaying a run of a C++ router: rx and tx threads light up their blocks, values ride on the wires, swimlanes below](docs/images/trace-cpp.png)

## Features

### Static circuit
- **C, C++ and Python** parsed with tree-sitter (WebAssembly — no native dependencies).
- **Abstraction levels that fit the language**: Folder → File → Namespace → Class → Function for C++;
  File → Function for C; Package → Module → Class → Function for Python (no namespaces where the language has
  none). Wires are lifted to whatever is visible and merged; double-click a block to open it in place.
- **Two groupings** for C++: *Files* (physical) and *Symbols* (namespaces → classes → methods across files).
- **Electric flow**: charges travel caller → callee (arguments), amber charges travel back (return values).
  Click a block and its wires show what travels on them (`(pkt, 100) ⟲ bool`).
- **Concurrency, statically**: `std::thread`, `std::async`, `std::jthread`, `pthread_create`,
  `threading.Thread(target=…)`, `executor.submit`, `asyncio.create_task`, … drawn as orange ⚡ spawn wires.
- **Honest resolution**: every link is *exact*, *likely* (type inference) or *guess* (name only, dashed).
- **Circuit** and **network** layouts (ELK in a web worker), jump to source, follow the cursor, incremental
  re-analysis on save.

| Class level (C++) | Network layout (Python) |
| --- | --- |
| ![Class level of a C++ router: zones for folders, files and namespaces](docs/images/circuit-cpp.png) | ![Python pipeline in network layout](docs/images/network-python.png) |

### Compile check: only what is broken turns red
- **Real toolchain**: every translation unit through `gcc`/`clang -fsyntax-only` (flags from
  `compile_commands.json` when there is one), every Python file through `compile()` (+ pyflakes undefined names
  when installed). Runs when the view opens and re-checks only the units a save affects.
- **Static checks without a compiler**: parse errors, functions declared but never defined, `NotImplementedError`
  stubs that are called, undefined Python names, missing relative imports / local `#include`s.
- **Impact on the circuit**: the broken block is **red**; callers that depend on it are **orange** with their
  distance (`⚠ +1`); blocks that can only be reached through a break are **grey** (no current); the wire into a
  break is cut — current runs up to the break and sparks out. Containers only count the errors inside them.
- **Problems panel**: every error with its source line, how many blocks it affects, and for any orange block the
  path to the break that affects it.

![Broken C++: calibrate does not compile (red), read and main depend on it (orange), clampRange gets no current](docs/images/problems.png)

### Run & Trace: threads, data and crashes
- **One click**: compile check → build (C/C++) → run with a tracer → replay. Build, link and runtime failures
  come back as red blocks, like compile errors.
- **Python**: a stdlib-only tracer (`sys.monitoring` on 3.12+, `sys.setprofile` before) records calls, returns,
  exceptions, argument / return values and object identities, per thread, for workspace code only.
- **C / C++**: the sources are copied and get one probe per function body, written on the line of the `{` so
  compiler line numbers do not move; a small runtime records per-thread calls, argument values, `this` and pointer
  identities, and on a crash (`SIGSEGV`, uncaught exception → `SIGABRT`) which function every thread was in.
- **Built the way your project builds it**: with a makefile or CMake, each program's sources, defines
  (`-DNODE_A`), include and library flags and the directory it runs from come from a `make -n` dry run or CMake's
  link files, so relative paths like `../cfg` resolve. When one `main.cpp` goes into several programs you pick
  which. Without a build system the units `main` needs are found from the graph, with your
  `compile_commands.json` flags. A link that still misses symbols is retried with the libraries that usually
  provide them (OpenSSL, Boost.JSON, libm, …) and reported in one line.
- **Replay**: thread swimlanes with play / scrub / step; blocks on each thread's call stack glow in the thread's
  colour, pulses run along the wires, argument and return values ride into the blocks. Blocks and wires that never
  ran fade out; calls only the run revealed (virtual dispatch, callbacks) get wires of their own.
- **Parallel structure**: who started which thread and where it begins; colour stripes show which threads ran a
  block; solo one thread to see only its part of the circuit.
- **Data tracking**: objects used by several threads are listed (*the same `Router`, `PacketQueue`, `ringbuf_t*`
  in every thread*); click one to light up every function it passed through, in order, with its sightings marked
  on the swimlanes.

| Python pipeline replay | Data trail of a ring buffer shared by three threads |
| --- | --- |
| ![Python pipeline: pump threads, dispatcher and pool workers with values](docs/images/trace-python.png) | ![The ring buffer object followed through producer, consumer and main](docs/images/data-trail.png) |

### Docker Compose: every container on one timeline
- Programs that need their peers (a client and its server, the nodes of a protocol) run in your project's own
  Compose setup — its images, network, fixed addresses and healthchecks — with **Run & Trace with Docker
  Compose**.
- The services that mount the workspace (e.g. `volumes: - ./:/app`) build a traced copy of it with their own
  command (make, CMake, a script): compiler shims first on `PATH` add the tracer to every compile and link inside
  the container. Your workspace is not touched, and the project is taken down when the trace is done.
- Every traced process writes its own trace; they are merged on one clock, with each container's threads as
  lanes named after it, so you see one node's request leave and the other node's handler pick it up. The run
  summary lists how each container ended.

![Two nodes in their own Compose network: node-b's serve thread verifies node-a's message while node-a's reader waits for the acknowledgement](docs/images/compose-trace.png)

## Install

**From the Marketplace**: search for **CodeGraph** in the *Extensions* view, or

```bash
code --install-extension 21HoKim.code-graph-vscode
```

([Marketplace page](https://marketplace.visualstudio.com/items?itemName=21HoKim.code-graph-vscode))

**From a release (.vsix)**: every release on the [Releases](https://github.com/21HoKim/code-graph/releases) page
has its `.vsix` attached. In VS Code: *Extensions* view → `…` menu → *Install from VSIX…*

**From source**

```bash
git clone https://github.com/21HoKim/code-graph && cd code-graph
npm ci
npm run build          # dist/: extension, parse worker, webview, WASM grammars, runtime tracers
npm test               # analyzer, projection, compile-check and Run & Trace tests
npx @vscode/vsce package --no-dependencies   # -> code-graph-vscode-<version>.vsix
```

To try a development build without installing it: `npm run build`, then
`code --extensionDevelopmentPath="$PWD" samples/cpp-router`.

**Requirements for compile check and Run & Trace**: `gcc` or `clang` (Linux, macOS; MinGW on Windows is
untested) and/or Python 3.8+. Both execute your compiler and your program, so they are disabled in untrusted
workspaces. The static view needs nothing.

## Use

Click the **CodeGraph** icon in the activity bar on the left. The panel has a button for each step (open the
circuit, show the current file, compile check, Run & Trace, load a trace) with a line on what it does;
refresh at its top re-analyzes the workspace.

![The CodeGraph panel in the activity bar, next to the circuit view of a C++ project](docs/images/sidebar.png)

The same commands are in the Command Palette:

| | |
| --- | --- |
| `CodeGraph: Open Circuit View` | analyze the workspace and open the view (compile check runs too) |
| `CodeGraph: Show in Circuit View` | focus the current file (explorer / editor context menu, status bar) |
| `CodeGraph: Verify (compile check)` | check again now (toolbar **✓ Verify**) |
| `CodeGraph: Run & Trace` | build, run and replay (toolbar **▶ Run**; asks which `main`/script, and which program when the makefile builds several from it) |
| `CodeGraph: Run & Trace with Docker Compose` | run the workspace's compose project with its services traced in their containers (Docker with Compose v2) |
| `CodeGraph: Load Trace File…` | open a trace written by the CLI or the tracers |
| click a block / double-click | trace its wires · expand, collapse or open source |
| `1`…`5` · `/` · `F` · `Esc` | levels · search · fit · clear |
| `Space` · `←` `→` | (with a trace) play / pause · previous / next call |

Settings (`codeGraph.*`):

- view: `defaultLevel`, `layout`, `flow.mode`, `flow.maxParticles`, `showGuessedLinks`, `followCursor`,
  `exclude`, `maxFiles`, `cpp.includePaths`, `analysis.workers`
- compile check: `verify.mode` (`onOpenAndSave` · `onOpen` · `manual`), `verify.cc`, `verify.cxx`,
  `verify.python`, `verify.extraFlags`, `verify.useCompileCommands`, `verify.editorDiagnostics`
  (also mark errors from clangd / C/C++ / Pylance), `verify.timeoutSeconds`
- Run & Trace: `run.entry`, `run.args`, `run.cwd`, `run.env`, `run.buildFlags`, `run.linkFlags`,
  `run.useBuildSystem` (read the makefile / CMake), `run.target` (which program), `run.timeoutSeconds`
  (default 20 s; the trace up to the stop is kept), `run.maxEvents`, `run.captureValues`
- Docker Compose: `run.compose.file`, `run.compose.services` (default: every service that mounts the workspace),
  `run.compose.startTimeoutSeconds` (image and in-container builds, default 600 s), `run.compose.docker`

### Command line

```bash
node dist/cli.js path/to/project -o graph.json            # static graph
node dist/cli.js path/to/project --verify -o graph.json   # + compile check, exit code 2 on errors (CI)
node dist/cli.js trace path/to/project -o run.json -- --program --args
node dist/cli.js trace path/to/project --target node-b -o run.json   # one of the makefile's programs
node dist/cli.js trace path/to/project --compose -o run.json         # its compose project, every container
# src/main.cpp · main(): exit 0 · 6 threads · 1657 calls · 15 shared objects · 1008 ms traced
```

## How it works

1. **Parse** — every source file is parsed with tree-sitter on worker threads into per-file facts
   (definitions, calls, includes/imports), cached by modification time.
2. **Link** — the facts are resolved across files into one graph of entities (namespaces, classes, functions)
   and relations (call, spawn, create, inherit, include), each with a confidence.
3. **Check** — the real compiler / interpreter checks the code; every error is attached to the function it is
   in, and the impact is computed along the relations (who depends on it, what loses current).
4. **Run** — for Run & Trace the program is built with probes (C/C++) the way the project's makefile or CMake
   builds it, or started under the tracer (Python) — directly, or in its Compose containers through compiler
   shims; the traces become calls per thread (per container), values and the objects that travelled between them.
5. **Draw** — the view picks the blocks of the chosen level, merges the wires between them, lays them out with
   ELK in a web worker and draws SVG plus a canvas for the moving current.

Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Limitations

- **Static**: macros are not expanded, templates not instantiated, virtual dispatch and callbacks resolve to the
  declared target (a trace shows the real ones). Low-confidence links are marked as such.
- **Run & Trace** follows makefiles (the default goal's `make -n`) and CMake (`compile_commands.json` + link
  files); other build systems get the translation units reachable from `main`, plus `run.buildFlags` /
  `run.linkFlags`. Programs run without stdin.
- **Docker Compose** traces C/C++ services that mount the workspace and build inside the container with
  gcc / g++ / cc / c++ / clang by name (a build that hard-codes `/usr/bin/g++` bypasses the shims). Python services
  and images that bake the sources in at build time are not traced yet.
- C/C++ record argument values, not return values. Identities are addresses: Python and the C allocator may
  reuse an address after an object is freed, so a long trail can mix two lifetimes.
- Tracing costs time: about 1 µs per Python call in workspace code, less in C/C++. After `run.maxEvents` detailed
  events only call counts are kept.

## Roadmap

1. **Precision** — language-server call hierarchy to confirm links, virtual-dispatch fan-out, callbacks.
2. **More runtime** — messages between processes drawn as wires, lock / wait events and contention heat, attach
   to a running process (eBPF), stream a live debug session.
3. **More languages** — Rust, Go, Java, TypeScript.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Adding a language is mostly one extractor file.

## License

MIT © 김호 (21HoKim). Third-party components: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
(ELK is EPL-2.0, tree-sitter is MIT).
