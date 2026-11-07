# Contributing

Thanks for helping! The project is small on purpose — please keep it light.

## Setup

```bash
npm ci
npm run build      # or `npm run watch`
npm test
```

Open the folder in VS Code and press **F5** ("Run Extension (C++ sample)"). The extension host opens
`samples/cpp-router`; run **CodeCurrent: Open Circuit View**. Reload the host window (`Ctrl+R`) after rebuilding.

Without VS Code:

```bash
node dist/cli.js samples/py-pipeline -o out/graph.json   # analyzer only
npm run demo                                             # out/demo.html — the webview with sample data
# small hostable page that loads ELK from a CDN instead of inlining it:
ELK_CDN=https://cdn.jsdelivr.net/npm/elkjs@0.12.1/lib/ node scripts/build-demo.mjs out/site/index.html en out/cpp-router.json:C++
```

## Layout

- `src/core` — analyzer, no `vscode` import allowed (it runs in the CLI, worker threads and tests).
- `src/host` — VS Code glue.
- `src/webview` — the view (browser code, no Node APIs).
- `samples/` — small projects used by tests and the demo.

## Pull requests

- `npm run typecheck && npm test` must pass.
- New resolution rules come with a sample snippet and a test assertion.
- Prefer marking a link `guess` over inventing one; never draw a link the analyzer cannot justify.
- UI strings go through `src/webview/i18n.ts` (English + Korean).
