# Changelog

From 0.2.1 on, every change to the extension pushed to `main` is published automatically as the next patch
version. Each change is written under **Unreleased** (Added / Changed / Fixed) when it is made; the release turns that
into the version's section and its [release notes](https://github.com/21HoKim/code-graph/releases). In Korean:
[CHANGELOG.ko.md](CHANGELOG.ko.md). What the three numbers mean: [docs/VERSIONING.md](docs/VERSIONING.md).

## Unreleased

### Fixed
- *Where it returns* lists only the function's own `return` statements: those of a lambda or a local class
  written inside it no longer show up (a `void` function holding `[] { return g(); }` says it has no return).
- A `return` spread over several lines, or written in a one-line block (`if (ok) { return g(a, b); }`), is shown
  whole, from `return` to its own `;`.

## 0.5.10

### Added
- Published to Open VSX as well, so Cursor, VSCodium, Windsurf and Theia can install it from their own extension view.

## 0.5.9

### Changed
- Reworded the 0.5.8 notes.

## 0.5.8

### Added
- Class details: under each class that holds it as a member, where that class goes on to (the classes holding it,
  the functions taking it), so a chain like `Address` → `Customer.address` → `Order.customer` can be
  followed up.

### Fixed
- *Held as a member by*, *Taken as a parameter by* and *Returned by* find types written partly qualified
  (`billing::Customer` inside `shop`) and look names up from the scope they are written in, so two
  classes with the same name in different namespaces (`billing::Address`, `shipping::Address`) are no longer mixed up.

## 0.5.7

### Added
- Python classes list every `self.x = …` attribute as a member, typed when the value or annotation tells.
- C: a `typedef struct ringbuf {…} ringbuf_t;` name counts as the struct, so functions taking `ringbuf_t*` show
  up under *Taken as a parameter by*.

### Fixed
- C/C++ members keep their declared type: `int* data`, `char name[16]` (the `*`, `&` and `[N]` were dropped).

## 0.5.6

### Added
- `↻N` on a block (calls that stay inside it) is clickable: the details panel opens at a list of those calls with
  their code. `+N` on a closed block opens it.
- The signature box is written as the language writes it (`int lookup(uint32_t dst)`, `def f(x: int) -> str`) and
  coloured in your theme, and so is a class's member list.

### Changed
- The collapse button of an open block is a larger square with a light shade.
- No tooltip over an open block's empty area or over its header buttons and badges.

### Fixed
- A code snippet at an `#include` line no longer runs on to the next `;`.

## 0.5.5

### Added
- **A header holds its source** (Files grouping, C/C++): `router.cpp` sits inside `router.h`. What the header
  declares is at the header level, where callers' wires arrive; what only the source has stays inside it.
  `codeGraph.headerWrapsSource` turns it off.
- Function details: every `return` statement and the whole statement of each call in and out, as code.
- Class details: members, base and derived classes, where objects are created, and where they live (members of
  other classes, parameters, return values).

### Changed
- Wire labels are placed where they cover no block or title; a wire too short for its label gets a small `⋯`.

### Fixed
- Parameter and return types are no longer cut at 40/32 characters.

## 0.5.4

### Fixed
- The tooltip no longer grows while the pointer trembles over a block near the edge of the view: it stays where it
  appeared, opening left of or above the pointer when there is no room.

## 0.5.3

### Changed
- The source preview appears in about a quarter of a second: grammars load when the view opens, and plain lines show
  first if a hover beats them.

### Fixed
- The preview is coloured in WSL, SSH and container windows (Dark+ / Light+ stand in when the theme's files are on
  the other machine) and with the renamed built-in themes. The *CodeGraph* output says which theme it uses.

## 0.5.2

### Changed
- More search keywords: codegraph, visualizer, code map, graph view, diagram, call hierarchy…

## 0.5.1

### Added
- Hovering a block previews its source (the comment above, the header, the first lines), coloured in your theme;
  hovering a wire shows the line of the call.
- `Ctrl`+click (`⌘`+click) or `F12` opens a block's definition or a wire's call site.

### Changed
- Labels on wires and replay values stop at 32 characters (addresses keep both ends); the tooltip has the rest.

## 0.5.0

- **Live**: Run & Trace and Run & Trace with Docker Compose follow the program while it runs. Each thread lights up
  where it is right now, calls flow along the wires, and busy functions show how many calls they just took. Every
  container is followed live, in its own colours.
- Runs have no time limit any more: they last until the program ends or you press **■ Stop** in the live bar (or run
  *CodeGraph: Stop Run and Show the Trace*). Stopping keeps everything recorded, and the replay follows.
  `run.timeoutSeconds` still sets a limit for those who want one.
- A container kept from an earlier run no longer links a tracer runtime from an older CodeGraph version.

## 0.4.1

- **A view per container**: after a Compose run (or loading several trace files at once), one circuit per
  container opens side by side, each with only what ran in that container. They play together on one clock.
- Run & Trace puts the link's library folders on the library path, so a library found there loads its own
  dependencies from there too. This fixes `error while loading shared libraries: libboost_container…` for programs
  linked with `-Wl,-rpath`, which most distributions write as a RUNPATH. In containers the compiler wrapper writes
  `-rpath` as an RPATH for the same reason.
- A program that fails here in a workspace with a compose file gets a button to run the Compose project instead.

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
