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
code --extensionDevelopmentPath="$PWD" samples/cpp-router
```

Open the command palette there and run **CodeGraph: Open Circuit View**. Editor settings and debug
configurations (`.vscode/`) are personal and are not part of the repository.

Without VS Code:

```bash
node dist/cli.js samples/py-pipeline -o out/graph.json            # analyzer only
node dist/cli.js samples/broken-cpp --verify -o out/broken.json   # + compile check
node dist/cli.js trace samples/cpp-router -o out/run.json         # Run & Trace
npm run demo                                                      # out/demo.html — the webview with sample data and traces
# small hostable page that loads ELK from a CDN instead of inlining it:
ELK_CDN=https://cdn.jsdelivr.net/npm/elkjs@0.12.1/lib/ node scripts/build-demo.mjs out/site/index.html en out/cpp-router.json:C++
```

## Layout

- `src/core` — analyzer, no `vscode` import allowed (it runs in the CLI, worker threads and tests).
- `src/host` — VS Code glue.
- `src/webview` — the view (browser code, no Node APIs).
- `runtime/` — the tracers that run inside the user's program (Python stdlib only; C99 + pthreads, C++11).
  Keep them dependency-free and never let them change what the program does when tracing is off.
- `samples/` — small projects used by tests and the demo (`broken-*` fail on purpose; `net-pair` is a client and
  a server with a makefile and two compose files — mounted, and built into the image; `py-pipeline` has a compose
  file too).
- `schemas/codegraph.schema.json` — `.codegraph.json` for the editor; keep it in step with `src/core/config.ts`
  (a test compares their keys).

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
- New resolution rules come with a sample snippet and a test assertion.
- Prefer marking a link `guess` over inventing one; never draw a link the analyzer cannot justify.
- Changes to the instrumenter must keep line numbers stable (probes go on the line of the `{`) and come with a
  test in `test/trace.test.ts`.
- UI strings go through `src/webview/i18n.ts` (English + Korean).
