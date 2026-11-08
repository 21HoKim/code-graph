/**
 * Run & Trace with Docker Compose: the project's own containers, network and build, traced.
 *
 * Programs that talk to each other (a client and its server, nodes of a protocol) only run
 * together, often only inside the network their compose file sets up. This runs that compose
 * project with an override instead of a separate setup:
 *
 *   1. copy the workspace (the folder services mount, e.g. `- ./:/app`) and put probes into the
 *      C/C++ sources of the copy — the workspace itself is never touched
 *   2. mount the copy where the workspace was mounted, plus /codegraph: the tracer runtime,
 *      compiler shims and a trace folder
 *   3. start each traced service with /codegraph/bin first on PATH: its own command (make, cmake,
 *      a shell script…) then calls gcc / g++ / cc / c++ / clang through the shims, which add the
 *      tracer header to every compile and the runtime to every program it links
 *   4. every traced process writes /codegraph/trace/<service>/<pid>.jsonl; when the programs end
 *      (or after the time limit) the project is stopped and taken down, and the traces are merged
 *      into one timeline, threads named after their container
 *
 * Needs the docker CLI with Compose v2 on the machine VS Code runs on. Node-only; no vscode import.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Parsers } from './extract';
import { instrumentSources } from './instrument';
import type { CodeGraph, Diagnostic } from './model';
import { mergeTraces, parseTrace, traceDiagnostics, type RunTrace } from './trace';
import { parseCompilerOutput, run } from './verify';

export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const MOUNT = '/codegraph';
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.cache']);

export interface ComposeVolume {
  type: string;
  source?: string;
  target: string;
  read_only?: boolean;
}

export interface ComposeService {
  image?: string;
  build?: unknown;
  command?: string[] | null;
  entrypoint?: string[] | null;
  working_dir?: string;
  volumes?: ComposeVolume[];
  environment?: Record<string, string | null>;
}

export interface ComposeProject {
  name: string;
  services: Record<string, ComposeService>;
}

export interface TracedService {
  name: string;
  /** Bind mounts of the workspace (or folders in it): host folder relative to the workspace → container path. */
  mounts: { rel: string; target: string }[];
}

/** The compose file of the workspace: a setting, or compose.yaml / docker-compose.yml … at the root. */
export function findComposeFile(root: string, setting?: string): string | undefined {
  if (setting) {
    const p = path.resolve(root, setting);
    return fs.existsSync(p) ? p : undefined;
  }
  for (const f of COMPOSE_FILES) if (fs.existsSync(path.join(root, f))) return path.join(root, f);
  return undefined;
}

/** `docker compose config`: the project as Compose resolves it (paths absolute, defaults filled in). */
export async function composeConfig(docker: string, files: string[], o: { signal?: AbortSignal } = {}): Promise<ComposeProject> {
  const cwd = path.dirname(files[0]);
  const r = await run(docker, ['compose', ...files.flatMap((f) => ['-f', f]), 'config', '--format', 'json'], { cwd, timeoutMs: 60_000, signal: o.signal });
  if (r.error) throw new Error(/ENOENT/.test(r.error) ? `${docker} not found — Run & Trace with Docker Compose needs the docker CLI` : r.error);
  if (r.code !== 0) {
    const msg = r.stderr.trim().split('\n').pop() ?? '';
    throw new Error(/is not a docker command|unknown (shorthand )?flag|unknown command/.test(r.stderr) ? 'Docker Compose v2 is needed (`docker compose`)' : `docker compose config: ${msg}`);
  }
  const p = JSON.parse(r.stdout) as ComposeProject;
  p.services ??= {};
  return p;
}

/** Services that mount the workspace or a folder inside it: their builds can be swapped for the traced copy. */
export function tracedServices(project: ComposeProject, root: string, only?: string[]): TracedService[] {
  const out: TracedService[] = [];
  const rootAbs = path.resolve(root);
  for (const [name, s] of Object.entries(project.services)) {
    if (only?.length && !only.includes(name)) continue;
    const mounts: TracedService['mounts'] = [];
    for (const v of s.volumes ?? []) {
      if (v.type !== 'bind' || !v.source) continue;
      const rel = path.relative(rootAbs, path.resolve(v.source));
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      mounts.push({ rel: rel.split(path.sep).join('/'), target: v.target });
    }
    if (mounts.length) out.push({ name, mounts });
  }
  return out;
}

/** What a container runs: [entrypoint…, command…] the way Docker combines compose and image settings. */
export function effectiveCommand(s: ComposeService, image?: { Entrypoint?: string[] | null; Cmd?: string[] | null }): string[] | undefined {
  const entry = s.entrypoint ?? image?.Entrypoint ?? [];
  const cmd = s.command ?? (s.entrypoint ? [] : (image?.Cmd ?? []));
  const all = [...(entry ?? []), ...(cmd ?? [])];
  return all.length ? all : undefined;
}

// ---------------------------------------------------------------------------
// the traced copy and the /codegraph mount
// ---------------------------------------------------------------------------

/** Copies the workspace for the traced build; CMake caches are dropped so the build reconfigures with the shims. */
export function mirrorWorkspace(root: string, dest: string, skip: string[] = []): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const skipAbs = skip.map((s) => path.resolve(s));
  fs.cpSync(root, dest, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: (src) => {
      const base = path.basename(src);
      if (SKIP_DIRS.has(base) && src !== root) return false;
      if (skipAbs.some((s) => src === s || src.startsWith(s + path.sep))) return false;
      if (base === 'CMakeCache.txt') return false;
      try {
        const st = fs.lstatSync(src);
        if (st.isFile()) {
          if (st.size > 256 * 1024 * 1024) return false;
          files++;
          bytes += st.size;
        }
      } catch {
        return false;
      }
      return true;
    },
  });
  // a CMake build folder configured with /usr/bin/c++ would bypass the shims: reconfigure from scratch
  const stack = [dest];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.name === 'CMakeFiles') && fs.existsSync(path.join(d, 'cmake_install.cmake'))) {
      fs.rmSync(path.join(d, 'CMakeFiles'), { recursive: true, force: true });
    }
    for (const e of entries) if (e.isDirectory() && e.name !== 'CMakeFiles') stack.push(path.join(d, e.name));
  }
  return { files, bytes };
}

/** Compiler shim: same name as the compiler it stands in for (gcc, g++, cc, c++, clang, clang++). */
export function shimScript(nfn: number, base = MOUNT): string {
  return `#!/bin/sh
# CodeGraph Run & Trace: stands in for the compiler of the same name. Compiles with the tracer
# header (${base}/rt/cg_trace.h) and links the tracer runtime into every program, then runs the
# real compiler. Version queries, preprocessing and shared libraries pass through.
CG=${base}
self=\${0##*/}
find_real() {
  _ifs=$IFS; IFS=:
  for _d in $PATH; do
    case "$_d" in "$CG/bin"|"$CG/bin/") continue ;; esac
    if [ -x "$_d/$1" ] && [ ! -d "$_d/$1" ]; then IFS=$_ifs; echo "$_d/$1"; return 0; fi
  done
  IFS=$_ifs; return 1
}
real=$(find_real "$self") || { echo "codegraph: no $self on PATH" >&2; exit 127; }
link=1; shared=0; static=0
for a in "$@"; do
  case "$a" in
    --version|-v|-dumpversion|-dumpfullversion|-dumpmachine|-print-*|--print-*|-###) exec "$real" "$@" ;;
    -E|-M|-MM) exec "$real" "$@" ;;
    -c|-S) link=0 ;;
    -shared) shared=1 ;;
    -static|-static-pie) static=1 ;;
  esac
done
if [ $link = 0 ] || [ $shared = 1 ]; then exec "$real" -include "$CG/rt/cg_trace.h" "$@"; fi

# linking a program: build the runtime once per container (C++ links get the C++ part too)
case "$self" in *++*|*xx*) cxx=1 ;; *) cxx=0 ;; esac
rt=/tmp/codegraph-rt; mkdir -p "$rt" 2>/dev/null || rt=$(mktemp -d)
cc=$(find_real gcc || find_real cc || find_real clang) || cc=
if [ $cxx = 1 ]; then rtc="$rt/cg_trace_cpp.o"; lang=-DCGT_LANG_CPP; else rtc="$rt/cg_trace_c.o"; lang=; fi
if [ ! -f "$rtc" ]; then
  if [ -n "$cc" ]; then "$cc" -O2 -c "$CG/rt/cg_trace.c" -o "$rtc.$$" -DCGT_NFN=${Math.max(1, nfn)} $lang
  else "$real" -x c -O2 -c "$CG/rt/cg_trace.c" -o "$rtc.$$" -DCGT_NFN=${Math.max(1, nfn)} $lang; fi && mv -f "$rtc.$$" "$rtc"
fi
objs="$rtc"
if [ $cxx = 1 ]; then
  if [ ! -f "$rt/cg_trace_cxx.o" ]; then
    "$real" -O2 -std=c++11 -c "$CG/rt/cg_trace_cxx.cpp" -o "$rt/cg_trace_cxx.o.$$" && mv -f "$rt/cg_trace_cxx.o.$$" "$rt/cg_trace_cxx.o"
  fi
  objs="$objs $rt/cg_trace_cxx.o"
fi
# shared libraries built with probes find the runtime in the program
dyn=; [ $static = 0 ] && dyn="-Wl,--dynamic-list=$CG/rt/cgt.dynlist"
exec "$real" -include "$CG/rt/cg_trace.h" "$@" $objs -pthread $dyn
`;
}

/** Entrypoint wrapper: the service's own command with the shims first on PATH. */
export function runScript(base = MOUNT): string {
  return `#!/bin/sh
# CodeGraph Run & Trace: run the service's own command with the compiler shims first on PATH
PATH="${base}/bin:\${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
export PATH
# files the build creates in the traced copy stay removable from the host (containers often run as root)
umask 0000
exec "$@"
`;
}

const SHIM_NAMES = ['gcc', 'g++', 'cc', 'c++', 'clang', 'clang++'];

/**
 * Writes the /codegraph folder: runtime sources, shims, entrypoint wrapper and one trace folder per
 * service. `base` is where it will be mounted (tests use it where it is).
 */
export function writeCodegraphDir(dir: string, runtimeDir: string, nfn: number, services: string[], base = MOUNT): void {
  const rt = path.join(dir, 'rt');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(rt, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const f of ['cg_trace.h', 'cg_trace.c', 'cg_trace_cxx.cpp']) fs.copyFileSync(path.join(runtimeDir, 'c', f), path.join(rt, f));
  fs.writeFileSync(path.join(rt, 'cgt.dynlist'), '{ cgt_*; };\n');
  fs.writeFileSync(path.join(bin, 'cg-cc'), shimScript(nfn, base), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'cg-run'), runScript(base), { mode: 0o755 });
  for (const n of SHIM_NAMES) {
    const p = path.join(bin, n);
    fs.rmSync(p, { force: true });
    fs.symlinkSync('cg-cc', p);
  }
  for (const s of services) {
    const t = path.join(dir, 'trace', s);
    fs.mkdirSync(t, { recursive: true });
    fs.chmodSync(t, 0o777); // containers may run as another user
  }
  fs.chmodSync(path.join(dir, 'trace'), 0o777);
}

/** The override file: each traced service gets the traced copy, /codegraph, the trace env and the wrapper. */
export function composeOverride(
  services: { name: string; mounts: { rel: string; target: string }[]; command: string[] }[],
  o: { mirror: string; codegraph: string; maxEvents: number; values: boolean },
): { services: Record<string, unknown> } {
  const out: Record<string, unknown> = {};
  for (const s of services) {
    out[s.name] = {
      volumes: [
        ...s.mounts.map((m) => ({ type: 'bind', source: m.rel ? path.join(o.mirror, ...m.rel.split('/')) : o.mirror, target: m.target })),
        { type: 'bind', source: o.codegraph, target: MOUNT },
      ],
      entrypoint: [`${MOUNT}/bin/cg-run`],
      command: s.command,
      environment: {
        CODE_GRAPH_TRACE: `${MOUNT}/trace/${s.name}/{pid}.jsonl`,
        CODE_GRAPH_MAX_EVENTS: String(o.maxEvents),
        CODE_GRAPH_VALUES: o.values ? '1' : '0',
      },
    };
  }
  return { services: out };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export interface ComposeRunInput {
  root: string;
  graph: CodeGraph;
  files: { abs: string; rel: string; lang: 'c' | 'cpp' | 'python' }[];
  composeFile: string;
  /** Services to trace (default: every service that mounts the workspace). */
  services?: string[];
  docker?: string;
  runtimeDir: string;
  /** Scratch folder for the traced copy, /codegraph and the override (wiped). */
  workDir: string;
  parsers: () => Promise<Parsers>;
  /** How long the programs may run, counted from the first traced program's start. */
  timeoutMs: number;
  /** How long images and in-container builds may take before the first traced program starts. */
  startTimeoutMs: number;
  maxEvents: number;
  values: boolean;
  signal?: AbortSignal;
  /** Containers of this project are running: may CodeGraph recreate (and afterwards stop) them? */
  confirmRecreate?: (running: string[]) => Promise<boolean>;
  onStage?: (stage: 'build' | 'run' | 'trace', message?: string) => void;
  log?: (line: string) => void;
}

export interface ServiceRun {
  name: string;
  exit: number | null;
  state: string;
  traces: number;
}

export interface ComposeRunResult {
  ok: boolean;
  trace?: RunTrace;
  buildDiagnostics: Diagnostic[];
  runtimeDiagnostics: Diagnostic[];
  notes: string[];
  output: string;
  command: string;
  services: ServiceRun[];
}

const OUTPUT_MAX = 96 * 1024;

export async function runComposeTrace(o: ComposeRunInput): Promise<ComposeRunResult> {
  const docker = o.docker || 'docker';
  const notes: string[] = [];
  const result = (extra: Partial<ComposeRunResult>): ComposeRunResult => ({
    ok: false,
    buildDiagnostics: [],
    runtimeDiagnostics: [],
    notes,
    output: '',
    command: '',
    services: [],
    ...extra,
  });
  const log = (l: string) => o.log?.(l);
  const cwd = path.dirname(o.composeFile);

  // 1. the project as Compose sees it
  o.onStage?.('build', 'docker compose config');
  let project: ComposeProject;
  try {
    project = await composeConfig(docker, [o.composeFile], o);
  } catch (e) {
    notes.push(String((e as Error).message ?? e));
    return result({});
  }
  const daemon = await run(docker, ['version', '--format', '{{.Server.Version}}'], { cwd, timeoutMs: 30_000, signal: o.signal });
  if (daemon.code !== 0) {
    notes.push(`cannot reach the Docker daemon (is Docker running, and may this user use it?): ${(daemon.stderr || daemon.error || '').trim().split('\n').pop()}`);
    return result({});
  }
  const traced = tracedServices(project, o.root, o.services);
  if (!traced.length) {
    const names = Object.keys(project.services);
    notes.push(
      `no service mounts this workspace (${names.join(', ') || 'no services'}): CodeGraph builds the traced copy inside a container by mounting it where the workspace is mounted (e.g. volumes: - ./:/app)`,
    );
    return result({});
  }
  const pname = project.name;
  const base = ['compose', '-p', pname, '-f', o.composeFile];

  // 2. what each traced container runs (image entrypoint/cmd when the compose file does not say)
  const imageConfig = new Map<string, { Entrypoint?: string[] | null; Cmd?: string[] | null }>();
  const inspect = async (image: string) => {
    const r = await run(docker, ['image', 'inspect', image, '--format', '{{json .Config}}'], { cwd, timeoutMs: 30_000, signal: o.signal });
    if (r.code !== 0) return undefined;
    try {
      return JSON.parse(r.stdout) as { Entrypoint?: string[] | null; Cmd?: string[] | null };
    } catch {
      return undefined;
    }
  };
  for (const s of traced) {
    const svc = project.services[s.name];
    if (svc.entrypoint && svc.command) continue;
    const image = svc.image ?? `${pname}-${s.name}`;
    let cfg = await inspect(image);
    if (!cfg) {
      // not built / pulled yet
      const args = svc.build ? [...base, 'build', s.name] : ['pull', image];
      o.onStage?.('build', `docker ${args.slice(svc.build ? 5 : 0).join(' ')}`);
      log(`$ docker ${svc.build ? `compose build ${s.name}` : `pull ${image}`}`);
      const b = await streamed(docker, args, { cwd, signal: o.signal, timeoutMs: o.startTimeoutMs, onLine: log });
      if (b.code !== 0) {
        notes.push(`${svc.build ? `docker compose build ${s.name}` : `docker pull ${image}`} failed (exit ${b.code}) — see the CodeGraph Run output`);
        return result({ output: b.output });
      }
      cfg = await inspect(image);
    }
    if (cfg) imageConfig.set(s.name, cfg);
  }
  const plan: { name: string; mounts: TracedService['mounts']; command: string[] }[] = [];
  for (const s of traced) {
    const cmd = effectiveCommand(project.services[s.name], imageConfig.get(s.name));
    if (!cmd) {
      notes.push(`${s.name}: no command to run (neither the compose file nor the image says) — skipped`);
      continue;
    }
    plan.push({ ...s, command: cmd });
  }
  if (!plan.length) return result({});

  // 3. the traced copy, /codegraph and the override
  let workDir = o.workDir;
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    // files a container created as root in an earlier run: leave them, use a fresh folder
    workDir = `${o.workDir}-${Date.now()}`;
    log(`codegraph: could not clear ${o.workDir} (files from a container?) — using ${workDir}`);
  }
  const mirror = path.join(workDir, 'src');
  const cgDir = path.join(workDir, 'codegraph');
  fs.mkdirSync(workDir, { recursive: true });
  o.onStage?.('build', 'copying the workspace');
  const copied = mirrorWorkspace(o.root, mirror, [o.workDir, workDir]);
  const native = o.files.filter((f): f is { abs: string; rel: string; lang: 'c' | 'cpp' } => f.lang !== 'python');
  o.onStage?.('build', 'instrumenting');
  const inst = instrumentSources({ files: native, outDir: mirror, graph: o.graph, parsers: await o.parsers() });
  log(`traced copy: ${copied.files} files (${(copied.bytes / 1048576).toFixed(1)} MB), probes in ${inst.fns.length} functions of ${inst.instrumented} files`);
  writeCodegraphDir(cgDir, o.runtimeDir, inst.fns.length, plan.map((s) => s.name));
  const override = path.join(workDir, 'compose.codegraph.yaml');
  fs.writeFileSync(override, JSON.stringify(composeOverride(plan, { mirror, codegraph: cgDir, maxEvents: o.maxEvents, values: o.values }), null, 2));
  const files = [...base, '-f', override];

  // 4. containers of this project already up get recreated: ask first
  const ps0 = await run(docker, [...base, 'ps', '--format', '{{.Service}}'], { cwd, timeoutMs: 30_000, signal: o.signal });
  const running = ps0.code === 0 ? [...new Set(ps0.stdout.split('\n').map((l) => l.trim()).filter(Boolean))] : [];
  if (running.length && o.confirmRecreate && !(await o.confirmRecreate(running))) {
    notes.push('cancelled: the project is running');
    return result({});
  }

  // 5. up; stop when every traced container has ended, or at the time limit counted from the
  //    first traced program (image pulls and in-container builds do not count)
  const command = `docker compose up · ${plan.map((s) => s.name).join(', ')}`;
  o.onStage?.('build', 'docker compose up');
  log(`$ docker compose -p ${pname} -f ${path.relative(o.root, o.composeFile) || o.composeFile} -f <codegraph override> up`);
  const started = new Date().toISOString();
  let firstTrace = 0;
  let stopping: Promise<unknown> | undefined;
  let timedOut = false;
  const stop = (why: string) => {
    if (stopping) return;
    log(`codegraph: ${why} — stopping the project`);
    stopping = run(docker, [...files, 'stop', '-t', '5'], { cwd, timeoutMs: 90_000 });
  };
  const tracesNow = () => plan.reduce((n, s) => n + safeList(path.join(cgDir, 'trace', s.name)).length, 0);
  const t0 = Date.now();
  let checking = false;
  let seenUp = false;
  const poll = setInterval(() => {
    if (!firstTrace && tracesNow() > 0) {
      firstTrace = Date.now();
      o.onStage?.('run', command);
    }
    if (firstTrace && Date.now() - firstTrace > o.timeoutMs) {
      timedOut = true;
      stop(`time limit (${Math.round(o.timeoutMs / 1000)} s)`);
    } else if (!firstTrace && Date.now() - t0 > o.startTimeoutMs) stop(`no traced program started within ${Math.round(o.startTimeoutMs / 1000)} s`);
    if (checking || stopping) return;
    checking = true;
    void serviceStates(docker, files, cwd).then((st) => {
      checking = false;
      const mine = st.filter((x) => plan.some((p) => p.name === x.name));
      if (mine.some((x) => x.state === 'running')) seenUp = true;
      if (seenUp && mine.length && mine.every((x) => x.state === 'exited' || x.state === 'dead')) stop('the traced services have ended');
    });
  }, 1000);
  const onAbort = () => stop('cancelled');
  o.signal?.addEventListener('abort', onAbort);
  const up = await streamed(docker, [...files, 'up', '--no-color'], { cwd, onLine: log, timeoutMs: o.startTimeoutMs + o.timeoutMs + 120_000 });
  clearInterval(poll);
  o.signal?.removeEventListener('abort', onAbort);
  await stopping;
  if (timedOut) notes.push(`stopped after ${Math.round(o.timeoutMs / 1000)} s (codeGraph.run.timeoutSeconds)`);
  if (up.error) notes.push(`docker compose up: ${up.error}`);

  // 6. how each container ended; the log of any that never ran a traced program; then take the project down
  const services = await serviceStates(docker, files, cwd);
  const perService = new Map(plan.map((s) => [s.name, safeList(path.join(cgDir, 'trace', s.name)).filter((f) => f.endsWith('.jsonl')).length]));
  const logsOf = new Map<string, string>();
  for (const s of plan) {
    if (perService.get(s.name)) continue;
    const r = await run(docker, [...files, 'logs', '--no-color', '--no-log-prefix', s.name], { cwd, timeoutMs: 30_000 });
    logsOf.set(s.name, r.stdout + r.stderr);
  }
  await run(docker, [...files, 'down', '--timeout', '5'], { cwd, timeoutMs: 120_000 });
  log('codegraph: project taken down');

  // 7. traces → one timeline
  o.onStage?.('trace');
  const parts: { name: string; trace: RunTrace }[] = [];
  for (const s of plan) {
    const dir = path.join(cgDir, 'trace', s.name);
    const tracesOf = safeList(dir).filter((f) => f.endsWith('.jsonl'));
    const st = services.find((x) => x.name === s.name);
    for (const f of tracesOf) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const tr = parseTrace(text, o.graph, { fns: inst.fns, command: s.name, started, exit: { code: null, timedOut } });
      // the container's exit code is its main process's: PID 1, or the only traced program
      if (st && (tr.pid === 1 || tracesOf.length === 1)) tr.exit = { ...tr.exit, code: st.exit };
      parts.push({ name: tracesOf.length > 1 ? `${s.name}/${tr.exe ?? 'pid'}#${tr.pid ?? f}` : s.name, trace: tr });
    }
  }
  for (const s of services) s.traces = perService.get(s.name) ?? 0;
  const output = up.output;

  // in-container build errors → red blocks (paths are the container's: map them back to the workspace)
  const buildDiagnostics: Diagnostic[] = [];
  for (const s of plan) {
    if (perService.get(s.name)) continue;
    const st = services.find((x) => x.name === s.name);
    const svc = project.services[s.name];
    const toMirror = (text: string) => {
      let t = text;
      for (const m of [...s.mounts].sort((a, b) => b.target.length - a.target.length)) t = t.split(m.target.replace(/\/$/, '') + '/').join(path.join(mirror, ...m.rel.split('/').filter(Boolean)) + '/');
      return t;
    };
    const wd = svc.working_dir ? toMirror(svc.working_dir.replace(/\/$/, '') + '/').replace(/\/$/, '') : mirror;
    const parsed = parseCompilerOutput(toMirror(logsOf.get(s.name) ?? ''), wd, mirror, 'compiler', (abs) => {
      const rel = path.relative(mirror, abs);
      return rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel.split(path.sep).join('/');
    });
    buildDiagnostics.push(...parsed.diags);
    const errs = parsed.diags.filter((d) => d.severity === 'error').length;
    notes.push(
      `${s.name}: ${st ? (st.state === 'exited' ? `exited ${st.exit ?? '?'}` : st.state) : 'did not start'} without running a traced program${errs ? ` — ${errs} build error(s)` : ''} (its log is in the CodeGraph Run output)`,
    );
  }
  if (!parts.length) {
    notes.push('no traced program ran: did the services build their C/C++ programs with gcc/g++/clang inside the container?');
    return result({ output, command, services, buildDiagnostics });
  }
  const trace = mergeTraces(parts, o.graph, { command, output: output.length > OUTPUT_MAX ? '…' + output.slice(-OUTPUT_MAX) : output, started });
  if (trace.truncated) notes.push(`recorded the first ${o.maxEvents.toLocaleString('en')} events per process in detail; counts cover the whole run`);
  return { ok: true, trace, buildDiagnostics, runtimeDiagnostics: traceDiagnostics(trace, o.graph), notes, output, command, services };
}

/** Exit code and state of every service's container (`docker compose ps -a`). */
async function serviceStates(docker: string, files: string[], cwd: string): Promise<ServiceRun[]> {
  const r = await run(docker, [...files, 'ps', '-a', '--format', 'json'], { cwd, timeoutMs: 30_000 });
  if (r.code !== 0) return [];
  const rows: { Service?: string; ExitCode?: number; State?: string }[] = [];
  const text = r.stdout.trim();
  try {
    if (text.startsWith('[')) rows.push(...(JSON.parse(text) as typeof rows));
    else for (const l of text.split('\n')) if (l.trim()) rows.push(JSON.parse(l));
  } catch {
    return [];
  }
  return rows.filter((x) => x.Service).map((x) => ({ name: x.Service!, exit: typeof x.ExitCode === 'number' ? x.ExitCode : null, state: x.State ?? '', traces: 0 }));
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Runs a command, passing every output line on as it comes; keeps the tail of the output. */
function streamed(
  cmd: string,
  args: string[],
  o: { cwd: string; onLine?: (l: string) => void; signal?: AbortSignal; timeoutMs: number },
): Promise<{ code: number | null; output: string; error?: string }> {
  return new Promise((resolve) => {
    let output = '';
    let pending = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ code: null, output, error: String(e) });
      return;
    }
    const take = (d: Buffer) => {
      const s = d.toString();
      output += s;
      if (output.length > OUTPUT_MAX * 2) output = output.slice(-OUTPUT_MAX);
      pending += s;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const l of lines) o.onLine?.(l.replace(/\r$/, ''));
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const kill = () => child.kill('SIGTERM');
    const timer = setTimeout(kill, o.timeoutMs);
    o.signal?.addEventListener('abort', kill);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, output, error: String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', kill);
      if (pending) o.onLine?.(pending);
      resolve({ code, output });
    });
  });
}
