# Contributing

- Thanks for helping
- Small on purpose — changes kept light

## Setup

```bash
npm ci
npm run build      # or `npm run watch`
npm test
```

- Extension from source without installing (rebuild with `npm run build`, then reload that window):

```bash
code --extensionDevelopmentPath="$PWD" examples/cpp/router
```

- Then: **CodeGraph: Open Circuit View** from the command palette
- Editor settings and debug configurations (`.vscode/`): personal, not part of the repository
- Without VS Code:

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

- Docker Compose tests: real containers, skipped unless `CODE_GRAPH_DOCKER_TEST=1` and Docker running (set in CI) — `CODE_GRAPH_DOCKER_TEST=1 npm test`
- README GIFs: recorded from code-server with Playwright (drawn cursor, segments cut with ffmpeg, compressed with gifsicle)

## Releases

- Trigger: every push to `main` changing the extension (`src/`, `runtime/`, `media/`, `package.json`, …) → `.github/workflows/publish.yml`
  - Tests, then the VS Code Marketplace and a GitHub release with the `.vsix`
- Docs-only pushes: no release; README changes with the next release, or a manual run (*Actions* → *Publish* → *Run workflow*)
- **What changed, written with the change**: a line under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md) and [CHANGELOG.ko.md](CHANGELOG.ko.md)
  - Under `### Added` / `### Changed` / `### Fixed` (추가 / 변경 / 수정), in words a user understands
  - Style: nested bullets, each ending in a noun phrase (Korean: a noun, no `~해요`/`~함`); no italics in Korean — UI names in bold followed by a noun
  - At release: the section becomes the notes and is renamed to the version (`scripts/release-notes.mjs`); without entries, the commit titles
- Version: `scripts/release-version.mjs` — the next patch after the newest release
  - New minor or major: set in `package.json` (`npm version minor --no-git-tag-version`), then a push
  - Meaning of each number: [docs/VERSIONING.md](docs/VERSIONING.md)
- Sign-in: Marketplace Trusted Publishing (GitHub OIDC), no token in the repository
  - Publisher `21HoKim` policy: owner `21HoKim`, repository `code-graph`, workflow `publish.yml`

## Pull requests

- Required: `npm run typecheck && npm test` passing
- New resolution rules: an example (a line in the matching `examples/<language>/features/` folder and its README checklist, or a snippet in a test) plus a test assertion
- Uncertain links: marked `guess` rather than invented; no link the analyzer cannot justify
- Instrumenter changes: stable line numbers (probes on the line of the `{`) plus a test in `test/trace.test.ts`
- UI strings: through `src/webview/i18n.ts` (English + Korean)
- Docs other than READMEs: bullet points ending in noun phrases, as in the changelog
