# Architecture

```
┌─────────────────────────── extension host (Node) ───────────────────────────┐
│ extension.ts      commands, file watcher, cursor follow, status bar          │
│ host/service.ts   findFiles → AnalysisSession → CodeGraph; compile check     │
│ host/panel.ts     webview panel, CSP, message routing, verify on open/save   │
│ host/run.ts       Run & Trace: pick entry, check, build, run, post the trace │
│                                                                              │
│ core/ (no VS Code dependency — also used by the CLI and the tests)           │
│   pool.ts         worker_threads pool ──► parseWorker.ts                     │
│   extract/        tree-sitter WASM → FileFacts (per file, cacheable)         │
│   link.ts         FileFacts[] → CodeGraph (+ static problems)                │
│   analyze.ts      file walk, compile_commands.json, mtime cache              │
│   verify.ts       gcc/clang -fsyntax-only, python compile() → Diagnostics    │
│   health.ts       Diagnostics → broken / affected / unpowered / cut wires    │
│   instrument.ts   copy C/C++ sources with one probe per function body        │
│   runner.ts       build (C/C++) or start (Python) with a tracer, collect     │
│   trace.ts        trace format, parser → RunTrace (spans, threads, objects)  │
│   model.ts        shared types                                               │
│ runtime/          python/cc_tracer.py · c/cc_trace.{h,c} · c/cc_trace_cxx.cpp│
└──────────────────────────────────┬───────────────────────────────────────────┘
          postMessage(CodeGraph, diagnostics, trace)  ▲ open / verify / runTrace
┌──────────────────────────────────▼──────── webview (browser) ──────┴────────┐
│ projection.ts  tree (files|symbols) + level → visible blocks, lifted wires   │
│ layout.ts      ELK layered (INCLUDE_CHILDREN) in a web worker               │
│ overlay.ts     health → red / orange / grey blocks, cut wires               │
│ traceview.ts   trace → per-projection runtime facts, time queries, trails   │
│ timeline.ts    thread swimlanes (canvas), scrub / play / step               │
│ render.ts      SVG zones / blocks / wires / labels / live glows              │
│ flow.ts        canvas particles: arguments →, ← return values, replay pulses │
│ viewport.ts    pan / zoom / pinch / tap                                      │
│ main.ts        state, toolbar, details / problems / run panels, replay loop  │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 1. Extraction (per file)

`extract/*` walks a tree-sitter syntax tree and records **what is written**, without resolving anything:

- `RawEntity`: namespaces are implicit in `scope`; classes (with bases and field types); functions
  (params, return type, flags, `qualifier` for out-of-line definitions such as `void Router::start()`).
- `RawCall`: the call *form* (`plain`, `qualified`, `member`, `super`, `new`), the receiver path and, when it can
  be inferred locally, the receiver type (parameters, `auto x = new T`, `T x(…)`, `make_unique<T>`,
  `x = Foo()`, `with Foo() as x`, `for (auto& x : container)`), argument texts, and whether it is a
  *spawn* (a function reference handed to a thread/task API) or an *instantiation*.
- `#include` / `import` statements.

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
3. `using namespace` directives of the file,
4. receiver type → class → methods of the class and its bases (`member` calls; types of fields, element types
   of containers, `this->x`),
5. qualified names relative to the namespace chain, or `Class::method`,
6. unique name in the workspace → **likely**; several candidates → nearest by file (same file, header/source pair,
   included, same directory) → **guess**.

Calls into `std::`/`boost::` and to methods of known non-workspace types are not guessed. Common container/stdlib
method names (`push_back`, `append`, `get`, …) are never matched by name alone.

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

SVG is generated as strings and swapped in at once. Wires get an invisible wide twin for hovering. Zoomed-out
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

**Trace format** (`code-current-trace/1`, JSON lines, written by both runtimes):

```jsonc
{"k":"h","schema":"code-current-trace/1","lang":"cpp","clock":"ns","pid":4242}
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

**Python** (`runtime/python/cc_tracer.py`, stdlib only): runs the script with `runpy`, registers
`sys.monitoring` callbacks for `PY_START/RESUME/RETURN/YIELD/UNWIND/THROW` (3.12+; `sys.setprofile` before).
Code outside the workspace returns `DISABLE` on its first event, so libraries cost almost nothing afterwards.
`threading.Thread.start` / `_bootstrap_inner` are wrapped to learn thread names and parents, `threading.excepthook`
to record uncaught errors in threads. Function ids map to entities by file + definition line, then qualname, then
the enclosing function (generator expressions, lambdas).

**C/C++** (`instrument.ts` + `runtime/c`): sources and headers are copied byte-exact (latin1) into the extension's
storage and every function body gets one statement after its `{`, on the same line:

```cpp
int Router::route(const Packet& pkt) { ::cct::scope cct_s_(12u, this); ::cct::arg("pkt", pkt, 1); …
```

C uses `__attribute__((cleanup))` for the exit event; headers included by C files keep the C form. constexpr
functions, coroutines and function-try-blocks are skipped. `cc_trace.h` is force-included (`-include`), so no
`#include` is added. `cct::arg` classifies a value with templates: numbers and strings by value, containers by
size, references, pointers and `this` by address. The runtime (`cc_trace.c`) keeps a buffer and a shadow stack
per thread, appends to the trace under one mutex, and on `SIGSEGV`/`SIGABRT`/… writes every thread's stack before
re-raising; `cc_trace_cxx.cpp` records the type and `what()` of an uncaught exception.

`runner.ts` builds only the translation units `main` needs (file-level closure over call / spawn / instantiate /
inherit relations, methods of used classes, excluding units with another `main`), with `compile_commands.json`
flags when present. A unit whose instrumented copy does not compile is rebuilt untouched (it just is not traced);
one link retry adds units that define the missing symbols. The compile check runs before any build.

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
