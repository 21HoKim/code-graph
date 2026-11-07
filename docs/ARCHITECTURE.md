# Architecture

```
┌─────────────────────────── extension host (Node) ───────────────────────────┐
│ extension.ts      commands, file watcher, cursor follow, status bar          │
│ host/service.ts   findFiles → AnalysisSession → CodeGraph                    │
│ host/panel.ts     webview panel, CSP, message routing, "open source"         │
│                                                                              │
│ core/ (no VS Code dependency — also used by the CLI and the tests)           │
│   pool.ts         worker_threads pool ──► parseWorker.ts                     │
│   extract/        tree-sitter WASM → FileFacts (per file, cacheable)         │
│     cpp.ts        C and C++                                                  │
│     python.ts     Python                                                     │
│   link.ts         FileFacts[] → CodeGraph (cross-file resolution)            │
│   analyze.ts      file walk, compile_commands.json, mtime cache              │
│   model.ts        all shared types                                           │
│   trace.ts        draft runtime-trace contract (phase 2)                     │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │ postMessage(CodeGraph)            ▲ open / reanalyze
┌──────────────────────────────────▼──────── webview (browser) ──────┴────────┐
│ projection.ts  tree (files|symbols) + level → visible blocks, lifted wires   │
│ layout.ts      ELK layered (INCLUDE_CHILDREN) in a web worker               │
│ render.ts      SVG zones / blocks / wires / data labels                      │
│ flow.ts        canvas particles: arguments →, ← return values                │
│ viewport.ts    pan / zoom / pinch / tap                                      │
│ main.ts        state, toolbar, search, details panel, persistence            │
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

## 5. Adding a language

1. Add the grammar's `.wasm` to `scripts/build.mjs` and `extract/index.ts` (`loadParsers`, `languageOf`).
2. Write `extract/<lang>.ts` producing `RawEntity` / `RawCall` / imports.
3. Teach `link.ts` the language's scoping and import rules (or reuse the C++ or Python path).
4. Add a sample under `samples/` and assertions in `test/analyzer.test.ts`.
