# CodeCurrent

**See your C, C++ and Python code as a live circuit.**
Folders, files, namespaces, classes and functions become blocks; calls, thread spawns, object creation and
inheritance become wires — and data flows along them like current.

[한국어 README](README.ko.md) · [Architecture](docs/ARCHITECTURE.md) · [Roadmap (dynamic analysis)](docs/ROADMAP.md)

![Class level of a C++ router: zones for folders/files/namespaces, wires with call data](docs/images/circuit-cpp.png)

## Features (v0.1 — static analysis)

- **C, C++ and Python** parsed with tree-sitter (WebAssembly — no compiler, no native dependencies).
- **Abstraction levels**: Folder → File → Namespace → Class → Function. Wires are lifted to whatever is
  visible and merged, so the same project reads as a module map or as a call graph. Double-click any block
  to open it up in place.
- **Two groupings**: *Files* (physical: a C++ class whose methods live in `router.cpp` shows up there as a
  dashed "implementation fragment") and *Symbols* (logical: namespaces → classes → methods, merged across files).
- **Electric flow**: charges travel caller → callee (arguments); amber charges travel back when the callee
  returns a value. Click a block and its wires light up with labels showing what travels on them
  (`(pkt, 100) ⟲ bool`).
- **Concurrency, statically**: thread entry points are found from `std::thread`, `std::async`,
  `std::jthread`, `vector<thread>::emplace_back`, `pthread_create`, `threading.Thread(target=…)`,
  `executor.submit/map`, `asyncio.create_task`, … and drawn as orange ⚡ spawn wires.
- **Honest resolution**: every link carries a confidence — *exact*, *likely* (type inference) or *guess*
  (name only, dashed). Guesses can be hidden.
- **Two layouts**: *Circuit* (orthogonal traces, left→right; top→down on tall screens) and *Network*
  (curved links), both computed by [ELK](https://eclipse.dev/elk/) in a web worker.
- **Editor integration**: jump to source, "Show in Circuit View" from the explorer/editor, the block under the
  cursor pulses, saving a file re-parses only that file.
- **Light**: parsing runs on worker threads, the flow animation is a single canvas with a particle budget and
  stops when the panel is hidden.

| Function level: threads | Network layout (Python) |
| --- | --- |
| ![Thread spawns at function level](docs/images/function-level-threads.png) | ![Python pipeline in network layout](docs/images/network-python.png) |

## Install

**From a release (.vsix)**

```bash
code --install-extension code-current-0.1.0.vsix
```

or in VS Code: *Extensions* view → `…` menu → *Install from VSIX…*

**From source**

```bash
git clone https://github.com/21HoKim/code-current && cd code-current
npm ci
npm run build          # bundles dist/ (extension, parse worker, webview, WASM grammars)
npm test               # analyzer + projection tests
npx @vscode/vsce package --no-dependencies   # -> code-current-<version>.vsix
```

Press **F5** in VS Code to launch an Extension Development Host on `samples/cpp-router`
(see `.vscode/launch.json`).

## Use

| | |
| --- | --- |
| `CodeCurrent: Open Circuit View` | analyze the workspace and open the view |
| `CodeCurrent: Show in Circuit View` | focus the current file (explorer / editor context menu, status bar) |
| click a block | trace its wires (others dim), details on the right |
| double-click | expand / collapse; on a function: open source |
| `1`…`5` | Folder / File / Namespace / Class / Function |
| `/` | search symbols · `F` fit · `Esc` clear · `Enter` open selection |

Settings (`codeCurrent.*`): `defaultLevel`, `layout`, `flow.mode`, `flow.maxParticles`, `showGuessedLinks`,
`followCursor`, `exclude`, `maxFiles`, `cpp.includePaths`, `analysis.workers`.
`compile_commands.json` (root, `build/`, `out/`, `cmake-build-*`) is read automatically for include paths.

### Command-line analyzer

```bash
node dist/cli.js path/to/project -o graph.json
# 15 files · 8 classes · 33 functions · 54 relations · 36/73 call sites resolved (49%) · …
```

## How it works

```
files ──tree-sitter (worker threads)──► per-file facts ──link──► CodeGraph (entities + relations)
                                         (cached by mtime)          │
                                                   webview: project(level, grouping) → ELK → SVG + canvas flow
```

Unresolved call sites are mostly library calls (`std::`, libc, Python stdlib) — the view only draws links
between symbols in your workspace. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Limitations

Static analysis without a compiler: macros are not expanded, templates are not instantiated, virtual and
dynamic dispatch resolve to the declared target, function pointers/callbacks other than thread APIs are not
followed. Low-confidence links are marked as such. A language-server pass (clangd / Pylance call hierarchy) to
confirm them is on the [roadmap](docs/ROADMAP.md).

## Roadmap

1. **Precision** — LSP call-hierarchy confirmation, virtual-dispatch fan-out, callbacks.
2. **Dynamic** — runtime traces (Python `sys.monitoring`, C/C++ `-finstrument-functions` / eBPF), replay with
   per-thread colours and swimlanes, follow one object (`id`) across wires and threads.
3. **Live** — debugger (DAP) integration, lock contention.
4. **More languages** — tree-sitter adapters for Rust, Go, Java, TypeScript.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Adding a language is mostly one extractor file.

## License

MIT © 김호 (21HoKim). Third-party components: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
(ELK is EPL-2.0, tree-sitter is MIT).
