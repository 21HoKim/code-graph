# Changelog

- Releases: every extension change pushed to `main` published automatically as the next patch version (from 0.2.1)
- Writing: each change recorded under **Unreleased** (Added / Changed / Fixed) → the version's section and its [release notes](https://github.com/21HoKim/code-graph/releases) at release time
- Korean: [CHANGELOG.ko.md](CHANGELOG.ko.md)
- Version numbers: [docs/VERSIONING.md](docs/VERSIONING.md)

## Unreleased

## 0.6.0

### Added
- [examples/](https://github.com/21HoKim/code-graph/tree/main/examples) in the repository
  - Per-feature folders for C, C++ and Python (calls, threads, classes, returns, trace, failures, live, problems), each with a checklist
  - Realistic example programs (formerly `samples/`)
- Container cards: one card per container on the right of the circuit, live and in the replay, when there are several
  - Contents: running or how it ended, threads, calls, calls per second, activity
  - Click: only that container's code and threads / Ctrl (⌘) + click: add or remove
  - ⧉: own view, also while live (that view follows its container live)
  - Choice carried over from the live view into the replay
- Live view: swimlanes of every thread's stack, scrolling with the run
  - Drag back or Shift + wheel: an earlier moment / *Now*: follow again
  - Thread click: only that thread followed in the circuit
- Timeline: horizontal scrollbar under the swimlanes when zoomed in
  - Thumb = part of the run in view; drag, or click beside it for one view's width
- Legend: folds to its title (click *Legend*), stays folded
  - More than eight threads: *+N more* for the full list inside the legend, scrolled by the wheel
  - Wheel over the legend or the container cards: scrolls them instead of zooming the circuit

### Changed
- Timeline wheel
  - Wheel: swimlanes up and down
  - Ctrl (⌘) + wheel, trackpad pinch: zoom around the pointer
  - Shift + wheel reversed: down = later (right), up = earlier (left)
- Circuit: Shift + wheel moves sideways with any mouse (down = right); before, only when the browser turned it into a sideways scroll, zoom otherwise
- *A view per container*: a list of containers (threads, calls, how each ended) instead of opening all at once; only the ticked ones opened, each in its own column beside the circuit

### Fixed
- C++: threads started without `std::`
  - `thread(&Server::run, this).detach()` under `using namespace std;` (in the file, the function, or an included header)
  - After `using std::thread;`, through `using Worker = std::thread;` or `namespace b = boost;`
  - `std::thread t(worker);` (read as a variable, not a function), `std::thread t{worker};`
  - Thread members started in a constructor's initializer list (`: rx_(&Router::rxLoop, this)`) or a default member initializer
  - `emplace_back` into a vector of `std::jthread`
  - A bare `thread` the file never brings in: a guess
- C++: calls and types through `using ns::f;`, a namespace alias (`namespace io = lib::net;`), a `using namespace` inside a function or in a header — exact links instead of name matches; `Router r(cfg);` counted as creating a `Router`
- Python: thread and task APIs imported under another name (`from threading import Thread as T`, `from asyncio import create_task as spawn`)
- Run & Trace (C/C++): each thread's parent and starting function recorded by the run itself instead of guessed
  - `pthread_create`, C11 `thrd_create`, `std::thread`, `std::async`
  - Lanes branching off the right thread; ⚡ wires even when the analysis cannot tell the function (a function pointer)
  - Python threads: starting function recorded as well
  - Statically linked programs: the guess as before
- Run & Trace (C/C++): an object a thread receives as `void*` named by the type another function gives it (`struct counter*`)
- Run & Trace with Docker Compose: a container ended by **■ Stop** or the time limit shown as stopped, not as a failure with exit code 143 (`SIGTERM` of `docker stop`; also 130 and 137)
- Run & Trace (C/C++): no lost trace lines when a busy thread's buffer fills up in the middle of a call
- Timeline: speed list readable in every theme (the open list used the theme's text colour on the system's background, only the chosen speed visible)

## 0.5.11

### Added
- Class details: *Where members are read and written* — number of functions reading and writing each member
  - Chains through member types and base classes (`cfg.link.peer.port`, `p->len = 0`, `self.port`, a bare `port_` in a method)
  - Opened: those lines listed, the functions lit up in the circuit (blue reads, orange writes)
- Python: `self.cfg = cfg` gives the member the type of the parameter (or local)
- Timeline: swimlanes dragged sideways to move the view, Shift + wheel as well (down: earlier, up: later)
  - Playhead and time axis: drag to scrub, click to jump, as before

### Changed
- No jumps when opening or closing a block or changing the level or focus
  - Clicked block in place; other blocks sliding and resizing to their new places
  - Opening items growing out of their block, closing items folding into it
  - Wires fading in once everything has arrived
  - Off under the system's reduced-motion setting
- While playing: no jump back to the playhead after moving the view; play or a click to follow again

### Fixed
- Class details (Python): types looked up through the file's imports, same-named classes in different modules kept apart
  - `from .models import Config`, `from .legacy import Config as LegacyConfig`, `import legacy as old` → `old.Config`, imports under `if TYPE_CHECKING:`, `Optional[Config]`, `Config | None`, `"Config"`
- Class details (C/C++): a struct defined with the same name in two files resolved to the one of the file writing the type (or a header it includes)
  - `typedef struct buffer buffer_t;`, `typedef Packet Datagram;`, `using Frame = Packet;`: the class even when defined in another file
- *Where it returns*: only the function's own `return` statements, none from a lambda or local class inside it
  - Example: a `void` function holding `[] { return g(); }` → no return
- A `return` over several lines or in a one-line block (`if (ok) { return g(a, b); }`): shown whole, from `return` to its own `;`

## 0.5.10

### Added
- Open VSX release: installable from the extension view of Cursor, VSCodium, Windsurf and Theia

## 0.5.9

### Changed
- Reworded 0.5.8 notes

## 0.5.8

### Added
- Class details: under each class holding it as a member, where that class goes on to (classes holding it, functions taking it)
  - Example: a chain like `Address` → `Customer.address` → `Order.customer`, followed upwards

### Fixed
- *Held as a member by*, *Taken as a parameter by*, *Returned by*: partly qualified types (`billing::Customer` inside `shop`)
  - Names looked up from the scope they are written in → same-named classes in different namespaces (`billing::Address`, `shipping::Address`) kept apart

## 0.5.7

### Added
- Python classes: every `self.x = …` attribute listed as a member, typed when the value or annotation tells
- C: `typedef struct ringbuf {…} ringbuf_t;` name counted as the struct → functions taking `ringbuf_t*` under *Taken as a parameter by*

### Fixed
- C/C++ members: declared type kept (`int* data`, `char name[16]`; the `*`, `&` and `[N]` were dropped)

## 0.5.6

### Added
- `↻N` on a block (calls staying inside it): click for the details panel with those calls and their code
- `+N` on a closed block: click to open it
- Signature box: the language's own syntax (`int lookup(uint32_t dst)`, `def f(x: int) -> str`) in theme colours, a class's member list as well

### Changed
- Collapse button of an open block: larger square with a light shade
- No tooltip over an open block's empty area, header buttons or badges

### Fixed
- Code snippet at an `#include` line no longer running on to the next `;`

## 0.5.5

### Added
- **A header holds its source** (Files grouping, C/C++): `router.cpp` inside `router.h`
  - Header declarations at the header level (where callers' wires arrive) / source-only items inside the source
  - Off: `codeGraph.headerWrapsSource`
- Function details: every `return` statement and the whole statement of each call in and out, as code
- Class details: members, base and derived classes, where objects are created, where they live (members of other classes, parameters, return values)

### Changed
- Wire labels placed clear of blocks and titles; a small `⋯` on wires too short for a label

### Fixed
- Parameter and return types no longer cut at 40/32 characters

## 0.5.4

### Fixed
- Tooltip no longer growing while the pointer trembles over a block near the edge of the view
  - Fixed where it first appeared; left of or above the pointer when there is no room

## 0.5.3

### Changed
- Source preview in about a quarter of a second
  - Grammars loaded when the view opens; plain lines first if a hover comes earlier

### Fixed
- Coloured preview in WSL, SSH and container windows (Dark+ / Light+ when the theme's files are on the other machine)
- Renamed built-in themes recognised
- Theme in use reported in the *CodeGraph* output

## 0.5.2

### Changed
- More search keywords: codegraph, visualizer, code map, graph view, diagram, call hierarchy…

## 0.5.1

### Added
- Block hover: source preview (comment above, header, first lines) in theme colours / wire hover: the line of the call
- `Ctrl`+click (`⌘`+click) or `F12`: a block's definition or a wire's call site

### Changed
- Wire labels and replay values cut at 32 characters (addresses keep both ends), the rest in the tooltip

## 0.5.0

- **Live**: Run & Trace and Run & Trace with Docker Compose following the program while it runs
  - Each thread lit where it is now, calls flowing along the wires, busy functions with their recent call counts
  - Every container followed live, in its own colours
- No time limit on runs: until the program ends or **■ Stop** in the live bar (or *CodeGraph: Stop Run and Show the Trace*)
  - Stop keeps everything recorded, the replay follows
  - `run.timeoutSeconds` for a limit
- A container kept from an earlier run no longer linking a tracer runtime from an older CodeGraph version

## 0.4.1

- **A view per container**: after a Compose run (or several trace files loaded at once), one circuit per container side by side
  - Each with only what ran in that container, all playing on one clock
- Run & Trace: the link's library folders on the library path, so a library found there loads its dependencies from there too
  - Fix for `error while loading shared libraries: libboost_container…` with `-Wl,-rpath` (written as RUNPATH by most distributions)
  - In containers: the compiler wrapper writes `-rpath` as RPATH for the same reason
- A program failing here in a workspace with a compose file: a button to run the Compose project instead

## 0.4.0

**Traces your setup as it is**
- Docker Compose: every service whose container has your sources traced
  - Mounted (`- ./:/app`) or copied by its Dockerfile (`COPY`, multi-stage builds, `RUN --mount=type=bind`)
  - Such images rebuilt from the traced copy with compiler wrappers added right before the first copy, layers above kept cached
  - Services without your code (databases, proxies) run as they are
- Traced containers: every C/C++ compiler on `PATH` wrapped (`g++-12`, `clang++-17`, cross compilers, `CC`/`CXX` by full path, `ccache` in front)
- Python traced however it starts: by name, full path, through gunicorn, as a multiprocessing child; a forked process with a trace of its own
- Several compose files, the override file and profiles; trace files named `<host>-<pid>` so replicas do not collide

**`.codegraph.json` for unusual setups**
- One file at the workspace root for what CodeGraph cannot find out by itself
  - Build script (`run.build` + `run.program`, run in a traced copy with every compiler wrapped), the program, its arguments and folder
  - Compose files and profiles, services to trace, a build to run in a container first (`compose.build`), the code's path in a container (`compose.sourcePath`)
- Run not possible to set up: what is missing, with an offer to create the file
- **CodeGraph: Create / Open .codegraph.json**: a starter file with what was detected
- Completion and explanations for every key in the editor; the file read by the CLI too

**Fixes**
- Python scripts in containers: interpreter wrapper argument order
- A CMake build folder copied into the traced copy no longer building back into the workspace

**Docs**
- README reduced to usage, examples and GIFs; the rest in [docs/GUIDE.md](docs/GUIDE.md)

## 0.3.0

**Run & Trace builds your program the way your project does**
- Makefiles (`make -n` dry run) and CMake (`compile_commands.json` + link files): each program's sources, defines, include and library flags, and run directory
  - `-DNODE_A`, `-lssl -lcrypto -lboost_json` and relative paths like `../../cfg` working as is
  - One `main.cpp` in several programs: a choice (or `codeGraph.run.target`)
  - Compile check with the same flags
- Link missing symbols: retry with the libraries that usually provide them (OpenSSL, Boost.JSON, libm, …, `-L` for libraries under `/opt`)
- Failed link: a few lines on `main` instead of hundreds of linker messages

**Run & Trace with Docker Compose**
- The workspace's compose project run with its images, network and healthchecks
  - Services mounting the workspace build a traced copy inside their containers (compiler shims on `PATH`, no project changes)
  - Every container's threads merged into one timeline on a common clock; run summary with how each container ended
  - In the CodeGraph panel, the command palette and the CLI (`trace --compose`)
- `samples/net-pair`: a client and a server on their own Compose network

**Other**
- Stop at the time limit no longer shown as a failure
- Traces record their clock, process id and program name; `{pid}` in `CODE_GRAPH_TRACE` for one file per process

## 0.2.1

- CodeGraph icon in the activity bar: a panel with a button per step (open the circuit, show the current file, compile check, Run & Trace, load a trace) and a short guide; re-analyze from its title bar
- Published on the VS Code Marketplace as `21HoKim.code-graph-vscode`

## 0.2.0

**Compile check — only what is broken turns red**
- Real toolchain check: `gcc`/`clang -fsyntax-only` per translation unit (`compile_commands.json` aware), Python `compile()` + pyflakes undefined names
  - On open and on save (affected units only), or manually
- Static problems without a compiler: parse errors, declared-but-undefined functions, called `NotImplementedError` stubs, undefined Python names, missing relative imports and local includes
- Impact overlay
  - Broken blocks red, dependent callers orange by distance, blocks only reachable through a break grey
  - Cut wires with a break mark where the current sparks out
  - Problems panel with impact paths
- Optional language-server errors, off in untrusted workspaces; CLI `--verify` (exit code 2 on errors)

**Run & Trace — threads, data and crashes**
- Python tracer (`sys.monitoring` / `sys.setprofile`) and C/C++ source instrumentation with a small runtime
  - Per-thread calls, argument (and Python return) values, object identities, uncaught exceptions, crash stacks
- Build of the translation units `main` needs; build, link and runtime failures in red
- Replay
  - Thread swimlanes with play / scrub / step, glowing call stacks, thread-coloured pulses, values riding into blocks
  - Unexecuted code faded, runtime-only wires, solo a thread
  - Run summary with the thread tree and objects shared between threads, data trail for any object
- CLI `trace`: a replayable trace; `Load Trace File…` to open it

**Other**
- Abstraction levels per language: Namespace only with C++, File → Function for C, Package → Module → Class → Function for Python
- Broken C++/Python samples; C++ router sample with real payloads and loopback traffic

## 0.1.0

- First release: static circuit view for C, C++ and Python
- Five abstraction levels, files/symbols grouping, circuit/network layouts
- Electric flow animation (arguments forward, return values backward)
- Static thread-spawn detection (std::thread, std::async, pthread_create, threading, executors, asyncio)
- Confidence levels for every link; search, focus, follow-cursor, incremental re-analysis, CLI
