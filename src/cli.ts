#!/usr/bin/env node
/**
 * CodeGraph CLI – run the analyzer without VS Code (CI, debugging, tests).
 *
 *   node dist/cli.js <dir> [-o graph.json] [--verify] [--workers N] [--max-files N] [-I include/dir] [--quiet]
 *
 *   --verify   also compile-check with the real toolchain (gcc/clang -fsyntax-only, python compile) and
 *              store the result in graph.compile; exits with code 2 when errors were found (handy in CI)
 *
 *   node dist/cli.js trace <dir> [--entry FILE] [--target NAME] [-o run.json] [--timeout S] [--max-events N] [--no-values] [-- ARGS…]
 *   node dist/cli.js trace <dir> --compose [FILE] [--service NAME]… [-o run.json] [--timeout S]
 *
 *              Run & Trace without VS Code: build (C/C++, instrumented) or start (Python) the program,
 *              record calls per thread with argument values, and write the trace model the viewer replays.
 *              --target picks the program when the makefile / CMake builds the entry into several;
 *              --compose runs the directory's Compose project with every service that mounts it traced.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AnalysisSession, walk } from './core/analyze';
import { ParsePool, defaultWorkerCount } from './core/pool';
import { loadParsers } from './core/extract';
import { readBuildTargets, targetsFor } from './core/buildinfo';
import { findComposeFile, runComposeTrace } from './core/compose';
import { findEntries, runAndTrace, type RunResult } from './core/runner';
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
      console.log('usage: code-graph <dir> [-o graph.json] [--verify] [--workers N] [--max-files N] [-I dir] [--quiet]');
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
  let targetArg: string | undefined;
  let compose: string | true | undefined;
  const services: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      progArgs = argv.slice(i + 1);
      break;
    } else if (a === '-o' || a === '--out') out = argv[++i];
    else if (a === '--entry') entryArg = argv[++i];
    else if (a === '--target') targetArg = argv[++i];
    else if (a === '--compose') compose = argv[i + 1] && /\.ya?ml$/.test(argv[i + 1]) ? argv[++i] : true;
    else if (a === '--service') services.push(argv[++i]);
    else if (a === '--timeout') timeout = Number(argv[++i]);
    else if (a === '--max-events') maxEvents = Number(argv[++i]);
    else if (a === '--no-values') values = false;
    else dir = a;
  }
  if (!dir) throw new Error('usage: code-graph trace <dir> [--entry FILE] [-o run.json] [-- ARGS…]');
  const root = path.resolve(dir);
  const pool = new ParsePool(path.join(__dirname, 'wasm'), path.join(__dirname, 'parseWorker.js'), defaultWorkerCount());
  const { files } = walk(root, { maxFiles: 5000 });
  const session = new AnalysisSession(root, pool);
  const graph = await session.analyze(files);
  const fileList = files
    .filter((f) => !/\.pyi$/i.test(f.rel))
    .map((f) => ({ abs: f.abs, rel: f.rel, lang: (/\.py$/i.test(f.rel) ? 'python' : graph.files.find((x) => x.path === f.rel)?.lang === 'c' ? 'c' : 'cpp') as 'c' | 'cpp' | 'python' }));
  const t0 = Date.now();
  const workDir = path.join(os.tmpdir(), `code-graph-run-${process.pid}`);
  let r: Omit<RunResult, 'stage'>;
  let label: string;
  if (compose) {
    const composeFile = compose === true ? findComposeFile(root) : path.resolve(compose);
    if (!composeFile) {
      pool.dispose();
      throw new Error(`no compose file in ${root}`);
    }
    label = path.relative(root, composeFile) || composeFile;
    r = await runComposeTrace({
      root,
      graph,
      files: fileList,
      composeFile,
      services,
      runtimeDir: path.join(__dirname, 'runtime'),
      workDir,
      parsers: () => loadParsers(path.join(__dirname, 'wasm')),
      timeoutMs: timeout * 1000,
      startTimeoutMs: 600_000,
      maxEvents,
      values,
      log: (l) => console.error(l),
    });
  } else {
    const entries = findEntries(graph);
    const entry = entryArg ? entries.find((e) => e.file === entryArg || e.label.includes(entryArg!)) : entries[0];
    if (!entry) {
      pool.dispose();
      throw new Error(`no entry point${entryArg ? ` matching ${entryArg}` : ''}; found: ${entries.map((e) => e.label).join(', ') || 'none'}`);
    }
    const compileCommands = loadCompileCommands(root);
    const built = entry.kind === 'native' ? targetsFor((await readBuildTargets(root, { compileCommands })).targets, path.join(root, ...entry.file.split('/'))) : [];
    const target = targetArg ? built.find((t) => t.name === targetArg) : built[0];
    if (targetArg && !target) throw new Error(`no program "${targetArg}" is built from ${entry.file}; found: ${built.map((t) => t.name).join(', ') || 'none'}`);
    if (!targetArg && built.length > 1) console.error(`note: ${entry.file} goes into ${built.map((t) => t.name).join(', ')} — running ${target!.name} (--target to choose)`);
    label = target ? `${entry.label} · ${target.name}` : entry.label;
    r = await runAndTrace({
      root,
      graph,
      files: fileList,
      entry,
      args: progArgs,
      toolchain: detectToolchain({ cc: process.env.CC, cxx: process.env.CXX }),
      includePaths: session.includePaths,
      compileCommands,
      buildFlags: [],
      linkFlags: [],
      target,
      runtimeDir: path.join(__dirname, 'runtime'),
      workDir,
      parsers: () => loadParsers(path.join(__dirname, 'wasm')),
      timeoutMs: timeout * 1000,
      maxEvents,
      values,
      log: (l) => console.error(l),
    });
  }
  pool.dispose();
  fs.rmSync(workDir, { recursive: true, force: true });
  for (const n of r.notes) console.error('note:', n);
  for (const d of [...r.buildDiagnostics, ...r.runtimeDiagnostics]) console.error(`  ${d.file}:${d.line}: ${d.source} ${d.severity}: ${d.message}`);
  if (r.trace) {
    const tr = r.trace;
    console.error(
      `${label}: exit ${tr.exit.code ?? tr.exit.signal ?? '?'}${tr.exit.crash ? ` (${tr.exit.crash})` : ''}${tr.procs ? ` · ${tr.procs.length} processes` : ''} · ${tr.threads.length} threads · ${tr.spans.t.length} calls · ` +
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
