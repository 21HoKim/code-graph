// Build: extension host (node/cjs), parse worker, CLI, webview (browser/iife) + WASM/ELK assets.
//   node scripts/build.mjs [--production] [--watch] [--tests]
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const args = new Set(process.argv.slice(2));
const prod = args.has('--production');
const watch = args.has('--watch');
const tests = args.has('--tests');

function clean() {
  fs.rmSync('dist', { recursive: true, force: true });
  if (tests) fs.rmSync('out-test', { recursive: true, force: true });
}

function copyAssets() {
  fs.mkdirSync('dist/wasm', { recursive: true });
  fs.mkdirSync('dist/webview', { recursive: true });
  const copies = [
    ['node_modules/web-tree-sitter/web-tree-sitter.wasm', 'dist/wasm/web-tree-sitter.wasm'],
    ['node_modules/tree-sitter-c/tree-sitter-c.wasm', 'dist/wasm/tree-sitter-c.wasm'],
    ['node_modules/tree-sitter-cpp/tree-sitter-cpp.wasm', 'dist/wasm/tree-sitter-cpp.wasm'],
    ['node_modules/tree-sitter-python/tree-sitter-python.wasm', 'dist/wasm/tree-sitter-python.wasm'],
    // Oniguruma regex engine for the TextMate grammars of the source preview's syntax colours
    ['node_modules/shiki/dist/onig.wasm', 'dist/wasm/onig.wasm'],
    ['node_modules/elkjs/lib/elk-worker.min.js', 'dist/webview/elk-worker.js'],
  ];
  for (const [from, to] of copies) fs.copyFileSync(from, to);
  // runtime tracers (Run & Trace) ship as source: python tracer + C/C++ runtime compiled into the traced build
  fs.cpSync('runtime', 'dist/runtime', { recursive: true, filter: (f) => !/__pycache__|\.pyc$/.test(f) });
}

const common = { bundle: true, sourcemap: !prod, minify: prod, logLevel: 'warning', target: 'es2022', legalComments: 'linked' };
// web-tree-sitter's ESM build relies on import.meta.url; bundle its CJS build for Node targets.
const node = { platform: 'node', format: 'cjs', alias: { 'web-tree-sitter': './node_modules/web-tree-sitter/web-tree-sitter.cjs' } };
const builds = [
  { ...common, ...node, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...common, ...node, entryPoints: ['src/core/parseWorker.ts'], outfile: 'dist/parseWorker.js' },
  { ...common, ...node, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js' },
  { ...common, entryPoints: { main: 'src/webview/main.ts' }, outdir: 'dist/webview', platform: 'browser', format: 'iife' },
];
if (tests) {
  const entries = fs.readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => path.join('test', f));
  builds.push({ ...common, ...node, sourcemap: true, entryPoints: entries, outdir: 'out-test' });
}

if (!watch) clean();
copyAssets();
if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  console.log('watching…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  console.log(`built ${builds.length} bundles${prod ? ' (production)' : ''}`);
}
