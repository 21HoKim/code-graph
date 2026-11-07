#!/usr/bin/env node
/**
 * CodeCurrent CLI – run the analyzer without VS Code (CI, debugging, tests).
 *
 *   node dist/cli.js <dir> [-o graph.json] [--verify] [--workers N] [--max-files N] [-I include/dir] [--quiet]
 *
 *   --verify   also compile-check with the real toolchain (gcc/clang -fsyntax-only, python compile) and
 *              store the result in graph.compile; exits with code 2 when errors were found (handy in CI)
 *
 *   node dist/cli.js trace <dir> [--entry FILE] [-o run.json] [--timeout S] [--max-events N] [--no-values] [-- ARGS…]
 *
 *              Run & Trace without VS Code: build (C/C++, instrumented) or start (Python) the program,
 *              record calls per thread with argument values, and write the trace model the viewer replays.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AnalysisSession, walk } from './core/analyze';
import { ParsePool, defaultWorkerCount } from './core/pool';
import { loadParsers } from './core/extract';
import { findEntries, runAndTrace } from './core/runner';
import { detectToolchain, loadCompileCommands, verifyWorkspace } from './core/verify';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'trace') return traceMain(argv.slice(1));
  let dir: string | undefined;
  let out: string | undefined;
  let workers: number | undefined;
  let maxFiles = 5000;
  let quiet = false;
  let verify = false;
  const includes: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') out = argv[++i];
    else if (a === '--workers') workers = Number(argv[++i]);
    else if (a === '--max-files') maxFiles = Number(argv[++i]);
    else if (a === '-I') includes.push(argv[++i]);
    else if (a === '--quiet') quiet = true;
    else if (a === '--verify') verify = true;
    else if (a === '-h' || a === '--help') {
      console.log('usage: code-current <dir> [-o graph.json] [--verify] [--workers N] [--max-files N] [-I dir] [--quiet]');
      return;
    } else dir = a;
  }
  if (!dir) throw new Error('missing <dir>');
  const root = path.resolve(dir);
  const wasmDir = path.join(__dirname, 'wasm');
  const pool = new ParsePool(wasmDir, path.join(__dirname, 'parseWorker.js'), workers ?? defaultWorkerCount());
  const t0 = Date.now();
  const { files, truncated } = walk(root, { maxFiles });
  const session = new AnalysisSession(root, pool, includes.length ? includes : undefined);
  const graph = await session.analyze(files, (d, t) => {
    if (!quiet && process.stderr.isTTY) process.stderr.write(`\rparsing ${d}/${t}`);
  });
  pool.dispose();
  if (!quiet && process.stderr.isTTY) process.stderr.write('\n');
  const s = graph.stats;
  const pct = s.callSites ? Math.round((100 * s.resolvedCalls) / s.callSites) : 0;
  if (!quiet) {
    console.error(
      `${s.files} files${truncated ? ' (truncated)' : ''} · ${s.classes} classes · ${s.functions} functions · ` +
        `${s.relations} relations · ${s.resolvedCalls}/${s.callSites} call sites resolved (${pct}%) · ` +
        `parse ${s.parseMs}ms (cpu) · link ${s.linkMs}ms · wall ${Date.now() - t0}ms`,
    );
    for (const w of graph.warnings ?? []) console.error('warn:', w);
  }
  let exitCode = 0;
  if (verify) {
    const r = await verifyWorkspace({
      root,
      files: files.map((f) => ({ abs: f.abs, rel: f.rel, lang: (/\.py$/i.test(f.rel) ? 'python' : /\.c$/i.test(f.rel) ? 'c' : 'cpp') as 'c' | 'cpp' | 'python' })).filter((f) => !/\.pyi$/i.test(f.rel)),
      includePaths: session.includePaths,
      toolchain: detectToolchain({ cc: process.env.CC, cxx: process.env.CXX }),
      compileCommands: loadCompileCommands(root),
    });
    const { units: _units, diagnostics, ...info } = r;
    graph.compile = { diagnostics, info };
    const errors = diagnostics.filter((d) => d.severity === 'error');
    if (!quiet) {
      console.error(`verify: ${r.checkedC} C/C++ units · ${r.checkedPython} Python files · ${errors.length} errors · ${diagnostics.length - errors.length} warnings · ${r.ms}ms`);
      for (const d of diagnostics.slice(0, 50)) console.error(`  ${d.file}:${d.line}${d.col ? ':' + d.col : ''}: ${d.severity}: ${d.message}`);
      for (const n of r.notes) console.error('  note:', n);
    }
    if (errors.length) exitCode = 2;
  }
  const json = JSON.stringify(graph, null, out ? 0 : 2);
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, json);
  }
  else console.log(json);
  process.exitCode = exitCode;
}

async function traceMain(argv: string[]): Promise<void> {
  let dir: string | undefined;
  let out: string | undefined;
  let entryArg: string | undefined;
  let timeout = 20;
  let maxEvents = 200000;
  let values = true;
  let progArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      progArgs = argv.slice(i + 1);
      break;
    } else if (a === '-o' || a === '--out') out = argv[++i];
    else if (a === '--entry') entryArg = argv[++i];
    else if (a === '--timeout') timeout = Number(argv[++i]);
    else if (a === '--max-events') maxEvents = Number(argv[++i]);
    else if (a === '--no-values') values = false;
    else dir = a;
  }
  if (!dir) throw new Error('usage: code-current trace <dir> [--entry FILE] [-o run.json] [-- ARGS…]');
  const root = path.resolve(dir);
  const pool = new ParsePool(path.join(__dirname, 'wasm'), path.join(__dirname, 'parseWorker.js'), defaultWorkerCount());
  const { files } = walk(root, { maxFiles: 5000 });
  const session = new AnalysisSession(root, pool);
  const graph = await session.analyze(files);
  const entries = findEntries(graph);
  const entry = entryArg ? entries.find((e) => e.file === entryArg || e.label.includes(entryArg!)) : entries[0];
  if (!entry) {
    pool.dispose();
    throw new Error(`no entry point${entryArg ? ` matching ${entryArg}` : ''}; found: ${entries.map((e) => e.label).join(', ') || 'none'}`);
  }
  const t0 = Date.now();
  const r = await runAndTrace({
    root,
    graph,
    files: files
      .filter((f) => !/\.pyi$/i.test(f.rel))
      .map((f) => ({ abs: f.abs, rel: f.rel, lang: (/\.py$/i.test(f.rel) ? 'python' : graph.files.find((x) => x.path === f.rel)?.lang === 'c' ? 'c' : 'cpp') as 'c' | 'cpp' | 'python' })),
    entry,
    args: progArgs,
    toolchain: detectToolchain({ cc: process.env.CC, cxx: process.env.CXX }),
    includePaths: session.includePaths,
    compileCommands: loadCompileCommands(root),
    buildFlags: [],
    linkFlags: [],
    runtimeDir: path.join(__dirname, 'runtime'),
    workDir: path.join(os.tmpdir(), `code-current-run-${process.pid}`),
    parsers: () => loadParsers(path.join(__dirname, 'wasm')),
    timeoutMs: timeout * 1000,
    maxEvents,
    values,
    log: (l) => console.error(l),
  });
  pool.dispose();
  for (const n of r.notes) console.error('note:', n);
  for (const d of [...r.buildDiagnostics, ...r.runtimeDiagnostics]) console.error(`  ${d.file}:${d.line}: ${d.source} ${d.severity}: ${d.message}`);
  if (r.trace) {
    const tr = r.trace;
    console.error(
      `${entry.label}: exit ${tr.exit.code ?? tr.exit.signal ?? '?'}${tr.exit.crash ? ` (${tr.exit.crash})` : ''} · ${tr.threads.length} threads · ${tr.spans.t.length} calls · ` +
        `${tr.objects.length} shared objects · ${(tr.durationNs / 1e6).toFixed(1)} ms traced · ${Date.now() - t0} ms total`,
    );
    const json = JSON.stringify({ ...tr, diagnostics: [...r.buildDiagnostics, ...r.runtimeDiagnostics], notes: r.notes });
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, json);
    } else console.log(json);
  } else {
    process.exitCode = 2;
    if (r.output) console.error(r.output.slice(-4000));
  }
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
