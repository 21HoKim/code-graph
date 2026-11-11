# Architecture

CodeGraph has three parts: the **extension host** (Node, inside VS Code), a **core** that has no VS Code
dependency (the same code runs in the CLI and the tests), and the **webview** that draws the circuit. The
**runtime** tracers run inside the user's program during Run & Trace.

**Extension host** (`src/extension.ts`, `src/host/`)

| file | role |
| --- | --- |
| `extension.ts` | commands, activity bar panel (welcome buttons from `package.json`), file watcher, cursor follow, status bar |
| `host/service.ts` | finds files, runs the analysis and the compile check, keeps the latest results |
| `host/panel.ts` | the webview panel: content security policy, messages, verify on open and on save |
| `host/run.ts` | Run & Trace: pick the entry point, check, build, run, send the trace to the view |

**Core** (`src/core/`)

| file | role |
| --- | --- |
| `pool.ts`, `parseWorker.ts` | parse files on worker threads |
| `extract/` | tree-sitter (WebAssembly) syntax trees → per-file facts (`cpp.ts` for C and C++, `python.ts`); `cppnames.ts`: what a C/C++ name stands for, and the table of library names |
| `link.ts` | facts of all files → one `CodeGraph`, plus problems found without a compiler |
| `analyze.ts` | file walk, `compile_commands.json`, cache by modification time |
| `verify.ts` | compile check with `gcc`/`clang -fsyntax-only` and Python `compile()` |
| `health.ts` | diagnostics → broken / affected / unpowered blocks, cut wires |
| `instrument.ts` | copies C/C++ sources with one probe per function body |
| `buildinfo.ts` | the project's programs from `make -nBwk` / CMake link files; libraries behind undefined symbols |
| `runner.ts` | builds (C/C++) or starts (Python) the program with a tracer and collects the result |
| `compose.ts` | Run & Trace with Docker Compose: which services to trace, override file, collecting traces |
| `dockerfile.ts` | where a Dockerfile copies workspace files and where it builds them; the traced Dockerfile |
| `shims.ts`, `mirror.ts` | the `/codegraph` folder (compiler and Python shims, entrypoint, runtime); the traced copy |
| `config.ts` | `.codegraph.json`: JSON with comments, merged over the VS Code settings |
| `trace.ts` | trace format and parser → `RunTrace` (calls per thread, values, shared objects); merges processes |
| `model.ts` | shared types |

**Runtime** (`runtime/`): `python/cg_tracer.py` (standard library only) and `python/sitecustomize.py` (starts it in
every Python process of a traced container), `c/cg_trace.h` + `c/cg_trace.c` (C99 and pthreads) and
`c/cg_trace_cxx.cpp` (uncaught C++ exceptions).

**Webview** (`src/webview/`)

| file | role |
| --- | --- |
| `projection.ts` | containment tree (files or symbols) + level → visible blocks and merged wires |
| `layout.ts` | ELK layered layout in a web worker |
| `overlay.ts` | problems → red / orange / grey blocks and cut wires |
| `traceview.ts` | trace → what ran in the current view, time queries, data trails |
| `timeline.ts` | thread swimlanes: scrub, play, step |
| `render.ts` | SVG zones, blocks, wires, labels and live glows |
| `transition.ts` | opening / closing / changing level without a jump: blocks slide and resize from their old boxes (FLIP) |
| `flow.ts` | canvas layer: moving charges, replay pulses |
| `viewport.ts` | pan, zoom, pinch, tap |
| `usage.ts` | type names → classes (scopes, imports, includes): where a class's objects live |
| `members.ts` | where each member of a class is read and written, from the functions' member chains |
| `main.ts` | state, toolbar, details / problems / run panels, replay loop |

**What happens when the view opens**

1. `host/service.ts` lists the source files and parses them on worker threads (`extract/`).
2. `link.ts` resolves names across files and returns the `CodeGraph`; the panel posts it to the webview.
3. The compile check (`verify.ts`) runs in the background and posts its diagnostics; the webview computes the
   impact (`health.ts`) and repaints.
4. Run & Trace (`host/run.ts` → `runner.ts`) posts a `RunTrace`, which the webview replays on top of the same
   graph.

## 1. Extraction (per file)

`extract/*` walks a tree-sitter syntax tree and records **what is written**, without resolving anything:

- `RawEntity`: namespaces are implicit in `scope`; classes (with bases and field types); functions
  (params, return type, flags, `qualifier` for out-of-line definitions such as `void Router::start()`, and `rets`:
  the lines of the function's own `return` statements, found with `ownReturns` in `extract/common.ts`).
- `RawCall`: the call *form* (`plain`, `qualified`, `member`, `super`, `new`), the receiver path and, when it can
  be inferred locally, the receiver type (parameters, `auto x = new T`, `T x(…)`, `make_unique<T>`,
  `x = Foo()`, `with Foo() as x`, `for (auto& x : container)`), argument texts, and whether it is a
  *spawn* (a function reference handed to a thread/task API) or an *instantiation*.
- `MemberUse` per function (`uses`): member chains the body reads or writes (`cfg.link.peer.port`, `p->len = 0`,
  `this->x`, a bare member name in a method, `self.x`), with the base's type when it is a typed parameter or local.
  Each step's class is worked out in the view (`members.ts`) from the member types, so nothing is resolved here.
- `#include` / `import` statements, and C/C++ `typedef` / `using` names for a class (`typedef struct buffer
  buffer_t;`), which the linker turns into aliases of the class they name (same file first, then included files,
  then files including it).

**Names as the compiler sees them** (`extract/cppnames.ts`). While it walks a C/C++ file the extractor keeps, per
scope (file, namespace, class body, function, block), the `using namespace X;`, `using X::y;`, `namespace A = B::C;`
and `using T = X;` / `typedef X T;` it has passed, and asks `CppNames` what a written name stands for: `thread` after
`using namespace std;` or `using std::thread;` is `std::thread`, `io::post` after `namespace io = boost::asio;` is
`boost::asio::post`, `Worker` after `using Worker = std::thread;` is `std::thread`. Library names are recognised by
looking those full names up in **one table**, `CPP_LIBRARY` (thread types, task functions, C thread functions with
the argument that is the function, `make_unique` & co., `bind`, wrapper and container types); add a row there to teach
the extractor a new one. A name the file declares itself is its own, not the library's. A bare `thread` / `async`
the file never brings in is recorded with `assumed`: the linker keeps it when a header the file includes has
`using namespace std;`, drops it when the workspace defines that name, and marks it a guess otherwise. For workspace
names the extractor resolves namespace aliases and `using` type names itself; `using ns::f;` and a `using namespace`
inside a function travel with the call as `usingNames`, which the linker tries right after the class's own methods.

Forms that read like something else are read as C++ does: `std::thread t(worker);` and `Router r(cfg);` parse as
function declarations, but inside a function they are variables built from `worker` / `cfg` (for other types only
when every argument is a variable in reach); `T t{…}` is a construction too. Thread members started in a
constructor's initializer list are confirmed by the member's declared type; a default member initializer
(`std::thread tx_{&Pool::txLoop, this};`) is recorded for the class, whose constructors run it.

Python does the same with its imports: an API is recognised under the name it was imported as
(`from threading import Thread as T`, `import asyncio as aio`).

Because facts are local to one file they are cached by `mtime + size`; saving a file re-extracts one file.
Extraction runs in `worker_threads` (`pool.ts`), one tree-sitter instance per worker.

`.h` files are parsed with the C++ grammar if they contain C++-only syntax, otherwise with the C grammar.

Extraction also records what it cannot read (outermost tree-sitter `ERROR` / `MISSING` nodes) and, for Python,
the names bound in each file, wildcard imports and `if __name__ == "__main__"` guards — inputs for the static
problem checks below.

## 2. Linking (whole workspace)

`link.ts` builds entities and resolves relations. Identity rules:

| entity | id |
| --- | --- |
| C/C++ namespace | `cc:ns:<qname>` (anonymous namespaces are file-local: `…@<file>`) |
| C/C++ class | `cc:<qname>` (split per file if several files define the same name) |
| C/C++ function | `cc:<qname>`; overloads `cc:<qname>(<param types>)`; `static`/anonymous → `…@<file>` |
| Python module / package | `py:mod:<path>` / `py:pkg:<dir>` |
| Python class / function | `py:<path>:<local qname>` |

C and C++ share the `cc:` space so that `extern "C"` declarations in a header and their definitions in a `.c`
file merge into one entity. Header declarations and out-of-line definitions merge by qualified name and parameter
types (falling back to arity).

Resolution order for a call (C++ shown; Python is analogous with LEGB scopes, imports, re-exports through
`__init__.py`, `self`/`cls`, `super()`):

1. methods of the enclosing class and its bases (`plain` calls),
2. the enclosing namespace chain, inner to outer (+ anonymous namespaces of the same file),
3. `using namespace` directives of the file and of the headers it includes (directly or not),
4. receiver type → class → methods of the class and its bases (`member` calls; types of fields, element types
   of containers, `this->x`),
5. qualified names relative to the namespace chain, or `Class::method`,
6. unique name in the workspace → **likely**; several candidates → nearest by file (same file, header/source pair,
   included, same directory) → **guess**.

Calls into `std::`/`boost::` and to methods of known non-workspace types are not guessed. Common container/stdlib
method names (`push_back`, `append`, `get`, …) are never matched by name alone.

Type names in members, parameters and return types (the class panel's *where its objects live*) are looked up in
`webview/usage.ts` the same way: Python through the file's imports (`FileInfo.names`, filled by the linker:
`from .models import Config as Settings`, `import legacy as old` → `old.Config`), C/C++ from the scope they are
written in outwards; when several classes still share the name, the one in the writing file wins, then one in a
file it includes, then one in a file including it.

Spawns via containers (`workers_.emplace_back(&Router::txLoop, this)`) are confirmed against the field's declared
type (`std::vector<std::thread>`); if the field is known not to hold threads the link is dropped.

## 3. Projection (abstraction levels)

The webview builds a containment tree:

- **files**: `dir / file / namespace / class / function`. An entity is placed in the file of its *definition*;
  its logical ancestors become per-file fragments (`router.cpp | net | Router | start`). A class fragment in a file
  other than the class's own is flagged `fragment` (dashed).
- **symbols**: `namespace / class / function`, merged across files (C/C++ globals go into `(global)`).

Levels follow the languages present: *Namespace* exists only when there is C++, C groups functions by file, and a
Python-only workspace calls folders and files *packages* and *modules* (folders with `__init__.py`).

Single-child chains of folders or namespaces are compacted (`include/net`, `net::core`).

At level *L* a node is a **container** if its rank is below *L*, or if it has the rank of *L* and contains nodes of
the same kind (nested folders, nested namespaces, nested classes); otherwise it is a **block**. Users override per
node (double-click), stored as `expand`/`collapse` sets.

Every relation endpoint is mapped to its nearest visible ancestor (`rep`). Relations whose endpoints collapse into
the same block become the block's *internal* count (↻ badge); parallel relations between the same two blocks with
the same kind merge into one wire with `count`, best confidence, and the list of underlying relations (shown in the
details panel). `#include` / `import` wires are only drawn between blocks, not containers.

*Focus* keeps the k-hop neighbourhood of a node plus ancestors; *hide guesses* filters by confidence before lifting.

## 4. Layout and rendering

ELK `layered` with `hierarchyHandling: INCLUDE_CHILDREN` routes wires across nesting levels; edges are placed in
their lowest common container, coordinates are requested in root space (`json.shapeCoords/edgeCoords: ROOT`).

Full routing is only used while a view has ≤ 140 wires and ≤ 160 blocks. Beyond that it sprawls (blocks cover
≈ 2 % of the drawing) and its cost explodes (Redis at file level, 908 blocks / 4,893 wires: 32 s). Larger views
switch to a **compact layout** (3–5× denser, shown as "compact wiring" in the status bar): every
container is laid out on its own (`SEPARATE_CHILDREN`, low thoroughness, Brandes-Köpf placement), containers with
more than 60 children are packed (`rectpacking`), and wires are drawn as one-bend elbows between block borders
(0.7 s for the same view). Views above 6,000 blocks are refused with a hint to focus or pick a coarser level.
Circuit style uses orthogonal routing (RIGHT on wide screens, DOWN on tall ones); network style uses polylines drawn
as Catmull-Rom curves. If hierarchical layout fails, the view falls back to per-container layout with straight
wires. ELK runs in a web worker created from a blob (VS Code webviews cannot start workers from resource URLs).

SVG is generated as strings and swapped in at once. When the same picture is rearranged (a block opened or closed,
another level, focus), the clicked block keeps its place on screen and `transition.ts` animates the swap: blocks and
containers that stay move and resize from their old boxes, new ones grow out of their ancestor's old box and fade in,
vanishing ones fold into their ancestor's new box; wires fade in at the end. Nothing animates with
`prefers-reduced-motion`. Wires get an invisible wide twin for hovering. Zoomed-out
views drop secondary text (level of detail).

The flow layer is one `<canvas>` above the SVG (pointer-events: none). Each wire is sampled into a polyline with
cumulative lengths; particles are pre-rendered radial-gradient sprites drawn with `drawImage` in additive mode.
A global particle budget scales spacing, off-screen wires are culled, the loop stops when the document is hidden.
`FlowLayer.pulse(edgeId, colour)` fires single charges — the hook for runtime trace replay.

## 5. Problems: compile check and impact

**Sources of diagnostics** (`Diagnostic {file, line, severity, source, message, target?}`):

| source | from |
| --- | --- |
| `syntax` | tree-sitter could not parse (file level, coarse; dropped once a compiler/interpreter checked the file) |
| `incomplete` | declared-but-never-defined C/C++ functions that are called; `raise NotImplementedError` stubs that are called and not overridden |
| `python` | undefined names on unresolved calls, missing relative imports; `compile()` + pyflakes results |
| `compiler` | `gcc`/`clang -fsyntax-only` per translation unit (`verify.ts`), or the instrumented build |
| `linker` | undefined references from the Run & Trace link, mapped back to the declaration |
| `runtime` | uncaught exceptions, crashes (from a trace) |
| `editor` | optional: errors reported by VS Code language servers |

`verify.ts` runs units in parallel (≤ 8), reuses `compile_commands.json` entries (without `-o`, `-c`, `-M*`),
and keeps results per unit so that a save re-checks only the units that include the saved file (reverse
`#include` closure). It never runs in an untrusted workspace: a compile database can name any command.

`health.ts` attaches each diagnostic to the innermost entity whose definition contains its line (whole-file
errors such as a `SyntaxError` attach to the file), then computes:

- **broken** — entities with errors (plus everything in a file that does not parse),
- **affected** — reverse BFS over dependency relations (call, spawn, instantiate, inherit, include, import):
  callers of something broken, with distance and the path back to the cause,
- **unpowered** — functions not reachable from the entry points (`main`, `__main__` guards) once broken blocks
  stop the current; **cut** wires lead into a broken block, **dead** wires carry no current.

`overlay.ts` lifts this to the projection: only the broken block itself is red; containers show a count.

## 6. Run & Trace

**Trace format** (`code-graph-trace/1`, JSON lines, written by both runtimes):

```jsonc
{"k":"h","schema":"code-graph-trace/1","lang":"cpp","clock":"ns","pid":4242,"mono":…,"wall":…,"exe":"node-b"}
{"k":"t","id":2,"t":120934,"name":"thread-2"}                         // thread first seen
["c",121003,2,7,"0x7ffd…",[["pkt","o","0x7ffd…","0x7ffd…"]]]       // call: t, thread, fid, this, args
["r",121550,2,7]                                                      // return (Python: + value)
["x",130002,3,9,"SIGSEGV","segmentation fault …",0]                  // exception / crash in fid
{"k":"stack","th":3,"fids":[0,4,9]}                                   // every thread's stack at a crash
{"k":"agg","calls":[[7,99],…]}                                        // complete counts past the event cap
```

Values are `[kind, repr, identity?, size?]` with kinds `i d b s n c o` (int, float, bool, string, null,
container with size, object/pointer). Identities (`id()` in Python, addresses in C/C++, `this`/`self`) make data
tracking possible.

**Python** (`runtime/python/cg_tracer.py`, stdlib only): runs the script with `runpy`, registers
`sys.monitoring` callbacks for `PY_START/RESUME/RETURN/YIELD/UNWIND/THROW` (3.12+; `sys.setprofile` before).
Code outside the workspace returns `DISABLE` on its first event, so libraries cost almost nothing afterwards.
`threading.Thread.start` / `_bootstrap_inner` are wrapped to learn thread names and parents, `threading.excepthook`
to record uncaught errors in threads. Function ids map to entities by file + definition line, then qualname, then
the enclosing function (generator expressions, lambdas).

**C/C++** (`instrument.ts` + `runtime/c`): sources and headers are copied byte-exact (latin1) into the extension's
storage and every function body gets one statement after its `{`, on the same line:

```cpp
int Router::route(const Packet& pkt) { ::cgt::scope cgt_s_(12u, this); ::cgt::arg("pkt", pkt, 1); …
```

C uses `__attribute__((cleanup))` for the exit event; headers included by C files keep the C form. constexpr
functions, coroutines and function-try-blocks are skipped. `cg_trace.h` is force-included (`-include`), so no
`#include` is added. `cgt::arg` classifies a value with templates: numbers and strings by value, containers by
size, references, pointers and `this` by address. The runtime (`cg_trace.c`) keeps a buffer and a shadow stack
per thread, appends to the trace under one mutex, and on `SIGSEGV`/`SIGABRT`/… writes every thread's stack before
re-raising; `cg_trace_cxx.cpp` records the type and `what()` of an uncaught exception.

**Building it like the project does** (`buildinfo.ts`): a makefile is dry-run with `make -nBwk` (every command of
the default goal, with "Entering directory" lines); CMake gives `compile_commands.json` plus
`CMakeFiles/<target>.dir/link.txt`. Compiler, `ar` and link commands are grouped into programs: an executable link
with the compile commands of its objects, archives and shared libraries the project builds itself. A program
carries per-source compile flags (`-D`, `-I`, `-std` …), link flags (`-L`, `-l`, `-Wl,…`, `-pthread`) and the
directory it is linked in — where `make run` would start it. The compile check uses the same flags when there is
no `compile_commands.json`.

`runner.ts` builds the program's sources when the entry file belongs to one (the user picks when several do), else
the translation units `main` needs (file-level closure over call / spawn / instantiate / inherit relations,
methods of used classes, excluding units with another `main`), with `compile_commands.json` flags when present. A
unit whose instrumented copy does not compile is rebuilt untouched (it just is not traced). Link retries add the
workspace units that define missing symbols, then the libraries that usually provide them (`guessLibraries`:
OpenSSL, Boost, libm, … with `-L` for e.g. `/opt/boost-1.87/lib` when found); what is still missing is reported
on `main` in one line. The compile check runs before any build. The program runs with the link's library folders
(`-L`, every spelling of `-rpath`) on `LD_LIBRARY_PATH` (`DYLD_LIBRARY_PATH` on macOS): `-rpath` is a RUNPATH on most
distributions, which the loader does not use for the libraries a library loads (Boost.JSON → Boost.Container). For
the same reason the compiler shim adds `--disable-new-dtags` to program links that set an `-rpath`.

**Project settings** (`config.ts`): `.codegraph.json` at the workspace root (JSON with comments) has a `run` and a
`compose` section; a key there wins over the matching VS Code setting, so the host (`host/project.ts`) and the CLI
read the same values. When a run cannot be set up — no entry point, a build CodeGraph cannot read, a service it
cannot see into — the message offers to create the file; the starter has every key commented out, with what was
detected (entry points, programs, compose files, services) as the example values. `schemas/codegraph.schema.json`
gives completion and hovers in the editor.

**A build CodeGraph does not read** (`run.build` + `run.program`): the command runs in a traced copy of the
workspace (CMake-generated files dropped, so a configure starts over) with the same compiler shims as in
containers, then the program is started from the copy.

**Docker Compose** (`compose.ts`): `docker compose config --format json` gives the resolved project (all its files,
profiles, override file). A service is traced when its container has some of the workspace's C, C++ or Python
sources, found three ways:

| how | detected from | traced as |
| --- | --- | --- |
| mounted | a bind mount of the workspace or a folder in it | the traced copy is mounted at the same target |
| copied in | `build.context` in the workspace and a Dockerfile that `COPY`/`ADD`s (or `RUN --mount=type=bind`s) sources | the image is rebuilt from the copy: in each stage that `RUN`s after seeing the sources, `COPY --from=codegraph_trace / /codegraph/`, the shim setup and `PATH` go right before the first instruction that sees them (an `additional_contexts` entry); layers above stay cached |
| configured | `compose.sourcePath` / `compose.build` in `.codegraph.json` | the copy mounted there / a command run before the service's own |

Services without workspace sources (databases, proxies) run as they are. The workspace is copied (without `.git`,
`node_modules`, CMake caches), C/C++ files of the copy get probes, and an override file — JSON, which Compose reads
as YAML — gives each traced service:

| key | value |
| --- | --- |
| `volumes` | the copy at the workspace's mount targets (Compose merges volumes by target), `/codegraph` |
| `image` / `build` | for images built from the workspace: `codegraph-trace/<project>-<service>`, built from the copy with the traced Dockerfile |
| `entrypoint` / `command` | `/codegraph/bin/cg-run` + the service's own entrypoint and command (from the image when the compose file has none) |
| `environment` | `CODE_GRAPH_TRACE=/codegraph/trace/<service>/{host}-{pid}.jsonl`, Python roots, event cap, values |

`cg-run` (`umask 0`, so the host can delete what a root container builds) runs `cg-setup`, which looks through
`PATH` and links every C/C++ compiler and Python interpreter it finds (`gcc`, `g++-12`, `clang++-17`,
`aarch64-linux-gnu-gcc`, `python3.12` …; not `ar`, `ccache` or `*-config`) to a shim in `/tmp/codegraph-bin`, first
on `PATH`; `CC` / `CXX` given by full path are wrapped too. The compiler shim finds the real compiler further down
`PATH` (with the shim folders removed, so `ccache` and masquerading wrappers do not loop), adds
`-include /codegraph/rt/cg_trace.h` to every compile and, for a program link, compiles the runtime once per
container and appends it (`-Wl,--dynamic-list` exports `cgt_*`). For Python, the shim starts scripts under a source
root under the tracer, and `PYTHONPATH` gets `/codegraph/rt/py`, whose `sitecustomize` starts the tracer in every
other Python process — started by full path, gunicorn, multiprocessing children; such a trace file is only created
once workspace code runs, and a forked child gets its own. The project runs with `up`; the time limit counts from
the first trace file; when every traced container has exited or the limit is reached the project is stopped (the
runtime exits on `SIGTERM` even as PID 1) and taken down. A service that ended without a traced program gets a note
saying what to write in `.codegraph.json` (it compiled nothing, no workspace Python ran); its log is parsed for
compiler errors, with container paths mapped back to the workspace.

**Live** (`live.ts`): with `CODE_GRAPH_LIVE=1` the runtimes append, every 200 ms, a `live` record of what runs right
now: each thread's call stack (the C runtime's flusher thread reads the shadow stacks; the Python tracer its own),
cumulative call counts and caller → callee counts (C keeps those in a lock-free table in live mode). `LiveTail`
follows the trace files (for C/C++ only the tail of what they gained: the latest record is enough; Python files are
read in full for their function records), maps functions to entities, and reports threads, stacks and the calls
since the previous update every 250 ms; the webview lights the stacks, pulses those calls and labels busy functions.
A run has no time limit by default: Stop ends it (`finish`, unlike `signal`, keeps the trace) and the replay follows.

**Several processes** (`mergeTraces`): every trace header carries the monotonic and wall clock at its time 0
(containers share the host's clock), so spans are shifted onto one clock and re-sorted; threads are renumbered
across processes and named `<service> · <thread>`; object identities get the process name in front (the same
address in two processes is not one object); `procs` keeps each process's threads and exit. A stop by `SIGTERM` /
`SIGINT` (time limit, `docker stop`) ends the open spans but is not a failure. `processTrace` cuts one process back
out (its threads, spans, values, exceptions, call counts from its edges; the merged duration, so all views share one
time axis) for a view per container; those views relay play, pause, seek and speed through the host, so they replay
together.

**Model** (`RunTrace`): calls become spans per thread (`t`, `end`, `parent`, `depth`) as parallel arrays; thread
parents for C/C++ are inferred from the static spawn relation running in another thread when the thread started;
unnamed threads are named after their entry function (`rxLoop`, `txLoop #2`); objects seen by several functions or
threads are labelled with what the graph knows (the class of `this`, the declared parameter type).

**Viewer**: `augmentGraph` adds relations for calls only the run revealed (`via: 'runtime'`), `RuntimeMap` lifts
call counts and threads onto the visible blocks and wires, `TraceModel` answers time queries (calls started /
ended in a window, the active stack of every thread at *t*, every sighting of an object) with binary searches.
Replay advances program time at `duration / 15 s × speed` per frame and fires `FlowLayer.pulse` along the
projected wire of each call.

## 7. Adding a language

1. Add the grammar's `.wasm` to `scripts/build.mjs` and `extract/index.ts` (`loadParsers`, `languageOf`).
2. Write `extract/<lang>.ts` producing `RawEntity` / `RawCall` / imports.
3. Teach `link.ts` the language's scoping and import rules (or reuse the C++ or Python path).
4. Add a sample under `samples/` and assertions in `test/analyzer.test.ts`.

Every extractor keeps the same rules, so a feature works the same in every language:

- A call anywhere in a function body is a call of that function, in a `return` too: `return g();`,
  `return ok ? g() : h();`, `return a().b();`, and the language's own forms (`return await g()`, `yield from g()`,
  `co_return g();`). Calls inside a lambda count for the function that writes the lambda.
- A function's `rets` are its own: give `ownReturns` the language's return statements and the nodes that start
  another function (lambdas, nested functions, local classes). A function without a `return` gets `[]`.
- The test *return statements (every language)* in `test/analyzer.test.ts` gets a block for the new language.
- Library APIs (threads, tasks, object creation) are recognised by what a name stands for, not by how it is spelled:
  through the language's imports, `use` / `using` declarations and aliases (`CppNames` for C/C++, the import names in
  `python.ts`). The test *threads started through every spelling of the API (every language)* gets a block.
