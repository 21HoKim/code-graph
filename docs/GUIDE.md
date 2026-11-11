# CodeGraph guide

[README](../README.md) · [한국어](GUIDE.ko.md) · [Architecture](ARCHITECTURE.md) · [Roadmap](ROADMAP.md) · [Changelog](../CHANGELOG.md) · [Versions](VERSIONING.md)

- [Install](#install)
- [The circuit view](#the-circuit-view)
- [Compile check](#compile-check)
- [Run & Trace](#run--trace)
- [Docker Compose](#docker-compose)
- [.codegraph.json](#codegraphjson)
- [Commands, keys and settings](#commands-keys-and-settings)
- [Command line](#command-line)
- [Limitations](#limitations)

## Install

- **Marketplace**: search for **CodeGraph** in the *Extensions* view, or run
  `code --install-extension 21HoKim.code-graph-vscode`
  ([Marketplace page](https://marketplace.visualstudio.com/items?itemName=21HoKim.code-graph-vscode)).
- **Cursor, VSCodium, Windsurf, Theia**: search for **CodeGraph** in their *Extensions* view; they install it from
  [Open VSX](https://open-vsx.org/extension/21HoKim/code-graph-vscode).
- **VSIX**: every [release](https://github.com/21HoKim/code-graph/releases) has its `.vsix` attached. In VS Code
  open the *Extensions* view, then `…` → *Install from VSIX…*
- **From source**:

  ```bash
  git clone https://github.com/21HoKim/code-graph && cd code-graph
  npm ci
  npm run build          # dist/: extension, parse worker, webview, WASM grammars, runtime tracers
  npm test
  npx @vscode/vsce package --no-dependencies   # -> code-graph-vscode-<version>.vsix
  ```

  To try a development build without installing it: `code --extensionDevelopmentPath="$PWD" samples/cpp-router`.

The compile check and Run & Trace execute your compiler and your program, so they are off in untrusted workspaces.
They need `gcc` or `clang` (Linux, macOS; MinGW on Windows is untested) and/or Python 3.8+, and Docker with
Compose v2 for containers.

## The circuit view

- **C, C++ and Python**, parsed with tree-sitter (WebAssembly, so no native dependencies).
- **Levels that fit the language**: Folder → File → Namespace → Class → Function for C++, File → Function for C,
  Package → Module → Class → Function for Python. Wires are lifted to the visible blocks and merged; double-click
  a block to open it in place.
- **Two groupings** for C++: *Files* (physical) and *Symbols* (namespaces → classes → methods across files).
- **A header holds its source** (Files grouping, C/C++): `router.cpp` sits inside `router.h`, the header it
  implements. What the header declares stays at the header level — that is what callers see and where their wires
  arrive — and what only the source has (static helpers, an anonymous namespace) sits inside the source block. A
  source with nothing of its own is not drawn. Turn off with `codeGraph.headerWrapsSource`.
- **Block badges**: `↻N` counts calls that start and end inside the block, so they draw no wire out of it — click
  it to list them with their code. `+N` is how many items a closed block holds — click it to open the block.
- **Details panel**: a function shows every parameter and its return type in full, each `return` statement, and the
  whole statement of each call in and out (in your colour theme; click to open). A class shows its members, base
  and derived classes, where its objects are created, and where they live: members of other classes, parameters,
  return values. Under *Where members are read and written*, each member says how many functions read and write it
  (`cfg.link.peer.port`, `p->len = 0`, `self.port`, a bare `port_` in a method, through member types and base
  classes); open one to see those lines and light the functions up on the circuit, blue for reads, orange for writes.
- **Current**: charges travel from caller to callee (arguments) and back in amber (return values). Click a block
  and its wires show what travels on them, e.g. `(pkt, 100) ⟲ bool`.
- **Threads, statically**: `std::thread`, `std::async`, `std::jthread`, `pthread_create`,
  `threading.Thread(target=…)`, `executor.submit`, `asyncio.create_task` and more are drawn as orange ⚡ wires.
- **Every link has a confidence**: *exact*, *likely* (type inference) or *guess* (name only, dashed).
- **Circuit** and **network** layouts, jump to source, follow the cursor, and re-analysis of only what changed
  on save.

| Class level (C++) | Network layout (Python) |
| --- | --- |
| ![Class level of a C++ router: zones for folders, files and namespaces](images/circuit-cpp.png) | ![Python pipeline in network layout](images/network-python.png) |

## Compile check

- **Your real toolchain**: every translation unit goes through `gcc`/`clang -fsyntax-only` with the flags from
  `compile_commands.json` (or from the makefile when there is none), and every Python file through `compile()`
  (plus pyflakes for undefined names when it is installed). It runs when the view opens; a save re-checks only
  the units it affects.
- **Without a compiler too**: parse errors, functions declared but never defined, `NotImplementedError` stubs
  that are called, undefined Python names, missing relative imports and local `#include`s.
- **Impact**: the broken block is **red**; callers that depend on it are **orange** with their distance (`⚠ +1`);
  blocks only reachable through a break are **grey** (no current); the wire into a break is cut.
- **Problems panel**: every error with its line, how many blocks it affects, and for an orange block the path
  to the break.

## Run & Trace

- **One click**: compile check → build (C/C++) → run with a tracer → replay. Build, link and runtime failures
  come back as red blocks.
- **C / C++**: the sources are copied and get one probe per function body, on the line of the `{`, so compiler
  line numbers stay the same. A small runtime records per-thread calls, argument values, `this` and pointer
  identities; on a crash (`SIGSEGV`, an uncaught exception) it records which function every thread was in.
- **Built the way your project builds it**: with a makefile or CMake, each program's sources, defines
  (`-DNODE_A`), include and library flags, and the folder it runs from come from a `make -n` dry run or CMake's
  link files, so relative paths like `../cfg` resolve. Without a build system, the units `main` needs are found
  from the graph. A link that still misses symbols is retried with the libraries that usually provide them
  (OpenSSL, Boost.JSON, libm, …). The link's library folders (`-L`, `-rpath`) are on the library path when the
  program runs, so a library found there loads its own dependencies from there too (Boost.JSON → Boost.Container),
  even where `-rpath` is written as a RUNPATH (Ubuntu, Debian). Any other build (a script, Meson, Bazel…) goes in
  `.codegraph.json`: `run.build` and `run.program`. It runs in a traced copy of the workspace with every compiler
  wrapped.
- **Python**: a standard-library tracer (`sys.monitoring` on 3.12+, `sys.setprofile` before) records calls,
  returns, exceptions, values and object identities per thread, for workspace code only.
- **Live**: while the program runs, each thread's current call stack lights up in its colour, calls of the last
  moment pulse along their wires, and busy functions show how many calls they just took (`+120`). The bar at the
  bottom has the threads, the time and **■ Stop**. A run lasts until the program ends or you press Stop
  (`run.timeoutSeconds` sets a limit; 0, the default, is none); Stop keeps everything recorded and the replay
  follows. A long run is replayed with its first `run.maxEvents` calls in detail; the live view covers all of it.
- **Replay**: thread swimlanes with play, scrub and step. Blocks on each thread's call stack glow in the thread's
  colour, pulses run along the wires, values ride into the blocks. Blocks that never ran fade out; calls only the
  run revealed (virtual dispatch, callbacks) get wires of their own. In the swimlanes, drag the playhead (or the
  time axis) to scrub and drag anywhere else to move the view; Shift + wheel moves it too (down: earlier, up:
  later), the wheel zooms, a click jumps there and a double-click shows the whole run.
- **Data tracking**: objects used by several threads are listed (*the same `Router`, `PacketQueue`, `ringbuf_t*`
  in every thread*). Click one to light up every function it passed through, in order.

| Run & Trace of a C++ router | Data trail of a ring buffer shared by three threads |
| --- | --- |
| ![rx and tx threads light up their blocks, values ride on the wires](images/trace-cpp.png) | ![The ring buffer followed through producer, consumer and main](images/data-trail.png) |

## Docker Compose

**Run & Trace with Docker Compose** runs the workspace's compose project with its own images, network, fixed
addresses and healthchecks. Every traced process writes its own trace, and all of them are merged on one clock
with each container's threads as lanes. Your workspace is never touched: everything is built from a traced copy,
and the project is taken down at the end.

**One circuit per container**: **⧉ A view per container** (toolbar, run summary, or *CodeGraph: Open a View per
Container*) opens one view per container side by side, each with only that container's threads, calls and data.
They share one clock and play together; click a container in the run summary to open just that one. No need to
attach VS Code to each container: one Compose run traces them all. Trace files written elsewhere (one per machine
or container) can be loaded together with **Load Trace File…**; they are merged onto one timeline the same way.

![node-b and node-a side by side, playing together](images/per-container.png)

**Which compose files**: `compose.yaml` / `docker-compose.yml` (and the `.yml` / `.yaml` variants) at the
workspace root plus its override file, as `docker compose` reads them, or `compose.files` (and `profiles`) in
`.codegraph.json`.

**Which services are traced**: those whose container has some of the workspace's C, C++ or Python sources.

| the service… | what CodeGraph does |
| --- | --- |
| mounts the workspace or a folder of it (`- ./:/app`) | mounts the traced copy there instead; a build at start (`make`, CMake, a script) goes through the compiler wrappers |
| builds its image from the workspace and its Dockerfile copies sources in (`COPY . .`, `COPY src/ /app/src/`, `RUN --mount=type=bind`) | rebuilds the image from the traced copy with the wrappers added before the first copy of each build stage, multi-stage builds included |
| has the code somewhere CodeGraph cannot tell | `compose.sourcePath` in `.codegraph.json` |
| only runs a program built elsewhere | `compose.build`: a command run in the container before its own |
| has none of the sources (a database, a proxy) | runs as it is |

Inside a traced container, every C/C++ compiler on `PATH` is wrapped (`gcc`, `g++-12`, `clang++-17`, cross
compilers, `CC`/`CXX` given by full path, `ccache` in front works too). So is every Python interpreter, and a
`sitecustomize` traces the Python processes started some other way (by full path, gunicorn, multiprocessing
children). The run is followed live, and lasts until every traced container has ended or you press **■ Stop**;
`timeoutSeconds` sets a limit, counted from the first traced program. Image builds and builds inside the
containers have `startTimeoutSeconds` (600 s).

When a service ran without a traced program, the run summary says why and which key of `.codegraph.json` fixes it:

| note | write |
| --- | --- |
| *neither mounts the workspace nor copies it into its image* | `compose.sourcePath`: where the code is in that container |
| *it compiled nothing in its container* | `compose.build`: the build command, e.g. `make -C /app server` (also when the makefile calls `/usr/bin/g++` by full path: `make CXX=g++ …`) |
| *no workspace Python code ran in it* | `compose.sourcePath` if its code is elsewhere |
| *no compose file in the workspace* | `compose.files` |

![Two nodes in their own Compose network: node-b's serve thread verifies node-a's message while node-a's reader waits](images/compose-trace.png)

## .codegraph.json

Optional, at the workspace root: only what CodeGraph cannot find out by itself. A key here wins over the matching
VS Code setting, and the command line reads it too. **CodeGraph: Create / Open .codegraph.json** writes a starter
with every key commented out and what was detected as the examples. It is JSON with comments; the editor
completes and explains every key.

| key | meaning |
| --- | --- |
| `run.entry` | what to run: a C/C++ file with `main()` or a Python script / package |
| `run.target` | which program, when the makefile / CMake makes several from the entry |
| `run.args`, `run.cwd`, `run.env` | arguments, the folder to run in (default: where the build puts it), extra environment |
| `run.build`, `run.program` | a build CodeGraph does not read by itself and the program it makes (workspace-relative) |
| `run.buildFlags`, `run.linkFlags` | extra compile flags (`-DDEBUG`), extra libraries (`-lssl`) |
| `run.timeoutSeconds` | stop the program after this long (the trace so far is kept); 0 = when it ends, or Stop |
| `compose.files`, `compose.profiles` | compose files in order, profiles to enable |
| `compose.services` | which services to trace (default: every service that has workspace sources) |
| `compose.build` | per service: a command run in its container before its own command |
| `compose.sourcePath` | per service: where the workspace is in its container |
| `compose.env` | per service: extra environment for the traced run (e.g. `CXX`) |
| `compose.timeoutSeconds`, `compose.startTimeoutSeconds` | how long the programs run (0 = until Stop); time for image and in-container builds |

```jsonc
{
  "run": { "entry": "src/main.cpp", "target": "node-b", "args": ["--verbose"] },
  "compose": {
    "files": ["compose.yaml", "compose.test.yaml"],
    "profiles": ["test"],
    "build": { "gateway": "cmake -B /src/build /src && cmake --build /src/build" },
    "sourcePath": { "worker": "/opt/worker" },
    "env": { "gateway": { "CXX": "g++-12" } }
  }
}
```

## Commands, keys and settings

| | |
| --- | --- |
| `CodeGraph: Open Circuit View` | analyze the workspace and open the view (the compile check runs too) |
| `CodeGraph: Show in Circuit View` | focus the current file (explorer / editor context menu, status bar) |
| `CodeGraph: Verify (compile check)` | check again now (toolbar **✓ Verify**) |
| `CodeGraph: Run & Trace` | build, run and replay (toolbar **▶ Run**) |
| `CodeGraph: Run & Trace with Docker Compose` | the compose project with its services traced in their containers |
| `CodeGraph: Open a View per Container` | one circuit per container of the current trace, side by side, playing together |
| `CodeGraph: Stop Run and Show the Trace` | end the run in progress (the live bar's **■ Stop**) and replay what it recorded |
| `CodeGraph: Create / Open .codegraph.json` | project settings for unusual setups |
| `CodeGraph: Load Trace File…` | open a trace written by the CLI or the tracers; several at once share one timeline |
| click / double-click a block | show its wires · open it, or jump to the source |
| hover a block / wire | its source in your colour theme: the definition's first lines · the line of the call |
| `Ctrl`+click (`⌘`+click) · `F12` / `Enter` | jump to the code: a block's definition · a wire's call |
| `1`…`5` · `/` · `F` · `Esc` | levels · search · fit · clear |
| `Space` · `←` `→` | (with a trace) play / pause · previous / next call |

Settings (`codeGraph.*`):

- view: `defaultLevel`, `layout`, `flow.mode`, `flow.maxParticles`, `showGuessedLinks`, `followCursor`,
  `exclude`, `maxFiles`, `cpp.includePaths`, `analysis.workers`
- compile check: `verify.mode` (`onOpenAndSave` · `onOpen` · `manual`), `verify.cc`, `verify.cxx`,
  `verify.python`, `verify.extraFlags`, `verify.useCompileCommands`, `verify.editorDiagnostics`, `verify.timeoutSeconds`
- Run & Trace: `run.entry`, `run.args`, `run.cwd`, `run.env`, `run.buildFlags`, `run.linkFlags`, `run.useBuildSystem`,
  `run.target`, `run.timeoutSeconds`, `run.maxEvents`, `run.captureValues`
- Docker Compose: `run.compose.file`, `run.compose.services`, `run.compose.startTimeoutSeconds`, `run.compose.docker`

## Command line

```bash
node dist/cli.js path/to/project -o graph.json            # static graph
node dist/cli.js path/to/project --verify -o graph.json   # + compile check, exit code 2 on errors (CI)
node dist/cli.js trace path/to/project -o run.json -- --program --args
node dist/cli.js trace path/to/project --target node-b -o run.json   # one of the makefile's programs
node dist/cli.js trace path/to/project --compose [FILE…] [--profile P] [--service S] -o run.json
# src/main.cpp · main(): exit 0 · 6 threads · 1657 calls · 15 shared objects · 1008 ms traced
```

`trace` reads `<project>/.codegraph.json` like the extension does; options given on the command line win.

## Limitations

- **Static view**: macros are not expanded, templates are not instantiated, virtual dispatch and callbacks
  resolve to the declared target (a trace shows the real ones).
- **Run & Trace** reads makefiles (the default goal's `make -n`) and CMake; other builds need `run.build`.
  Programs run without stdin. C/C++ record argument values, not return values.
- **Docker Compose**: a makefile that calls the compiler by full path (`/usr/bin/g++`) bypasses the wrappers (use
  `compose.build` with `make CXX=g++`); an image built from a context outside the workspace is not rebuilt.
- Identities are addresses: Python and the C allocator may reuse an address after an object is freed, so a long
  trail can mix two lifetimes.
- Tracing costs time: about 1 µs per Python call in workspace code, less in C/C++. After `run.maxEvents` detailed
  events only call counts are kept.

Contributions are welcome, see [CONTRIBUTING.md](../CONTRIBUTING.md). MIT © 김호 (21HoKim); third-party
components in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
