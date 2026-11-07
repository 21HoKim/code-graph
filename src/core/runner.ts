/**
 * Run & Trace: build (C/C++), run with the runtime tracer, parse the trace.
 *
 *   Python  python cg_tracer.py --root R --out T script.py args…   (no build step)
 *   C/C++   copy + instrument sources → compile every needed translation unit with
 *           -include cg_trace.h → link with the runtime → run with CODE_GRAPH_TRACE=T
 *
 * Build errors (compiler, linker) and runtime failures (uncaught exceptions,
 * crashes) come back as diagnostics, so they show up red on the circuit like
 * compile-check errors. Node-only; used by the extension host and the CLI.
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Parsers } from './extract';
import { instrumentSources } from './instrument';
import type { CodeGraph, Diagnostic, Entity } from './model';
import { parseTrace, traceDiagnostics, type RunTrace, type TraceFn } from './trace';
import { diagFlags, parseCompilerOutput, parseLinkerErrors, run, type CompileCommand, type Toolchain } from './verify';

export interface EntryPoint {
  kind: 'python' | 'native';
  /** Workspace-relative file (Python script / file that defines main). */
  file: string;
  /** Entity id of `main` (native) or of the module (Python). */
  entity?: string;
  /** Python package run with -m (a package's __main__.py). */
  module?: string;
  label: string;
}

export interface RunInput {
  root: string;
  graph: CodeGraph;
  files: { abs: string; rel: string; lang: 'c' | 'cpp' | 'python' }[];
  entry: EntryPoint;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  toolchain: Toolchain;
  includePaths: string[];
  compileCommands?: CompileCommand[];
  buildFlags: string[];
  linkFlags: string[];
  /** Directory holding python/cg_tracer.py and c/cg_trace.{h,c} + c/cg_trace_cxx.cpp. */
  runtimeDir: string;
  /** Scratch directory for the instrumented build and the trace (wiped). */
  workDir: string;
  parsers: () => Promise<Parsers>;
  timeoutMs: number;
  maxEvents: number;
  values: boolean;
  signal?: AbortSignal;
  onStage?: (stage: 'build' | 'run' | 'trace', message?: string, done?: number, total?: number) => void;
  log?: (line: string) => void;
}

export interface RunResult {
  /** A trace was produced (the program may still have failed — see trace.exit). */
  ok: boolean;
  stage: 'build' | 'run' | 'done';
  trace?: RunTrace;
  buildDiagnostics: Diagnostic[];
  runtimeDiagnostics: Diagnostic[];
  notes: string[];
  output: string;
  command: string;
}

const TU = /\.(c|cc|cpp|cxx|c\+\+)$/i;
const OUTPUT_MAX = 64 * 1024;

/** Programs CodeGraph can start: C/C++ `main` functions and Python scripts with a __main__ guard. */
export function findEntries(g: CodeGraph): EntryPoint[] {
  const out: EntryPoint[] = [];
  for (const e of g.entities) {
    if (e.kind === 'function' && e.lang !== 'python' && /^(main|wmain)$/.test(e.name) && e.def && !e.parent) {
      out.push({ kind: 'native', file: e.def.file, entity: e.id, label: `${e.def.file} · main()` });
    }
  }
  for (const e of g.entities) {
    if (e.lang !== 'python' || !e.flags?.includes('entry')) continue;
    const file = (e.def ?? e.decl)?.file;
    if (!file) continue;
    if (/(^|\/)__main__\.py$/.test(file) && file.includes('/')) {
      const pkg = file.split('/').slice(0, -1).join('.');
      out.push({ kind: 'python', file, entity: e.id, module: pkg, label: `python -m ${pkg}` });
    } else out.push({ kind: 'python', file, entity: e.id, label: `python ${file}` });
  }
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x.label) ? false : (seen.add(x.label), true)));
}

export async function runAndTrace(o: RunInput): Promise<RunResult> {
  fs.rmSync(o.workDir, { recursive: true, force: true });
  fs.mkdirSync(o.workDir, { recursive: true });
  const traceFile = path.join(o.workDir, 'trace.jsonl');
  const notes: string[] = [];
  let fns: TraceFn[] | undefined;
  let cmd: string;
  let args: string[];
  const env: NodeJS.ProcessEnv = { ...process.env, ...(o.env ?? {}) };

  if (o.entry.kind === 'python') {
    if (!o.toolchain.python) return fail('build', 'No Python 3 interpreter found (set codeGraph.verify.python).');
    cmd = o.toolchain.python;
    const tracer = path.join(o.runtimeDir, 'python', 'cg_tracer.py');
    args = ['-X', 'utf8', tracer, '--root', o.root, '--out', traceFile, '--max-events', String(o.maxEvents), '--values', o.values ? '1' : '0'];
    if (o.entry.module) args.push('--module', o.entry.module);
    else args.push(path.join(o.root, ...o.entry.file.split('/')));
    args.push(...o.args);
    env.PYTHONUNBUFFERED = '1';
  } else {
    o.onStage?.('build', 'instrumenting');
    const b = await buildNative(o);
    notes.push(...b.notes);
    if (!b.exe) return { ok: false, stage: 'build', buildDiagnostics: b.diagnostics, runtimeDiagnostics: [], notes, output: b.log, command: '' };
    fns = b.fns;
    cmd = b.exe;
    args = [...o.args];
    env.CODE_GRAPH_TRACE = traceFile;
    env.CODE_GRAPH_MAX_EVENTS = String(o.maxEvents);
    env.CODE_GRAPH_VALUES = o.values ? '1' : '0';
  }

  const command = [o.entry.kind === 'python' ? (o.entry.module ? `python -m ${o.entry.module}` : `python ${o.entry.file}`) : `${o.entry.file} ▸ ./${path.basename(cmd)}`, ...o.args].join(' ');
  o.onStage?.('run', command);
  o.log?.(`$ ${command}`);
  const started = new Date().toISOString();
  const cwd = o.cwd ? path.resolve(o.root, o.cwd) : o.root;
  const r = await runProgram(cmd, args, { cwd, env, timeoutMs: o.timeoutMs, signal: o.signal });
  const output = r.output;
  if (r.error) return fail('run', `could not start ${cmd}: ${r.error}`, output);
  if (r.timedOut) notes.push(`stopped after ${Math.round(o.timeoutMs / 1000)} s (codeGraph.run.timeoutSeconds)`);

  o.onStage?.('trace');
  let text = '';
  try {
    text = fs.readFileSync(traceFile, 'utf8');
  } catch {
    return fail('run', `the program exited (${r.signal ?? r.code}) without writing a trace`, output);
  }
  const trace = parseTrace(text, o.graph, {
    fns,
    command,
    started,
    output,
    exit: { code: r.code, signal: r.signal ?? undefined, timedOut: r.timedOut },
  });
  if (o.entry.kind === 'python' && trace.exit.code === null && r.code !== null) trace.exit.code = r.code;
  const runtimeDiagnostics = traceDiagnostics(trace, o.graph);
  if (trace.truncated) notes.push(`recorded the first ${o.maxEvents.toLocaleString('en')} events in detail; counts cover the whole run`);
  return { ok: true, stage: 'done', trace, buildDiagnostics: [], runtimeDiagnostics, notes, output, command };

  function fail(stage: 'build' | 'run', msg: string, out = ''): RunResult {
    notes.push(msg);
    return { ok: false, stage, buildDiagnostics: [], runtimeDiagnostics: [], notes, output: out, command: '' };
  }
}

// ---------------------------------------------------------------------------
// native build
// ---------------------------------------------------------------------------

interface NativeBuild {
  exe?: string;
  fns: TraceFn[];
  diagnostics: Diagnostic[];
  notes: string[];
  log: string;
}

async function buildNative(o: RunInput): Promise<NativeBuild> {
  const tc = o.toolchain;
  const notes: string[] = [];
  const diagnostics: Diagnostic[] = [];
  let log = '';
  const srcDir = path.join(o.workDir, 'src');
  const objDir = path.join(o.workDir, 'obj');
  fs.mkdirSync(objDir, { recursive: true });
  const main = o.graph.entities.find((e) => e.id === o.entry.entity);
  if (!main) return { fns: [], diagnostics, notes: ['entry point not found — re-analyze the workspace'], log };

  const native = o.files.filter((f): f is { abs: string; rel: string; lang: 'c' | 'cpp' } => f.lang !== 'python');
  const parsers = await o.parsers();
  const inst = instrumentSources({ files: native, outDir: srcDir, graph: o.graph, parsers });
  o.log?.(`instrumented ${inst.fns.length} functions in ${inst.instrumented} files${inst.skipped.length ? ` (${inst.skipped.length} skipped)` : ''}`);

  const byRel = new Map(native.map((f) => [f.rel, f]));
  let units = selectUnits(o.graph, main, native);
  const ccdb = new Map((o.compileCommands ?? []).map((c) => [path.normalize(c.file), c]));
  const rt = path.join(o.runtimeDir, 'c');
  const hdr = path.join(rt, 'cg_trace.h');
  const relOf = (abs: string): string | undefined => {
    for (const base of [srcDir, o.root]) {
      const rel = path.relative(base, abs).split(path.sep).join('/');
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
    }
    return undefined;
  };
  const objects = new Map<string, string>();

  const compile = async (rel: string, instrumented = true): Promise<boolean> => {
    const f = byRel.get(rel)!;
    const cpp = f.lang === 'cpp';
    const obj = path.join(objDir, `${objects.size}-${path.basename(rel).replace(/\W/g, '_')}.o`);
    const src = instrumented ? path.join(srcDir, ...rel.split('/')) : f.abs;
    const entry = ccdb.get(path.normalize(f.abs));
    let cmd = cpp ? tc.cxx : tc.cc;
    let args: string[];
    let cwd = o.root;
    if (entry && entry.args.length) {
      cmd = entry.args[0];
      cwd = entry.directory;
      args = fromCompileCommand(entry, src, obj, o.root, instrumented ? srcDir : undefined);
    } else {
      args = [
        '-c',
        src,
        '-o',
        obj,
        cpp ? '-std=c++17' : '-std=gnu11',
        '-g',
        '-O0',
        ...diagFlags(cpp ? tc.cxxKind : tc.ccKind),
        ...o.includePaths.flatMap((d) => [...(instrumented ? ['-I' + path.join(srcDir, d)] : []), '-I' + path.join(o.root, d)]),
        '-iquote',
        path.dirname(f.abs),
      ];
    }
    if (!cmd) {
      notes.push(`no ${cpp ? 'C++' : 'C'} compiler found (set codeGraph.verify.${cpp ? 'cxx' : 'cc'})`);
      return false;
    }
    if (instrumented) args.push('-include', hdr);
    args.push(...o.buildFlags);
    const r = await run(cmd, args, { cwd, timeoutMs: 180_000, signal: o.signal });
    if (r.error) {
      notes.push(`${path.basename(cmd)}: ${r.error}`);
      return false;
    }
    if (r.code !== 0) {
      log += `$ ${cmd} ${args.join(' ')}\n${r.stderr}\n`;
      if (instrumented) {
        // never let a probe break the build: retry this unit untouched (it just won't be traced)
        const ok = await compile(rel, false);
        if (ok) {
          notes.push(`${rel}: built without probes (the instrumented copy did not compile)`);
          return true;
        }
      }
      const parsed = parseCompilerOutput(r.stderr + '\n' + r.stdout, cwd, o.root, 'compiler', relOf);
      diagnostics.push(...parsed.diags);
      if (!parsed.diags.length) diagnostics.push({ file: rel, line: 1, severity: 'error', source: 'compiler', message: (r.stderr.trim().split('\n')[0] ?? 'compile failed').slice(0, 300) });
      return false;
    }
    objects.set(rel, obj);
    return true;
  };

  const compileAll = async (list: string[]): Promise<boolean> => {
    const queue = list.filter((u) => !objects.has(u));
    let done = 0;
    let ok = true;
    const workers = Math.max(1, Math.min(os.cpus().length, 8));
    await Promise.all(
      Array.from({ length: Math.min(workers, queue.length) }, async () => {
        while (queue.length && !o.signal?.aborted) {
          const u = queue.shift()!;
          if (!(await compile(u))) ok = false;
          o.onStage?.('build', u, ++done, list.length);
        }
      }),
    );
    return ok && !o.signal?.aborted;
  };

  if (!(await compileAll(units))) return { fns: inst.fns, diagnostics: dedupe(diagnostics), notes, log };

  // runtime
  const anyCpp = [...objects.keys()].some((u) => byRel.get(u)?.lang === 'cpp');
  const rtObjs: string[] = [];
  const cc = tc.cc ?? tc.cxx;
  if (!cc) return { fns: inst.fns, diagnostics, notes: [...notes, 'no C compiler found for the tracer runtime'], log };
  const rtC = path.join(objDir, 'cg_trace.o');
  let r = await run(
    cc,
    [...(cc === tc.cxx && !tc.cc ? ['-x', 'c'] : []), '-O2', '-c', path.join(rt, 'cg_trace.c'), '-o', rtC, `-DCGT_NFN=${Math.max(1, inst.fns.length)}`, ...(anyCpp ? ['-DCGT_LANG_CPP'] : [])],
    { cwd: o.workDir, timeoutMs: 120_000, signal: o.signal },
  );
  if (r.code !== 0) return { fns: inst.fns, diagnostics, notes: [...notes, `tracer runtime did not compile: ${r.stderr.split('\n')[0]}`], log: log + r.stderr };
  rtObjs.push(rtC);
  if (anyCpp && tc.cxx) {
    const rtX = path.join(objDir, 'cg_trace_cxx.o');
    r = await run(tc.cxx, ['-O2', '-std=c++11', '-c', path.join(rt, 'cg_trace_cxx.cpp'), '-o', rtX], { cwd: o.workDir, timeoutMs: 120_000, signal: o.signal });
    if (r.code === 0) rtObjs.push(rtX);
  }

  // link (one retry: pull in units that define what the linker misses)
  const linker = anyCpp ? tc.cxx : tc.cc;
  if (!linker) return { fns: inst.fns, diagnostics, notes: [...notes, 'no linker'], log };
  const stem = path.basename(o.entry.file).replace(/\.[^.]+$/, '').replace(/[^\w.-]/g, '_') || 'program';
  const exe = path.join(o.workDir, process.platform === 'win32' ? `${stem}.exe` : stem);
  for (let attempt = 0; attempt < 2; attempt++) {
    const linkArgs = [...objects.values(), ...rtObjs, '-o', exe, ...(process.platform === 'win32' ? [] : ['-pthread']), ...o.linkFlags];
    if ([...objects.keys()].some((u) => byRel.get(u)?.lang === 'c')) linkArgs.push('-lm');
    r = await run(linker, linkArgs, { cwd: o.workDir, timeoutMs: 180_000, signal: o.signal });
    if (r.code === 0) return { exe, fns: inst.fns, diagnostics, notes, log };
    log += `$ ${linker} ${linkArgs.join(' ')}\n${r.stderr}\n`;
    const missing = parseLinkerErrors(r.stderr + r.stdout);
    const extra = attempt === 0 ? unitsDefining(o.graph, missing, byRel).filter((u) => !objects.has(u)) : [];
    if (extra.length) {
      o.log?.(`link: adding ${extra.join(', ')}`);
      units = [...units, ...extra];
      if (await compileAll(extra)) continue;
    }
    diagnostics.push(...linkerDiagnostics(o.graph, missing, r.stderr));
    break;
  }
  return { fns: inst.fns, diagnostics: dedupe(diagnostics), notes, log };
}

/** Translation units needed by `main`: its own file plus every unit defining something it (transitively) uses. */
export function selectUnits(g: CodeGraph, main: Entity, files: { rel: string }[]): string[] {
  const tus = new Set(files.map((f) => f.rel).filter((r) => TU.test(r)));
  const defFile = new Map<string, string>();
  const methodsOf = new Map<string, string[]>();
  const otherMains = new Set<string>();
  for (const e of g.entities) {
    if (e.def && tus.has(e.def.file)) defFile.set(e.id, e.def.file);
    if (e.parent && e.kind === 'function' && e.def) (methodsOf.get(e.parent) ?? methodsOf.set(e.parent, []).get(e.parent)!).push(e.def.file);
    if (e.kind === 'function' && /^(main|wmain)$/.test(e.name) && e.def && e.id !== main.id) otherMains.add(e.def.file);
  }
  const fileOf = (id: string) => g.entities.find((e) => e.id === id)?.def?.file;
  const deps = new Map<string, Set<string>>();
  const add = (a: string | undefined, b: string | undefined) => {
    if (!a || !b || a === b || !tus.has(b)) return;
    (deps.get(a) ?? deps.set(a, new Set()).get(a)!).add(b);
  };
  const fromFile = new Map<string, string | undefined>();
  for (const r of g.relations) {
    if (r.conf === 'guess' || (r.kind !== 'call' && r.kind !== 'spawn' && r.kind !== 'instantiate' && r.kind !== 'inherit')) continue;
    let a = fromFile.get(r.from);
    if (a === undefined && !fromFile.has(r.from)) fromFile.set(r.from, (a = fileOf(r.from)));
    add(a, defFile.get(r.to));
    // using a class needs the units that implement its methods
    if (r.kind === 'instantiate' || r.kind === 'inherit') for (const f of methodsOf.get(r.to) ?? []) add(a, f);
  }
  const start = main.def!.file;
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const f = stack.pop()!;
    for (const d of deps.get(f) ?? []) {
      if (seen.has(d) || otherMains.has(d)) continue;
      seen.add(d);
      stack.push(d);
    }
  }
  return [...seen].filter((f) => tus.has(f));
}

function unitsDefining(g: CodeGraph, symbols: string[], byRel: Map<string, unknown>): string[] {
  const out = new Set<string>();
  for (const s of symbols) {
    const q = s.replace(/\(.*$/, '').trim();
    for (const e of g.entities) if (e.def && (e.qname === q || e.name === q) && byRel.has(e.def.file) && TU.test(e.def.file)) out.add(e.def.file);
  }
  return [...out];
}

function linkerDiagnostics(g: CodeGraph, symbols: string[], stderr: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const s of symbols) {
    const q = s.replace(/\(.*$/, '').trim();
    const e = g.entities.find((x) => x.kind === 'function' && (x.qname === q || (x.name === q && !x.qname.includes('::'))));
    const loc = e?.decl ?? e?.def;
    if (loc) out.push({ file: loc.file, line: loc.line, severity: 'error', source: 'linker', message: `undefined reference to '${s}'`, target: e!.id });
  }
  if (!out.length) {
    const first = stderr.split('\n').find((l) => /error|undefined/i.test(l));
    if (first) out.push({ file: '', line: 1, severity: 'error', source: 'linker', message: first.trim().slice(0, 300) });
  }
  return out.filter((d) => d.file);
}

/** Reuse a compile_commands.json entry for the instrumented copy: same flags, our source, our object. */
function fromCompileCommand(entry: CompileCommand, src: string, obj: string, root: string, copyRoot?: string): string[] {
  const out: string[] = [];
  const a = entry.args;
  const inRoot = (d: string) => {
    const rel = path.relative(root, d);
    return !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : undefined;
  };
  const pushInclude = (flag: string, dir: string) => {
    const abs = path.resolve(entry.directory, dir);
    const rel = copyRoot ? inRoot(abs) : undefined;
    if (rel !== undefined) out.push(flag + path.join(copyRoot!, rel));
    out.push(flag + abs);
  };
  for (let i = 1; i < a.length; i++) {
    const x = a[i];
    if (x === '-o' || x === '-MF' || x === '-MT' || x === '-MQ') {
      i++;
      continue;
    }
    if (x === '-c' || /^-M{1,2}D?$/.test(x) || x === '-MP' || (/^-o[./\w]/.test(x) && !/^-o(bjc|penmp)/.test(x))) continue;
    if (path.resolve(entry.directory, x) === entry.file) continue;
    if (x === '-I' || x === '-iquote') {
      pushInclude(x === '-I' ? '-I' : '-iquote', a[++i] ?? '');
      continue;
    }
    if (x.startsWith('-I') && x.length > 2) {
      pushInclude('-I', x.slice(2));
      continue;
    }
    out.push(x);
  }
  out.push('-c', src, '-o', obj, '-iquote', path.dirname(entry.file));
  return out;
}

function dedupe(d: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return d.filter((x) => {
    const k = `${x.file}:${x.line}:${x.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Run the traced program: no stdin, output captured (tail), SIGTERM at the time limit then SIGKILL. */
export function runProgram(
  cmd: string,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number | null; signal: string | null; timedOut: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ code: null, signal: null, timedOut, output, error: String(e) });
      return;
    }
    const take = (d: Buffer) => {
      output += d.toString();
      if (output.length > OUTPUT_MAX * 2) output = output.slice(-OUTPUT_MAX);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    let killer: NodeJS.Timeout | undefined;
    const stop = () => {
      child.kill('SIGTERM');
      killer = setTimeout(() => child.kill('SIGKILL'), 2500);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, o.timeoutMs);
    o.signal?.addEventListener('abort', stop);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut, output, error: String(e) });
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      o.signal?.removeEventListener('abort', stop);
      resolve({ code, signal: sig, timedOut, output: output.length > OUTPUT_MAX ? '…' + output.slice(-OUTPUT_MAX) : output });
    });
  });
}
