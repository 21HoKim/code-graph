# Contributing

Thanks for helping! The project is small on purpose — please keep it light.

## Setup

```bash
npm ci
npm run build      # or `npm run watch`
npm test
```

Run the extension from source without installing it (rebuild with `npm run build`, then reload that window):

```bash
code --extensionDevelopmentPath="$PWD" examples/cpp/router
```

Open the command palette there and run **CodeGraph: Open Circuit View**. Editor settings and debug
configurations (`.vscode/`) are personal and are not part of the repository.

Without VS Code:

```bash
node dist/cli.js examples/python/pipeline -o out/graph.json        # analyzer only
node dist/cli.js examples/cpp/features/problems --verify -o out/broken.json  # + compile check
node dist/cli.js trace examples/cpp/router -o out/run.json        # Run & Trace
npm run demo                                                      # out/demo.html — the webview with sample data and traces
# small hostable page that loads ELK from a CDN instead of inlining it:
ELK_CDN=https://cdn.jsdelivr.net/npm/elkjs@0.12.1/lib/ node scripts/build-demo.mjs out/site/index.html en out/cpp-router.json:C++
```

## Layout

| folder | what is in it | rules |
| --- | --- | --- |
| `src/core/` | the analyzer and everything that runs without VS Code: extractors (`extract/`, one file per language, `cppnames.ts` for C/C++ names and library APIs), linker, compile check, Run & Trace (build, run, Compose, live), trace model | no `vscode` import: it runs in the CLI, worker threads and tests |
| `src/host/` | the VS Code side: commands, the circuit panel, Run & Trace and its messages, project settings | |
| `src/webview/` | the circuit view: projection, layout, rendering, timeline, live lanes, container cards, panels | browser code, no Node APIs; UI strings in `i18n.ts` (English and Korean) |
| `src/shared/` | the messages between host and view (`protocol.ts`) | |
| `src/extension.ts`, `src/cli.ts` | entry points of the extension and of `code-graph` on the command line | |
| `runtime/` | the tracers that run inside the user's program: `c/` (C99 + pthreads, C++11 part), `python/` (standard library only) | no dependencies; with tracing off the program must behave exactly as without them |
| `examples/` | programs to try every feature on, per language: `features/<feature>/` folders with a checklist each, and a few realistic programs — see [examples/README.md](examples/README.md) | every README claim is checked in `test/examples.test.ts`; generic names only |
| `test/` | `node --test` suites, one per area (`analyzer`, `trace`, `live`, `compose`, `timeline` …); `examples.test.ts` runs the examples | fixtures written to a temporary folder, with generic names |
| `scripts/` | the build (esbuild), the demo page, the release version and notes | |
| `schemas/` | `codegraph.schema.json`, `.codegraph.json` for the editor | keep it in step with `src/core/config.ts` (a test compares their keys) |
| `l10n/`, `package.nls*.json` | Korean strings of the host and of `package.json` | English is the source; add both |
| `media/` | the icons the extension ships | |
| `docs/` | [GUIDE](docs/GUIDE.md), [ARCHITECTURE](docs/ARCHITECTURE.md), [VERSIONING](docs/VERSIONING.md), [ROADMAP](docs/ROADMAP.md) (English and Korean where users read them), `images/` for the README | |
| `.github/workflows/` | `ci.yml` (type check and tests on pull requests), `publish.yml` (release on every push to `main`) | |

The Docker Compose tests run real containers and are skipped unless `CODE_GRAPH_DOCKER_TEST=1` and Docker is
running (CI sets it): `CODE_GRAPH_DOCKER_TEST=1 npm test`. The GIFs in the README are recorded from code-server with
Playwright (a drawn cursor, segments cut with ffmpeg, compressed with gifsicle).

## Releases

Every push to `main` that changes the extension (`src/`, `runtime/`, `media/`, `package.json`, …) runs
`.github/workflows/publish.yml`: tests, then publish to the VS Code Marketplace and a GitHub release with the
`.vsix`. Docs-only pushes don't publish; their README changes go out with the next release, or run the workflow by
hand (*Actions* → *Publish* → *Run workflow*).

- **Write what changed** with the change: a line under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md) and
  [CHANGELOG.ko.md](CHANGELOG.ko.md), under `### Added` / `### Changed` / `### Fixed` (추가 / 변경 / 수정), in words a
  user understands. The release makes that its notes and renames the section to its version
  (`scripts/release-notes.mjs`); without entries, the notes list the commit titles.
- The version is picked by `scripts/release-version.mjs`: the next patch after the newest release. To release a
  new minor or major version, set it in `package.json` (`npm version minor --no-git-tag-version`) and push.
  [docs/VERSIONING.md](docs/VERSIONING.md) says what each number means and when it goes up.
- Publishing uses Marketplace Trusted Publishing (GitHub OIDC), so the repository holds no token. The publisher
  `21HoKim` has a policy for owner `21HoKim`, repository `code-graph`, workflow `publish.yml`.

## Pull requests

- `npm run typecheck && npm test` must pass.
- New resolution rules come with an example (a line in the matching `examples/<language>/features/` folder and its
  README checklist, or a snippet in a test) and a test assertion.
- Prefer marking a link `guess` over inventing one; never draw a link the analyzer cannot justify.
- Changes to the instrumenter must keep line numbers stable (probes go on the line of the `{`) and come with a
  test in `test/trace.test.ts`.
- UI strings go through `src/webview/i18n.ts` (English + Korean).
