# Architecture

- Three parts
  - **Extension host**: Node, inside VS Code
  - **Core**: no VS Code dependency (the same code in the CLI and the tests)
  - **Webview**: the circuit drawing
- **Runtime** tracers: inside the user's program during Run & Trace

**Extension host** (`src/extension.ts`, `src/host/`)

| file | role |
| --- | --- |
| `extension.ts` | commands, activity bar panel (welcome buttons from `package.json`), file watcher, cursor follow, status bar |
| `host/service.ts` | file discovery, analysis and compile check runs, latest results |
| `host/panel.ts` | webview panel: content security policy, messages, verify on open and on save |
| `host/run.ts` | Run & Trace: entry point choice, check, build, run, trace sent to the view |

**Core** (`src/core/`)

| file | role |
| --- | --- |
| `pool.ts`, `parseWorker.ts` | file parsing on worker threads |
| `extract/` | tree-sitter (WebAssembly) syntax trees → per-file facts (`cpp.ts` for C and C++, `python.ts`); `cppnames.ts`: meaning of a C/C++ name, table of library names |
| `link.ts` | facts of all files → one `CodeGraph`, plus problems found without a compiler |
| `analyze.ts` | file walk, `compile_commands.json`, cache by modification time |
| `verify.ts` | compile check with `gcc`/`clang -fsyntax-only` and Python `compile()` |
| `health.ts` | diagnostics → broken / affected / unpowered blocks, cut wires |
| `instrument.ts` | copies of C/C++ sources with one probe per function body |
| `buildinfo.ts` | the project's programs from `make -nBwk` / CMake link files; libraries behind undefined symbols |
| `runner.ts` | build (C/C++) or start (Python) of the program with a tracer, result collection |
| `compose.ts` | Run & Trace with Docker Compose: services to trace, override file, trace collection |
| `dockerfile.ts` | where a Dockerfile copies and builds workspace files; the traced Dockerfile |
| `shims.ts`, `mirror.ts` | the `/codegraph` folder (compiler and Python shims, entrypoint, runtime); the traced copy |
| `config.ts` | `.codegraph.json`: JSON with comments, merged over the VS Code settings |
| `trace.ts` | trace format and parser → `RunTrace` (calls per thread, values, shared objects); process merge |
| `model.ts` | shared types |

**Runtime** (`runtime/`)
- `python/cg_tracer.py`: standard library only
- `python/sitecustomize.py`: tracer start in every Python process of a traced container
- `c/cg_trace.h` + `c/cg_trace.c`: C99 and pthreads
- `c/cg_trace_cxx.cpp`: uncaught C++ exceptions

**Webview** (`src/webview/`)

| file | role |
| --- | --- |
| `projection.ts` | containment tree (files or symbols) + level → visible blocks and merged wires |
| `layout.ts` | ELK layered layout in a web worker |
| `overlay.ts` | problems → red / orange / grey blocks and cut wires |
| `traceview.ts` | trace → what ran in the current view, time queries, data trails |
| `timeline.ts` | thread swimlanes: scrub, play, step |
| `livelanes.ts` | swimlanes of a live run from the sampled stacks; following now until moved |
| `procbar.ts` | container cards (live and replay), shown containers |
| `render.ts` | SVG zones, blocks, wires, labels and live glows |
| `transition.ts` | open / close / level change without a jump: blocks sliding and resizing from their old boxes (FLIP) |
| `flow.ts` | canvas layer: moving charges, replay pulses |
| `viewport.ts` | pan, zoom, pinch, tap |
| `wheel.ts` | wheel and trackpad rules shared by the circuit and the timeline (Shift + wheel, Ctrl + wheel, sideways scrolls) |
| `usage.ts` | type names → classes (scopes, imports, includes): where a class's objects live |
| `members.ts` | where each member of a class is read and written, from the functions' member chains |
| `main.ts` | state, toolbar, details / problems / run panels, replay loop |

**Opening the view**

1. `host/service.ts`: source file list, parsing on worker threads (`extract/`)
2. `link.ts`: names resolved across files → `CodeGraph`, posted to the webview by the panel
3. Compile check (`verify.ts`) in the background → diagnostics posted; impact computed in the webview (`health.ts`), repaint
4. Run & Trace (`host/run.ts` → `runner.ts`) → `RunTrace` posted, replayed by the webview on the same graph

## 1. Extraction (per file)

- `extract/*`: walk of a tree-sitter syntax tree, recording **what is written**, no resolution
- `RawEntity`
  - Namespaces: implicit in `scope`
  - Classes: with bases and field types
  - Functions: params, return type, flags, `qualifier` for out-of-line definitions (`void Router::start()`), `rets` (lines of the function's own `return` statements, via `ownReturns` in `extract/common.ts`)
- `RawCall`
  - Call *form*: `plain`, `qualified`, `member`, `super`, `new`
  - Receiver path; receiver type when locally inferable (parameters, `auto x = new T`, `T x(…)`, `make_unique<T>`, `x = Foo()`, `with Foo() as x`, `for (auto& x : container)`)
  - Argument texts
  - *Spawn* flag (a function reference handed to a thread/task API) or *instantiation* flag
- `MemberUse` per function (`uses`)
  - Member chains read or written by the body (`cfg.link.peer.port`, `p->len = 0`, `this->x`, a bare member name in a method, `self.x`)
  - Base type when a typed parameter or local
  - Each step's class worked out in the view (`members.ts`) from member types — nothing resolved here
- `#include` / `import` statements
- C/C++ `typedef` / `using` names for a class (`typedef struct buffer buffer_t;`) → aliases of that class in the linker (same file first, then included files, then files including it)

**Names as the compiler sees them** (`extract/cppnames.ts`)
- Per scope (file, namespace, class body, function, block): the `using namespace X;`, `using X::y;`, `namespace A = B::C;`, `using T = X;` / `typedef X T;` passed so far
- `CppNames`: meaning of a written name
  - `thread` after `using namespace std;` or `using std::thread;` → `std::thread`
  - `io::post` after `namespace io = boost::asio;` → `boost::asio::post`
  - `Worker` after `using Worker = std::thread;` → `std::thread`
- Library names: full names looked up in **one table**, `CPP_LIBRARY`
  - Thread types, task functions, C thread functions with the argument position of the function, `make_unique` & co., `bind`, wrapper and container types
  - New library API: a new row in that table
- A name declared by the file itself: the file's own, not the library's
- Bare `thread` / `async` the file never brings in: recorded with `assumed`
  - Kept when an included header has `using namespace std;`
  - Dropped when the workspace defines that name
  - Otherwise a guess
- Workspace names: namespace aliases and `using` type names resolved in the extractor
- `using ns::f;`, `using namespace` inside a function: carried with the call as `usingNames`, tried by the linker right after the class's own methods

**Forms read as C++ reads them**
- `std::thread t(worker);`, `Router r(cfg);`: function declarations in the grammar, variables built from `worker` / `cfg` inside a function (other types: only when every argument is a variable in reach)
- `T t{…}`: a construction too
- Thread members started in a constructor's initializer list: confirmed by the member's declared type
- Default member initializer (`std::thread tx_{&Pool::txLoop, this};`): recorded for the class, run by its constructors

**Python**: same approach through imports — an API recognised under its imported name (`from threading import Thread as T`, `import asyncio as aio`)

**Caching and workers**
- Facts local to one file → cache by `mtime + size`, one file re-extracted on save
- Extraction in `worker_threads` (`pool.ts`), one tree-sitter instance per worker
- `.h` files: C++ grammar when they contain C++-only syntax, C grammar otherwise

**Inputs for the static problem checks**
- Unreadable parts (outermost tree-sitter `ERROR` / `MISSING` nodes)
- Python: names bound per file, wildcard imports, `if __name__ == "__main__"` guards

## 2. Linking (whole workspace)

- `link.ts`: entities built, relations resolved
- Identity rules

| entity | id |
| --- | --- |
| C/C++ namespace | `cc:ns:<qname>` (anonymous namespaces file-local: `…@<file>`) |
| C/C++ class | `cc:<qname>` (split per file when several files define the same name) |
| C/C++ function | `cc:<qname>`; overloads `cc:<qname>(<param types>)`; `static`/anonymous → `…@<file>` |
| Python module / package | `py:mod:<path>` / `py:pkg:<dir>` |
| Python class / function | `py:<path>:<local qname>` |

- C and C++ share the `cc:` space → `extern "C"` declarations in a header and definitions in a `.c` file merged into one entity
- Header declarations and out-of-line definitions merged by qualified name and parameter types (fallback: arity)
- Resolution order for a call (C++; Python analogous with LEGB scopes, imports, re-exports through `__init__.py`, `self`/`cls`, `super()`)
  1. Methods of the enclosing class and its bases (`plain` calls)
  2. Enclosing namespace chain, inner to outer (+ anonymous namespaces of the same file)
  3. `using namespace` directives of the file and of the headers it includes (directly or not)
  4. Receiver type → class → methods of the class and its bases (`member` calls; field types, container element types, `this->x`)
  5. Qualified names relative to the namespace chain, or `Class::method`
  6. Unique name in the workspace → **likely**; several candidates → nearest by file (same file, header/source pair, included, same directory) → **guess**
- No guesses for calls into `std::`/`boost::` or methods of known non-workspace types
- Common container/stdlib method names (`push_back`, `append`, `get`, …): never matched by name alone
- Type names in members, parameters and return types (class panel's *where its objects live*): same lookup in `webview/usage.ts`
  - Python: through the file's imports (`FileInfo.names`, filled by the linker: `from .models import Config as Settings`, `import legacy as old` → `old.Config`)
  - C/C++: from the writing scope outwards
  - Several classes still sharing the name: the writing file first, then a file it includes, then a file including it
- Spawns via containers (`workers_.emplace_back(&Router::txLoop, this)`): confirmed against the field's declared type (`std::vector<std::thread>`), dropped when the field is known not to hold threads

## 3. Projection (abstraction levels)

- Containment tree built in the webview
  - **files**: `dir / file / namespace / class / function`
    - Entity placed in the file of its *definition*; logical ancestors as per-file fragments (`router.cpp | net | Router | start`)
    - Class fragment outside the class's own file: flagged `fragment` (dashed)
  - **symbols**: `namespace / class / function`, merged across files (C/C++ globals in `(global)`)
- Levels per language present
  - *Namespace*: only with C++
  - C: functions grouped by file
  - Python-only workspace: folders and files as *packages* and *modules* (folders with `__init__.py`)
- Single-child chains of folders or namespaces compacted (`include/net`, `net::core`)
- Container or block at level *L*
  - **Container**: rank below *L*, or rank *L* with nodes of the same kind inside (nested folders, namespaces, classes)
  - **Block**: otherwise
  - User override per node (double-click), stored as `expand`/`collapse` sets
- Wires
  - Every relation endpoint mapped to its nearest visible ancestor (`rep`)
  - Both endpoints in the same block → the block's *internal* count (↻ badge)
  - Parallel relations of the same kind between two blocks → one wire with `count`, best confidence, the underlying relations (details panel)
  - `#include` / `import` wires: between blocks only, not containers
- *Focus*: k-hop neighbourhood of a node plus ancestors; *hide guesses*: confidence filter before lifting

## 4. Layout and rendering

- ELK `layered` with `hierarchyHandling: INCLUDE_CHILDREN`
  - Wires routed across nesting levels, edges in their lowest common container
  - Coordinates in root space (`json.shapeCoords/edgeCoords: ROOT`)
- Full routing limit: ≤ 140 wires and ≤ 160 blocks
  - Beyond: sprawl (blocks ≈ 2 % of the drawing), cost explosion (Redis at file level, 908 blocks / 4,893 wires: 32 s)
- **Compact layout** for larger views (3–5× denser, "compact wiring" in the status bar)
  - Each container laid out on its own (`SEPARATE_CHILDREN`, low thoroughness, Brandes-Köpf placement)
  - Containers with more than 60 children packed (`rectpacking`)
  - Wires as one-bend elbows between block borders (0.7 s for the same view)
  - Above 6,000 blocks: refused, with a hint to focus or pick a coarser level
- Styles
  - Circuit: orthogonal routing (RIGHT on wide screens, DOWN on tall ones)
  - Network: polylines drawn as Catmull-Rom curves
  - Hierarchical layout failure: per-container layout with straight wires
- ELK in a web worker created from a blob (no workers from resource URLs in VS Code webviews)
- SVG
  - Generated as strings, swapped in at once
  - Rearrangement of the same picture (block opened or closed, another level, focus): clicked block kept in place on screen, swap animated by `transition.ts`
    - Staying blocks and containers: moved and resized from their old boxes
    - New ones: grown out of their ancestor's old box, faded in
    - Vanishing ones: folded into their ancestor's new box
    - Wires: faded in at the end
    - No animation under `prefers-reduced-motion`
  - Invisible wide twin per wire for hovering
  - Zoomed-out views: secondary text dropped (level of detail)
- Flow layer: one `<canvas>` above the SVG (pointer-events: none)
  - Each wire sampled into a polyline with cumulative lengths
  - Particles: pre-rendered radial-gradient sprites, `drawImage` in additive mode
  - Global particle budget scaling the spacing, off-screen wires culled, loop stopped while the document is hidden
  - `FlowLayer.pulse(edgeId, colour)`: single charges — the hook for trace replay

## 5. Problems: compile check and impact

- Diagnostic sources (`Diagnostic {file, line, severity, source, message, target?}`)

| source | from |
| --- | --- |
| `syntax` | tree-sitter parse failure (file level, coarse; dropped once a compiler/interpreter checked the file) |
| `incomplete` | called C/C++ functions declared but never defined; called, non-overridden `raise NotImplementedError` stubs |
| `python` | undefined names on unresolved calls, missing relative imports; `compile()` + pyflakes results |
| `compiler` | `gcc`/`clang -fsyntax-only` per translation unit (`verify.ts`), or the instrumented build |
| `linker` | undefined references from the Run & Trace link, mapped back to the declaration |
| `runtime` | uncaught exceptions, crashes (from a trace) |
| `editor` | optional: errors from VS Code language servers |

- `verify.ts`
  - Units in parallel (≤ 8)
  - `compile_commands.json` entries reused (without `-o`, `-c`, `-M*`)
  - Results kept per unit → on save, only the units including the saved file (reverse `#include` closure)
  - Never in an untrusted workspace (a compile database can name any command)
- `health.ts`
  - Each diagnostic attached to the innermost entity whose definition contains its line (whole-file errors such as a `SyntaxError`: the file)
  - **broken**: entities with errors (plus everything in a file that does not parse)
  - **affected**: reverse BFS over dependency relations (call, spawn, instantiate, inherit, include, import) — callers of something broken, with distance and the path back to the cause
  - **unpowered**: functions unreachable from the entry points (`main`, `__main__` guards) once broken blocks stop the current
  - **cut** wires: into a broken block; **dead** wires: no current
- `overlay.ts`: lift to the projection — only the broken block itself red, counts on containers

## 6. Run & Trace

**Trace format** (`code-graph-trace/1`, JSON lines, written by both runtimes)

```jsonc
{"k":"h","schema":"code-graph-trace/1","lang":"cpp","clock":"ns","pid":4242,"mono":…,"wall":…,"exe":"node-b"}
{"k":"t","id":2,"t":120934,"parent":1,"by":4,"name":"thread-2"}      // thread first seen: started by thread 1 in fid 4
["c",121003,2,7,"0x7ffd…",[["pkt","o","0x7ffd…","0x7ffd…"]]]       // call: t, thread, fid, this, args
["r",121550,2,7]                                                      // return (Python: + value)
["x",130002,3,9,"SIGSEGV","segmentation fault …",0]                  // exception / crash in fid
{"k":"stack","th":3,"fids":[0,4,9]}                                   // every thread's stack at a crash
{"k":"agg","calls":[[7,99],…]}                                        // complete counts past the event cap
```

- Values: `[kind, repr, identity?, size?]`, kinds `i d b s n c o` (int, float, bool, string, null, container with size, object/pointer)
- Identities (`id()` in Python, addresses in C/C++, `this`/`self`): the basis of data tracking

**Python** (`runtime/python/cg_tracer.py`, stdlib only)
- Script run with `runpy`
- `sys.monitoring` callbacks for `PY_START/RESUME/RETURN/YIELD/UNWIND/THROW` (3.12+; `sys.setprofile` before)
- Code outside the workspace: `DISABLE` on its first event → almost no cost for libraries afterwards
- `threading.Thread.start` / `_bootstrap_inner` wrapped: thread names, parents, the workspace function calling `start()`
- `threading.excepthook`: uncaught errors in threads
- Function ids → entities by file + definition line, then qualname, then the enclosing function (generator expressions, lambdas)

**C/C++** (`instrument.ts` + `runtime/c`)
- Sources and headers copied byte-exact (latin1) into the extension's storage
- One statement after each function body's `{`, on the same line:

```cpp
int Router::route(const Packet& pkt) { ::cgt::scope cgt_s_(12u, this); ::cgt::arg("pkt", pkt, 1); …
```

- C: `__attribute__((cleanup))` for the exit event; headers included by C files keep the C form
- Skipped: constexpr functions, coroutines, function-try-blocks
- `cg_trace.h` force-included (`-include`), no added `#include`
- `cgt::arg`: value classification with templates — numbers and strings by value, containers by size, references, pointers and `this` by address
- Runtime (`cg_trace.c`)
  - Buffer and shadow stack per thread
  - Whole lines appended to the trace under one mutex (a full buffer keeps the line being written)
  - On `SIGSEGV`/`SIGABRT`/…: every thread's stack written before re-raising
- `cg_trace_cxx.cpp`: type and `what()` of an uncaught exception
- `pthread_create` defined by the runtime
  - Weak, exported with `--dynamic-list`, real one via `dlsym(RTLD_NEXT)` (`-ldl` on Linux)
  - The program's own calls and those of loaded libraries (`std::thread`, `std::async` in libstdc++) → thread start through a trampoline
  - glibc's C11 `thrd_create` (not through `pthread_create`): a trampoline of its own
  - Trampoline: starting thread and the function on top of its shadow stack → the new thread's record
  - Without `CODE_GRAPH_TRACE`: straight pass-through
  - Static programs (no lookup of the real function): runtime built with `-DCGT_NO_INTERPOSE`, inferred parents (see Model)

**Building it like the project does** (`buildinfo.ts`)
- Makefile: dry run with `make -nBwk` (every command of the default goal, with "Entering directory" lines)
- CMake: `compile_commands.json` plus `CMakeFiles/<target>.dir/link.txt`
- Compiler, `ar` and link commands grouped into programs: an executable link with the compile commands of its objects, archives and shared libraries the project builds itself
- Per program: per-source compile flags (`-D`, `-I`, `-std` …), link flags (`-L`, `-l`, `-Wl,…`, `-pthread`), link directory (where `make run` would start it)
- Compile check: the same flags when there is no `compile_commands.json`

**Build and run** (`runner.ts`)
- Sources: the program's sources when the entry file belongs to one (user's choice when several do)
- Otherwise: the translation units `main` needs
  - File-level closure over call / spawn / instantiate / inherit relations, methods of used classes
  - Units with another `main` excluded
  - `compile_commands.json` flags when present
- Instrumented copy failing to compile: unit rebuilt untouched (not traced)
- Link retries
  - Workspace units defining the missing symbols
  - Then the libraries that usually provide them (`guessLibraries`: OpenSSL, Boost, libm, … with `-L` for e.g. `/opt/boost-1.87/lib` when found)
  - Still missing: one line on `main`
- Compile check before any build
- Run with the link's library folders (`-L`, every spelling of `-rpath`) on `LD_LIBRARY_PATH` (`DYLD_LIBRARY_PATH` on macOS)
  - Reason: `-rpath` as RUNPATH on most distributions, unused by the loader for libraries a library loads (Boost.JSON → Boost.Container)
  - Same reason: `--disable-new-dtags` added by the compiler shim to program links with an `-rpath`

**Project settings** (`config.ts`)
- `.codegraph.json` at the workspace root (JSON with comments), `run` and `compose` sections
- A key there over the matching VS Code setting → same values in the host (`host/project.ts`) and the CLI
- Run impossible to set up (no entry point, unreadable build, service without visibility): offer to create the file
- Starter: every key commented out, detected values (entry points, programs, compose files, services) as examples
- `schemas/codegraph.schema.json`: completion and hovers in the editor

**A build CodeGraph does not read** (`run.build` + `run.program`)
- Command run in a traced copy of the workspace (CMake-generated files dropped → fresh configure), same compiler shims as in containers
- Program started from the copy

**Docker Compose** (`compose.ts`)
- `docker compose config --format json`: the resolved project (all files, profiles, override file)
- Traced service: container with some of the workspace's C, C++ or Python sources, found three ways

| how | detected from | traced as |
| --- | --- | --- |
| mounted | a bind mount of the workspace or a folder in it | traced copy mounted at the same target |
| copied in | `build.context` in the workspace and a Dockerfile `COPY`/`ADD`ing (or `RUN --mount=type=bind`ing) sources | image rebuilt from the copy: in each stage `RUN`ning after seeing the sources, `COPY --from=codegraph_trace / /codegraph/`, the shim setup and `PATH` right before the first instruction that sees them (an `additional_contexts` entry); layers above kept cached |
| configured | `compose.sourcePath` / `compose.build` in `.codegraph.json` | copy mounted there / a command run before the service's own |

- Services without workspace sources (databases, proxies): run as they are
- Workspace copy (without `.git`, `node_modules`, CMake caches), probes in its C/C++ files
- Override file (JSON, read by Compose as YAML) per traced service

| key | value |
| --- | --- |
| `volumes` | copy at the workspace's mount targets (volumes merged by target), `/codegraph` |
| `image` / `build` | images built from the workspace: `codegraph-trace/<project>-<service>`, built from the copy with the traced Dockerfile |
| `entrypoint` / `command` | `/codegraph/bin/cg-run` + the service's own entrypoint and command (from the image when the compose file has none) |
| `environment` | `CODE_GRAPH_TRACE=/codegraph/trace/<service>/{host}-{pid}.jsonl`, Python roots, event cap, values |

- `cg-run`: `umask 0` (host able to delete what a root container builds), then `cg-setup`
- `cg-setup`
  - Every C/C++ compiler and Python interpreter on `PATH` (`gcc`, `g++-12`, `clang++-17`, `aarch64-linux-gnu-gcc`, `python3.12` …; not `ar`, `ccache` or `*-config`) linked to a shim in `/tmp/codegraph-bin`, first on `PATH`
  - `CC` / `CXX` by full path: wrapped too
- Compiler shim
  - Real compiler found further down `PATH` (shim folders removed → no loop through `ccache` or masquerading wrappers)
  - `-include /codegraph/rt/cg_trace.h` on every compile
  - Program link: runtime compiled once per container and appended (`-Wl,--dynamic-list` exports `cgt_*`)
- Python
  - Shim: scripts under a source root started under the tracer
  - `PYTHONPATH` with `/codegraph/rt/py`, whose `sitecustomize` starts the tracer in every other Python process (full path, gunicorn, multiprocessing children)
  - Trace file created only once workspace code runs; own file for a forked child
- Run
  - `up`; time limit counted from the first trace file
  - Every traced container exited or limit reached → project stopped (runtime exits on `SIGTERM` even as PID 1) and taken down
- Service ended without a traced program: note with what to write in `.codegraph.json` (nothing compiled, no workspace Python ran); log parsed for compiler errors, container paths mapped back to the workspace

**Live** (`live.ts`)
- `CODE_GRAPH_LIVE=1`: a `live` record every 200 ms from the runtimes
  - Each thread's call stack (C: the flusher thread reading the shadow stacks; Python: the tracer's own)
  - Cumulative call counts, caller → callee counts (C: lock-free table in live mode)
- `LiveTail`
  - Trace files followed (C/C++: only the newly added tail, the latest record enough; Python: full read for function records)
  - Functions mapped to entities
  - Every 250 ms: threads, stacks, calls since the previous update
  - Several processes: calls tagged with their process; per process its calls, calls since the previous update, threads, end state
  - `liveForProc`: one process cut out for a view per container, fed by the host during the run
- Webview: stacks lit, those calls pulsed, busy functions labelled
- No time limit by default; Stop ends the run (`finish`, unlike `signal`, keeps the trace), replay follows

**Several processes** (`mergeTraces`)
- Each trace header: monotonic and wall clock at its time 0 (host clock shared by containers) → spans shifted onto one clock, re-sorted
- Threads renumbered across processes, named `<service> · <thread>`
- Object identities prefixed with the process name (same address in two processes ≠ one object)
- `procs`: each process's threads and exit
- Stop by `SIGTERM` / `SIGINT` (time limit, `docker stop`): open spans ended, no failure
- `processTrace`: one process cut back out for a view per container
  - Its threads, spans, values, exceptions, call counts from its edges
  - Merged duration kept → one shared time axis
  - Play, pause, seek and speed relayed through the host → joint replay

**Model** (`RunTrace`)
- Calls → spans per thread (`t`, `end`, `parent`, `depth`) as parallel arrays
- Thread `parent` and `by` (the starting function): from the thread record
- Start unseen by the runtime (static C/C++ programs, older traces): parent inferred from the static spawn relation running in another thread at the thread's start
- Unnamed threads: named after their entry function (`rxLoop`, `txLoop #2`)
- Objects seen by several functions or threads: labelled with what the graph knows (class of `this`, declared parameter type)

**Viewer**
- `augmentGraph`: relations for calls and thread starts only the run revealed (`via: 'runtime'`: a callback, a thread started through a function pointer)
- `RuntimeMap`: call counts and threads lifted onto the visible blocks and wires
- `TraceModel`: time queries with binary searches (calls started / ended in a window, every thread's active stack at *t*, every sighting of an object)
- Replay: program time advanced by `duration / 15 s × speed` per frame, `FlowLayer.pulse` along the projected wire of each call

## 7. Adding a language

1. Grammar `.wasm` in `scripts/build.mjs` and `extract/index.ts` (`loadParsers`, `languageOf`)
2. `extract/<lang>.ts` producing `RawEntity` / `RawCall` / imports
3. The language's scoping and import rules in `link.ts` (or reuse of the C++ or Python path)
4. `examples/<language>/features/` with the same feature folders as the other languages (each with its README checklist), checks in `test/examples.test.ts`

- Rules shared by every extractor (same behaviour in every language)
  - A call anywhere in a function body, a `return` included: a call of that function
    - `return g();`, `return ok ? g() : h();`, `return a().b();`, the language's own forms (`return await g()`, `yield from g()`, `co_return g();`)
    - Calls inside a lambda: counted for the function writing the lambda
  - A function's `rets`: its own only
    - `ownReturns` given the language's return statements and the nodes starting another function (lambdas, nested functions, local classes)
    - No `return`: `[]`
    - A block for the new language in the test *return statements (every language)* in `test/analyzer.test.ts`
  - Library APIs (threads, tasks, object creation): recognised by meaning, not spelling
    - Through the language's imports, `use` / `using` declarations and aliases (`CppNames` for C/C++, import names in `python.ts`)
    - A block for the new language in the test *threads started through every spelling of the API (every language)*
