/**
 * Build verification with the real toolchain.
 *
 *   C / C++  every translation unit with `cc/c++ -fsyntax-only` — flags from compile_commands.json when the
 *            project has one, otherwise -std defaults + the include paths CodeCurrent discovered
 *   Python   compile() of every file in one interpreter (+ pyflakes undefined names, if installed)
 *
 * Diagnostics come back with workspace-relative paths; health.ts turns them into the red overlay.
 * Node-only (child_process).
 */
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Diagnostic } from './model';

export interface Toolchain {
  cc?: string;
  cxx?: string;
  python?: string;
  ccKind?: 'gcc' | 'clang';
  cxxKind?: 'gcc' | 'clang';
}

export interface CompileCommand {
  file: string;
  directory: string;
  args: string[];
}

export interface VerifyInput {
  root: string;
  files: { abs: string; rel: string; lang: 'c' | 'cpp' | 'python' }[];
  includePaths: string[];
  toolchain: Toolchain;
  compileCommands?: CompileCommand[];
  extraFlags?: string[];
  concurrency?: number;
  timeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  /** Absolute path → graph path (multi-root workspaces prefix the folder name). Default: relative to root. */
  relOf?: (abs: string) => string | undefined;
}

export interface VerifyResult {
  diagnostics: Diagnostic[];
  /** Diagnostics per checked unit (translation unit or Python file) — lets callers re-check a few units after a save. */
  units: Map<string, Diagnostic[]>;
  checkedC: number;
  checkedPython: number;
  cChecked: boolean;
  pyChecked: boolean;
  notes: string[];
  ms: number;
}

const TU = /\.(c|cc|cpp|cxx|c\+\+)$/i;

function probe(cmd: string): string | undefined {
  try {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    return r.status === 0 ? `${r.stdout ?? ''}${r.stderr ?? ''}` : undefined;
  } catch {
    return undefined;
  }
}

/** Find a C compiler, a C++ compiler and Python 3 (user settings first). */
export function detectToolchain(pref: { cc?: string; cxx?: string; python?: string } = {}): Toolchain {
  const pick = (cands: (string | undefined)[]) => {
    for (const c of cands) {
      if (!c) continue;
      const out = probe(c);
      if (out) return { cmd: c, kind: (/clang/i.test(out) ? 'clang' : 'gcc') as 'gcc' | 'clang' };
    }
    return undefined;
  };
  const cxx = pick([pref.cxx, 'g++', 'clang++', 'c++']);
  const cc = pick([pref.cc, 'gcc', 'clang', 'cc']);
  let python: string | undefined;
  for (const c of [pref.python, 'python3', 'python']) {
    if (c && /Python 3/.test(probe(c) ?? '')) {
      python = c;
      break;
    }
  }
  return { cc: cc?.cmd, ccKind: cc?.kind, cxx: cxx?.cmd, cxxKind: cxx?.kind, python };
}

/** Split a shell command line (compile_commands "command") into arguments. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

export function loadCompileCommands(root: string): CompileCommand[] | undefined {
  const candidates = ['compile_commands.json', 'build/compile_commands.json', 'out/compile_commands.json'];
  try {
    for (const d of fs.readdirSync(root)) if (d.startsWith('cmake-build-')) candidates.push(`${d}/compile_commands.json`);
  } catch {
    /* ignore */
  }
  for (const c of candidates) {
    const p = path.join(root, c);
    if (!fs.existsSync(p)) continue;
    try {
      const db = JSON.parse(fs.readFileSync(p, 'utf8')) as { directory: string; file: string; command?: string; arguments?: string[] }[];
      return db.map((e) => ({
        directory: e.directory,
        file: path.resolve(e.directory, e.file),
        args: e.arguments ?? splitCommand(e.command ?? ''),
      }));
    } catch {
      /* malformed */
    }
  }
  return undefined;
}

/** Turn a real compile command into a syntax-only check. */
export function syntaxOnly(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '-MF' || a === '-MT' || a === '-MQ') {
      i++;
      continue;
    }
    if (a === '-c' || /^-M{1,2}D?$/.test(a) || a === '-MP' || /^-o[./\w]/.test(a) && !/^-o(bjc|penmp)/.test(a)) continue;
    out.push(a);
  }
  out.push('-fsyntax-only');
  return out;
}

const DIAG = /^((?:[A-Za-z]:)?[^:\n]+):(\d+):(?:(\d+):)?\s+(fatal error|error|warning):\s+(.*)$/;

function relTo(root: string): (abs: string) => string | undefined {
  return (abs) => {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    return rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel;
  };
}

/** gcc / clang diagnostics → workspace-relative Diagnostics. */
export function parseCompilerOutput(
  text: string,
  cwd: string,
  root: string,
  source: Diagnostic['source'] = 'compiler',
  relOf: (abs: string) => string | undefined = relTo(root),
): { diags: Diagnostic[]; outside: number } {
  const diags: Diagnostic[] = [];
  let outside = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = DIAG.exec(line.trim());
    if (!m) continue;
    const rel = relOf(path.resolve(cwd, m[1]));
    if (!rel) {
      outside++;
      continue;
    }
    diags.push({
      file: rel,
      line: Number(m[2]),
      col: m[3] ? Number(m[3]) : undefined,
      severity: m[4] === 'warning' ? 'warning' : 'error',
      source,
      message: m[5].trim(),
    });
  }
  return { diags, outside };
}

/** GNU ld / lld / ld64 undefined symbols. */
export function parseLinkerErrors(text: string): string[] {
  const syms = new Set<string>();
  for (const m of text.matchAll(/undefined reference to [`'‘]([^'’`]+)['’`]/g)) syms.add(m[1]);
  for (const m of text.matchAll(/undefined symbol: (.+)$/gm)) syms.add(m[1].trim());
  for (const m of text.matchAll(/^\s*"(.+?)", referenced from:/gm)) syms.add(m[1].replace(/^_/, ''));
  return [...syms];
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; input?: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env: opts.env ?? process.env });
    } catch (e) {
      resolve({ code: null, stdout, stderr, timedOut, error: String(e) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    const abort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', abort);
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 4_000_000) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4_000_000) stderr += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, error: String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export function diagFlags(kind: 'gcc' | 'clang' | undefined): string[] {
  return kind === 'clang' ? ['-fno-color-diagnostics', '-ferror-limit=8'] : ['-fdiagnostics-color=never', '-fmax-errors=8'];
}

const PY_CHECK = String.raw`
import sys, json
paths = sys.stdin.read().split('\0')
try:
    from pyflakes import api as _api, messages as _M
    class _R:
        def __init__(self): self.out = []
        def unexpectedError(self, *a): pass
        def syntaxError(self, *a): pass
        def flake(self, m): self.out.append(m)
    _KINDS = (_M.UndefinedName, _M.UndefinedLocal, _M.UndefinedExport)
except Exception:
    _api = None
for p in paths:
    if not p: continue
    try:
        src = open(p, 'rb').read()
    except OSError:
        continue
    try:
        compile(src, p, 'exec', dont_inherit=True)
    except SyntaxError as e:
        print(json.dumps({'file': p, 'line': e.lineno or 1, 'col': e.offset or 0, 'msg': type(e).__name__ + ': ' + str(e.msg)}))
        continue
    except ValueError as e:
        print(json.dumps({'file': p, 'line': 1, 'col': 0, 'msg': 'ValueError: ' + str(e)}))
        continue
    if _api is not None:
        r = _R()
        try:
            _api.check(src.decode('utf-8', 'replace'), p, r)
        except Exception:
            pass
        for m in r.out:
            if isinstance(m, _KINDS):
                print(json.dumps({'file': p, 'line': m.lineno, 'col': getattr(m, 'col', 0) + 1, 'msg': (m.message % m.message_args) + ' (pyflakes)'}))
`;

export async function verifyWorkspace(o: VerifyInput): Promise<VerifyResult> {
  const t0 = Date.now();
  const diags: Diagnostic[] = [];
  const units = new Map<string, Diagnostic[]>();
  const relOf = o.relOf ?? relTo(o.root);
  const notes: string[] = [];
  const tus = o.files.filter((f) => f.lang !== 'python' && TU.test(f.abs));
  const pys = o.files.filter((f) => f.lang === 'python');
  const total = tus.length + (pys.length ? 1 : 0);
  let done = 0;
  const tick = () => o.onProgress?.(++done, total);
  const timeoutMs = o.timeoutMs ?? 60_000;
  const tc = o.toolchain;
  const ccdb = new Map((o.compileCommands ?? []).map((c) => [path.normalize(c.file), c]));
  let cChecked = false;
  let checkedC = 0;

  // --- C / C++ ---------------------------------------------------------
  const needsC = tus.some((f) => f.lang === 'c');
  const needsCxx = tus.some((f) => f.lang === 'cpp');
  if (tus.length && ((needsC && !tc.cc) || (needsCxx && !tc.cxx)) && !ccdb.size) {
    notes.push(`no ${needsCxx && !tc.cxx ? 'C++' : 'C'} compiler found (set codeCurrent.verify.cc / cxx)`);
  }
  const queue = [...tus];
  const workers = Math.max(1, Math.min(o.concurrency ?? Math.max(1, os.cpus().length), 8));
  let outsideTotal = 0;
  const one = async (f: (typeof tus)[number]) => {
    const entry = ccdb.get(path.normalize(f.abs));
    let cmd: string | undefined;
    let args: string[];
    let cwd = o.root;
    if (entry && entry.args.length) {
      cmd = entry.args[0];
      args = [...syntaxOnly(entry.args), ...(o.extraFlags ?? [])];
      cwd = entry.directory;
    } else {
      const cpp = f.lang === 'cpp';
      cmd = cpp ? tc.cxx : tc.cc;
      args = [
        '-fsyntax-only',
        cpp ? '-std=c++17' : '-std=gnu11',
        ...diagFlags(cpp ? tc.cxxKind : tc.ccKind),
        ...(o.extraFlags ?? []),
        ...o.includePaths.map((d) => '-I' + path.join(o.root, d)),
        '-I' + path.dirname(f.abs),
        f.abs,
      ];
    }
    if (!cmd) return;
    const r = await run(cmd, args, { cwd, timeoutMs, signal: o.signal });
    if (r.error) {
      notes.push(`${path.basename(cmd)}: ${r.error}`);
      return;
    }
    cChecked = true;
    checkedC++;
    const mine: Diagnostic[] = [];
    units.set(f.rel, mine);
    if (r.timedOut) {
      mine.push({ file: f.rel, line: 1, severity: 'warning', source: 'compiler', message: `compile check timed out after ${Math.round(timeoutMs / 1000)} s` });
      diags.push(...mine);
      return;
    }
    const parsed = parseCompilerOutput(r.stderr + '\n' + r.stdout, cwd, o.root, 'compiler', relOf);
    mine.push(...parsed.diags);
    outsideTotal += parsed.outside;
    if (r.code !== 0 && !parsed.diags.some((d) => d.severity === 'error')) {
      // failed only because of headers outside the workspace (or an unknown flag)
      const first = (r.stderr.split('\n').find((l) => /error/.test(l)) ?? r.stderr.split('\n')[0] ?? '').trim();
      mine.push({ file: f.rel, line: 1, severity: 'error', source: 'compiler', message: first.slice(0, 300) || `${path.basename(cmd)} exited with ${r.code}` });
    }
    diags.push(...mine);
  };
  await Promise.all(
    Array.from({ length: Math.min(workers, queue.length) }, async () => {
      while (queue.length && !o.signal?.aborted) {
        await one(queue.shift()!);
        tick();
      }
    }),
  );
  if (outsideTotal) notes.push(`${outsideTotal} diagnostics in files outside the workspace were ignored`);

  // --- Python ----------------------------------------------------------
  let pyChecked = false;
  if (pys.length && tc.python && !o.signal?.aborted) {
    const byAbs = new Map(pys.map((f) => [f.abs, f.rel]));
    const r = await run(tc.python, ['-I', '-c', PY_CHECK], { cwd: o.root, timeoutMs: Math.max(timeoutMs, 120_000), signal: o.signal, input: pys.map((f) => f.abs).join('\0') });
    if (r.error) notes.push(`python: ${r.error}`);
    else {
      pyChecked = r.code === 0;
      if (pyChecked) for (const f of pys) units.set(f.rel, []);
      for (const line of r.stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line) as { file: string; line: number; col: number; msg: string };
          const file = byAbs.get(j.file) ?? relOf(j.file) ?? j.file;
          const d: Diagnostic = { file, line: j.line, col: j.col || undefined, severity: 'error', source: 'python', message: j.msg };
          diags.push(d);
          (units.get(file) ?? units.set(file, []).get(file)!).push(d);
        } catch {
          /* ignore noise */
        }
      }
      if (r.code !== 0) notes.push(`python check failed: ${r.stderr.split('\n').slice(-3).join(' ').trim()}`);
    }
    tick();
  } else if (pys.length && !tc.python) notes.push('no Python 3 interpreter found (set codeCurrent.verify.python)');

  // the same header error reported by several translation units
  const seen = new Set<string>();
  const unique = diags.filter((d) => {
    const k = `${d.file}:${d.line}:${d.col ?? 0}:${d.severity}:${d.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { diagnostics: unique, units, checkedC, checkedPython: pyChecked ? pys.length : 0, cChecked, pyChecked, notes, ms: Date.now() - t0 };
}
