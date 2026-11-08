# Versions

[README](../README.md) · [한국어](VERSIONING.ko.md) · [Guide](GUIDE.md) · [Changelog](../CHANGELOG.md) · [Releases](https://github.com/21HoKim/code-graph/releases)

A CodeGraph version such as **0.5.0** has three numbers: **MAJOR.MINOR.PATCH**.

| number | in 0.5.0 | goes up when | set by |
| --- | --- | --- | --- |
| MAJOR | 0 | something you rely on stops working the old way: a setting or `.codegraph.json` key is removed or renamed, or a file format changes so older files no longer load | hand |
| MINOR | 5 | something new you would notice: a new kind of run, view or project file (the live view, `.codegraph.json`, a view per container) | hand |
| PATCH | 0 | anything else that changes the extension: fixes and small improvements | automatically, on every release |

So **0.4.1 → 0.4.2** is a fix you can take without reading anything, **0.4.x → 0.5.0** brings something new worth a look
in the [changelog](../CHANGELOG.md), and a new MAJOR number means checking your settings.

## Before 1.0

While the MAJOR number is **0**, CodeGraph is still growing, and a MINOR version may also change how things work by
default. 0.5.0, for example, removed the 20-second time limit of Run & Trace (it now runs until the program ends or
you press Stop). Every such change is written down under its version in the changelog.

From **1.0** on, settings, `.codegraph.json` keys and the trace and graph file formats stay compatible through all
1.x versions; only a 2.0 may break them.

## How a version is released

Every push to `main` that changes the extension (`src/`, `runtime/`, `media/`, `l10n/`, `schemas/`, `package.json`,
…) is released by the *Publish* workflow:

1. The type check and the tests run; if anything fails, nothing is released.
2. The version is picked (`scripts/release-version.mjs`): the version in `package.json` if it is newer than every
   release so far, otherwise the next PATCH after the newest release.
3. The extension is packaged, published to the VS Code Marketplace, and attached to a GitHub release `vX.Y.Z`
   that links to every change since the previous release.

A new MINOR or MAJOR version is released by setting it in `package.json` (`npm version minor --no-git-tag-version`)
and pushing. Until the next such change, every release is the next PATCH: after 0.5.0 come 0.5.1, 0.5.2, … The
version in the repository's `package.json` therefore stays at 0.5.0 while the Marketplace has 0.5.3; the exact
version is written only into the published package.

Pushes that change only documentation (`README`, `docs/`) are not released. Their README and CHANGELOG changes
reach the Marketplace page with the next release.

## Where to see what changed

- [CHANGELOG.md](../CHANGELOG.md): a section for every MINOR version and notable PATCH versions.
- [GitHub Releases](https://github.com/21HoKim/code-graph/releases): every version, with its `.vsix`.
- The Marketplace page's *Version History* tab. VS Code updates the extension by itself; to go back to an older
  version, use *Install Another Version…* in the extension's ⚙ menu, or install a `.vsix` from Releases.

## Other numbers you may see

| where | number | meaning |
| --- | --- | --- |
| first line of a raw trace (`.jsonl`) | `code-graph-trace/1` | trace format version: goes up only when older CodeGraph versions could not read the new format |
| a graph from *Export Graph as JSON* or `code-graph <dir> -o`, a run from `code-graph trace -o` | `"schema": 1` | the same for those files |
| `package.json` → `engines.vscode` | `^1.85.0` | the oldest VS Code the extension runs in |

## Versions so far

| version | what it brought |
| --- | --- |
| 0.1.0 | the static circuit: C, C++ and Python as blocks and wires |
| 0.2.0 | compile check with impact on the circuit; Run & Trace with threads, data and crashes |
| 0.2.1 | first release on the Marketplace; the CodeGraph panel in the activity bar |
| 0.3.0 | programs built the way the project builds them (make, CMake); Run & Trace with Docker Compose |
| 0.4.0 | any Docker setup traced; `.codegraph.json` for unusual setups; README with usage, examples and GIFs |
| 0.4.1 | a view per container; libraries that load libraries are found |
| 0.5.0 | the live view; no time limit, Stop keeps the trace |
