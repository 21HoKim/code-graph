# Versions

[README](../README.md) · [한국어](VERSIONING.ko.md) · [Guide](GUIDE.md) · [Changelog](../CHANGELOG.md) · [Releases](https://github.com/21HoKim/code-graph/releases)

- Format: three numbers, **MAJOR.MINOR.PATCH** (e.g. **0.5.0**)

| number | in 0.5.0 | goes up on | set by |
| --- | --- | --- | --- |
| MAJOR | 0 | a break with the old way: a setting or `.codegraph.json` key removed or renamed, a file format older files no longer load in | hand |
| MINOR | 5 | something new and visible: a new kind of run, view or project file (the live view, `.codegraph.json`, a view per container) | hand |
| PATCH | 0 | any other extension change: fixes, small improvements | automatically, every release |

- **0.4.1 → 0.4.2**: a fix, safe to take as is
- **0.4.x → 0.5.0**: something new worth a look in the [changelog](../CHANGELOG.md)
- New MAJOR: settings worth checking

## Before 1.0

- MAJOR **0**: still growing, default behaviour may change in a MINOR version
  - Example: 0.5.0 removed the 20-second time limit of Run & Trace (runs until the program ends or Stop)
  - Every such change recorded under its version in the changelog
- From **1.0**: settings, `.codegraph.json` keys, trace and graph file formats compatible through all 1.x versions; breaking changes only in 2.0

## Release process

- Trigger: a push to `main` changing the extension (`src/`, `runtime/`, `media/`, `l10n/`, `schemas/`, `package.json`, …) → the *Publish* workflow

1. Type check and tests — nothing released on any failure
2. Version (`scripts/release-version.mjs`): the `package.json` version if newer than every release, otherwise the next PATCH after the newest release
3. Package → VS Code Marketplace → GitHub release `vX.Y.Z` (with a link to every change since the previous release)
4. The same package on [Open VSX](https://open-vsx.org/extension/21HoKim/code-graph-vscode), the source for Cursor, VSCodium, Windsurf and Theia (when the repository variable `OPEN_VSX` is `true`)

- New MINOR or MAJOR: that version set in `package.json` (`npm version minor --no-git-tag-version`), then a push
- Until the next such change: the next PATCH on every release (0.5.0 → 0.5.1, 0.5.2, …)
  - `package.json` stays at 0.5.0 while the Marketplace has 0.5.3; the exact version only in the published package
- Documentation-only pushes (`README`, `CHANGELOG`, `docs/`): no release; README and CHANGELOG changes on the Marketplace page with the next release

## Where to see what changed

- [CHANGELOG.md](../CHANGELOG.md) ([한국어](../CHANGELOG.ko.md)): every version as **Added / Changed / Fixed**, shown in the Marketplace *Changelog* tab
- [GitHub Releases](https://github.com/21HoKim/code-graph/releases): every version's notes (English, Korean folded under **한국어**) and its `.vsix`
- The Marketplace *Version History* tab
- Updates: automatic in VS Code
- Going back: *Install Another Version…* in the extension's ⚙ menu, or a `.vsix` from Releases

## Other numbers

| where | number | meaning |
| --- | --- | --- |
| first line of a raw trace (`.jsonl`) | `code-graph-trace/1` | trace format version, raised only when older CodeGraph versions could not read the new format |
| a graph from *Export Graph as JSON* or `code-graph <dir> -o`, a run from `code-graph trace -o` | `"schema": 1` | format version of those files |
| `package.json` → `engines.vscode` | `^1.85.0` | oldest VS Code the extension runs in |

## Versions so far

| version | what it brought |
| --- | --- |
| 0.1.0 | static circuit: C, C++ and Python as blocks and wires |
| 0.2.0 | compile check with impact on the circuit; Run & Trace with threads, data and crashes |
| 0.2.1 | first Marketplace release; CodeGraph panel in the activity bar |
| 0.3.0 | programs built the way the project builds them (make, CMake); Run & Trace with Docker Compose |
| 0.4.0 | any Docker setup traced; `.codegraph.json` for unusual setups; README with usage, examples and GIFs |
| 0.4.1 | a view per container; libraries loaded by libraries found |
| 0.5.0 | live view; no time limit, Stop keeps the trace |
| 0.6.0 | container cards (live and replay), live swimlanes, following one thread; C++ threads found however spelled, the starter of each thread recorded at run time |
