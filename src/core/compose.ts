/**
 * Run & Trace with Docker Compose: the project's own containers, network and builds, traced.
 *
 * Programs that talk to each other (a client and its server, nodes of a protocol) only run together,
 * often only inside the network their compose file sets up. This runs that compose project with an
 * override instead of a separate setup. A service is traced when its container sees workspace
 * sources; whatever it builds, it builds from a traced copy of the workspace (probes in its C/C++
 * sources), with every compiler and Python interpreter wrapped:
 *
 *   mounted     a service that mounts the workspace (`- ./:/app`) gets the copy mounted there instead
 *   image       a service whose image copies workspace files in (`COPY . .`, then maybe `RUN make`) is
 *               built from the copy, with the shims inserted before the first COPY of each build stage
 *   configured  `.codegraph.json` says where the workspace is in a container, or what to build first
 *
 * Its command runs under /codegraph/bin/cg-run (compilers wrapped for builds at start, every Python
 * process traced). Every traced process writes /codegraph/trace/<service>/<host>-<pid>.jsonl; when
 * the programs end (or after the time limit) the project is stopped and taken down, and the traces
 * are merged into one timeline with each container's threads as lanes. Services that see no
 * workspace source (a database, a proxy) run as they are. The workspace itself is never touched.
 *
 * Needs the docker CLI with Compose v2 (2.17+ for image builds) talking to the local engine.
 * Node-only; no vscode import.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { ProjectConfig } from './config';
import { analyzeDockerfile, copiedBy, traceDockerfile, type DockerfileCopy } from './dockerfile';
import { LiveTail, type LiveUpdate } from './live';
import type { Parsers } from './extract';
import { instrumentSources } from './instrument';
import { mirrorWorkspace } from './mirror';
import type { CodeGraph, Diagnostic } from './model';
import { MOUNT, writeCodegraphDir } from './shims';
import { mergeTraces, parseTrace, traceDiagnostics, type RunTrace } from './trace';
import { parseCompilerOutput, run } from './verify';

export { mirrorWorkspace };

export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const OVERRIDE_FILES = ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml'];
const BUILD_CONTEXT = 'codegraph_trace';

export interface ComposeVolume {
  type: string;
  source?: string;
  target: string;
  read_only?: boolean;
  bind?: Record<string, unknown>;
}

export interface ComposeBuild {
  context?: string;
  dockerfile?: string;
  dockerfile_inline?: string;
  target?: string;
}

export interface ComposeService {
  image?: string;
  build?: ComposeBuild;
  command?: string[] | null;
  entrypoint?: string[] | null;
  working_dir?: string;
  volumes?: ComposeVolume[];
  environment?: Record<string, string | null>;
  hostname?: string;
}

export interface ComposeProject {
  name: string;
  services: Record<string, ComposeService>;
}

/** How one service is traced. */
export interface ServicePlan {
  name: string;
  /** Workspace folders the container sees: copy mounted at `target` (`rel` '' = the workspace). */
  mounts: { rel: string; target: string; bind?: Record<string, unknown> }[];
  /**
   * Its image copies workspace files in: rebuilt from the traced copy. `copies` are workspace-relative;
   * `builds`: a stage compiles after copying (the shims go in there).
   */
  image?: { contextRel: string; dockerfile?: string; inline?: string; copies: DockerfileCopy[]; builds: boolean; tag: string };
  /** `.codegraph.json` compose.build: run in the container before its own command. */
  prebuild?: string;
  env?: Record<string, string>;
  /** Container paths that hold workspace files: Python roots, and error paths mapped back. */
  roots: { rel: string; target: string }[];
  /** Which kinds of workspace sources the container sees. */
  native: boolean;
  python: boolean;
  /** Entry point wrapped by cg-run (false when nothing says what the container runs). */
  wrap: boolean;
  /** [entrypoint…, command…] it runs, for wrapped services. */
  command?: string[];
}

export interface SourceFile {
  rel: string;
  lang: 'c' | 'cpp' | 'python';
}

/**
 * The compose files to use: configured ones, else what `docker compose` itself would read
 * (compose.yaml or docker-compose.yml, plus its override file).
 */
export function findComposeFiles(root: string, configured?: string[]): string[] {
  if (configured?.length) return configured.map((f) => path.resolve(root, f)).filter((f) => fs.existsSync(f));
  const main = COMPOSE_FILES.map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
  if (!main) return [];
  const over = OVERRIDE_FILES.map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
  return over ? [main, over] : [main];
}

/** The workspace's main compose file (for showing the Compose button), if any. */
export function findComposeFile(root: string, setting?: string): string | undefined {
  return findComposeFiles(root, setting ? [setting] : undefined)[0];
}

const fileArgs = (files: string[], profiles: string[] = []) => [...files.flatMap((f) => ['-f', f]), ...profiles.flatMap((p) => ['--profile', p])];

/** `docker compose config`: the project as Compose resolves it (paths absolute, defaults filled in). */
export async function composeConfig(docker: string, files: string[], o: { profiles?: string[]; signal?: AbortSignal } = {}): Promise<ComposeProject> {
  const cwd = path.dirname(files[0]);
  const r = await run(docker, ['compose', ...fileArgs(files, o.profiles), 'config', '--format', 'json'], { cwd, timeoutMs: 60_000, signal: o.signal });
  if (r.error) throw new Error(/ENOENT/.test(r.error) ? `${docker} not found — Run & Trace with Docker Compose needs the docker CLI` : r.error);
  if (r.code !== 0) {
    const msg = r.stderr.trim().split('\n').pop() ?? '';
    throw new Error(/is not a docker command|unknown (shorthand )?flag|unknown command/.test(r.stderr) ? 'Docker Compose v2 is needed (`docker compose`)' : `docker compose config: ${msg}`);
  }
  const p = JSON.parse(r.stdout) as ComposeProject;
  p.services ??= {};
  return p;
}

const inside = (root: string, p: string): string | undefined => {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel.split(path.sep).join('/');
};

/**
 * Which services can be traced, and how. With `sources` (the workspace's C, C++ and Python files) a
 * service is only traced when its container sees some of them; the others (databases, proxies…)
 * run as they are, unless `.codegraph.json` names them.
 */
export function planServices(
  project: ComposeProject,
  root: string,
  o: { only?: string[]; config?: ProjectConfig['compose']; sources?: SourceFile[] } = {},
): { plans: ServicePlan[]; skipped: { name: string; why: string }[] } {
  const plans: ServicePlan[] = [];
  const skipped: { name: string; why: string }[] = [];
  const cfg = o.config ?? {};
  for (const [name, s] of Object.entries(project.services)) {
    if (o.only?.length && !o.only.includes(name)) continue;
    const asked = !!(o.only?.includes(name) || cfg.services?.includes(name) || cfg.build?.[name] || cfg.sourcePath?.[name] || cfg.env?.[name]);
    const mounts: ServicePlan['mounts'] = [];
    for (const v of s.volumes ?? []) {
      if (v.type !== 'bind' || !v.source) continue;
      const rel = inside(root, v.source);
      if (rel !== undefined) mounts.push({ rel, target: v.target, ...(v.bind && Object.keys(v.bind).length ? { bind: v.bind } : {}) });
    }
    const configured = cfg.sourcePath?.[name];
    if (configured && !mounts.some((m) => m.target === configured)) mounts.push({ rel: '', target: configured });
    const mounted = (rel: string) => mounts.some((m) => m.rel === '' || rel === m.rel || rel.startsWith(m.rel + '/'));

    let image: ServicePlan['image'];
    const ctxRel = s.build?.context ? inside(root, s.build.context) : undefined;
    if (s.build && ctxRel !== undefined) {
      const ctxAbs = path.join(root, ...ctxRel.split('/').filter(Boolean));
      let text: string | undefined = s.build.dockerfile_inline;
      let dockerfile: string | undefined;
      if (text === undefined) {
        dockerfile = path.resolve(ctxAbs, s.build.dockerfile ?? 'Dockerfile');
        try {
          text = fs.readFileSync(dockerfile, 'utf8');
        } catch {
          text = undefined;
        }
      }
      if (text !== undefined) {
        const info = analyzeDockerfile(text, ctxAbs);
        const copies = info.copies.map((c) => ({ ...c, src: [ctxRel, c.src].filter(Boolean).join('/') }));
        // rebuilt only when it copies sources in (not just a requirements.txt or a config file)
        if (info.contextCopies && (!o.sources || o.sources.some((f) => copiedBy(copies, f.rel)))) {
          const tag = `codegraph-trace/${`${project.name}-${name}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}:latest`;
          image = {
            contextRel: ctxRel,
            dockerfile: s.build.dockerfile_inline === undefined ? dockerfile : undefined,
            inline: s.build.dockerfile_inline,
            copies,
            builds: info.buildStages.length > 0,
            tag,
          };
        }
      }
    }
    if (!mounts.length && !image) {
      if (asked) skipped.push({ name, why: 'neither mounts the workspace nor copies it into its image — set compose.sourcePath for it in .codegraph.json' });
      continue;
    }
    const seen = o.sources?.filter((f) => mounted(f.rel) || (image && copiedBy(image.copies, f.rel)));
    if (seen && !seen.length) {
      if (asked) skipped.push({ name, why: 'its container has none of the workspace’s C, C++ or Python sources — set compose.sourcePath for it in .codegraph.json' });
      continue; // a database, a proxy…: runs as it is
    }
    const system = /^\/(usr|bin|sbin|lib|lib64|etc|var|proc|sys|dev)(\/|$)/;
    const roots = [
      ...mounts.map((m) => ({ rel: m.rel, target: m.target })),
      ...(image?.copies ?? [])
        .filter((c) => !c.file || !system.test(c.dest))
        .map((c) => ({ rel: c.file ? path.posix.dirname(c.src).replace(/^\.$/, '') : c.src, target: c.dest })),
    ];
    plans.push({
      name,
      mounts,
      image,
      prebuild: cfg.build?.[name],
      env: cfg.env?.[name],
      roots,
      native: seen ? seen.some((f) => f.lang !== 'python') : true,
      python: seen ? seen.some((f) => f.lang === 'python') : true,
      wrap: true,
    });
  }
  return { plans, skipped };
}

/** What a container runs: [entrypoint…, command…] the way Docker combines compose and image settings. */
export function effectiveCommand(s: ComposeService, image?: { Entrypoint?: string[] | null; Cmd?: string[] | null }): string[] | undefined {
  const entry = s.entrypoint ?? image?.Entrypoint ?? [];
  const cmd = s.command ?? (s.entrypoint ? [] : (image?.Cmd ?? []));
  const all = [...(entry ?? []), ...(cmd ?? [])];
  return all.length ? all : undefined;
}

/** The override file: traced copy, /codegraph, trace environment, wrapper and traced image builds. */
export function composeOverride(
  plans: ServicePlan[],
  o: { mirror: string; codegraph: string; maxEvents: number; values: boolean; dockerfiles?: Map<string, string>; live?: boolean },
): { services: Record<string, unknown> } {
  const out: Record<string, unknown> = {};
  for (const p of plans) {
    const selinux = p.mounts.find((m) => m.bind?.selinux)?.bind?.selinux;
    const svc: Record<string, unknown> = {
      volumes: [
        ...p.mounts.map((m) => ({
          type: 'bind',
          source: m.rel ? path.join(o.mirror, ...m.rel.split('/')) : o.mirror,
          target: m.target,
          ...(m.bind ? { bind: m.bind } : {}),
        })),
        { type: 'bind', source: o.codegraph, target: MOUNT, ...(selinux ? { bind: { selinux: 'z' } } : {}) },
      ],
      environment: {
        ...(p.env ?? {}),
        CODE_GRAPH_TRACE: `${MOUNT}/trace/${p.name}/{host}-{pid}.jsonl`,
        CODE_GRAPH_MAX_EVENTS: String(o.maxEvents),
        CODE_GRAPH_VALUES: o.values ? '1' : '0',
        ...(o.live ? { CODE_GRAPH_LIVE: '1' } : {}),
        CODE_GRAPH_SERVICE: p.name,
        CODE_GRAPH_PY_ROOTS: [...new Set(p.roots.map((r) => r.target))].join(':'),
        ...(p.prebuild ? { CODE_GRAPH_PREBUILD: p.prebuild } : {}),
      },
    };
    if (p.wrap) {
      svc.entrypoint = [`${MOUNT}/bin/cg-run`];
      if (p.command) svc.command = p.command;
    }
    if (p.image) {
      const ctx = path.join(o.mirror, ...p.image.contextRel.split('/').filter(Boolean));
      const traced = o.dockerfiles?.get(p.name);
      svc.image = p.image.tag;
      svc.build = {
        context: ctx,
        ...(p.image.inline !== undefined ? { dockerfile_inline: traced ?? p.image.inline } : { dockerfile: traced ?? '.codegraph.Dockerfile' }),
        additional_contexts: { [BUILD_CONTEXT]: o.codegraph },
      };
    }
    out[p.name] = svc;
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
  /** Compose files (absolute), in order. */
  composeFiles: string[];
  profiles?: string[];
  /** Services to trace (default: every service whose code CodeGraph can reach). */
  services?: string[];
  /** `.codegraph.json` compose section (pre-builds, source paths, environment). */
  config?: ProjectConfig['compose'];
  docker?: string;
  runtimeDir: string;
  /** Scratch folder for the traced copy, /codegraph and the override (wiped). */
  workDir: string;
  parsers: () => Promise<Parsers>;
  /** How long the programs may run, counted from the first traced program's start. */
  timeoutMs: number;
  /** How long image builds and in-container builds may take before the first traced program starts. */
  startTimeoutMs: number;
  maxEvents: number;
  values: boolean;
  signal?: AbortSignal;
  /** Ends the run now (stops the project) and keeps the traces (a Stop button); `signal` cancels. */
  finish?: AbortSignal;
  /** Follow the containers while they run (what runs right now, every 200 ms). */
  live?: (u: LiveUpdate) => void;
  /** Containers of this project are running: may CodeGraph recreate (and afterwards stop) them? */
  confirmRecreate?: (running: string[]) => Promise<boolean>;
  onStage?: (stage: 'build' | 'run' | 'trace', message?: string) => void;
  log?: (line: string) => void;
}

export interface ServiceRun {
  name: string;
  /** Container name and id (one service may have several containers). */
  container?: string;
  id?: string;
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
  /** Something about this project needs `.codegraph.json` (CodeGraph could not tell it by itself). */
  needsConfig?: boolean;
}

const OUTPUT_MAX = 96 * 1024;

export async function runComposeTrace(o: ComposeRunInput): Promise<ComposeRunResult> {
  const docker = o.docker || 'docker';
  const notes: string[] = [];
  let needsConfig = false;
  const result = (extra: Partial<ComposeRunResult>): ComposeRunResult => ({
    ok: false,
    buildDiagnostics: [],
    runtimeDiagnostics: [],
    notes,
    output: '',
    command: '',
    services: [],
    needsConfig,
    ...extra,
  });
  const log = (l: string) => o.log?.(l);
  if (!o.composeFiles.length) {
    notes.push('no compose file');
    return result({ needsConfig: true });
  }
  const cwd = path.dirname(o.composeFiles[0]);

  // 1. the project as Compose sees it, and an engine to run it
  o.onStage?.('build', 'docker compose config');
  let project: ComposeProject;
  try {
    project = await composeConfig(docker, o.composeFiles, o);
  } catch (e) {
    notes.push(String((e as Error).message ?? e));
    return result({});
  }
  const daemon = await run(docker, ['version', '--format', '{{.Server.Version}}'], { cwd, timeoutMs: 30_000, signal: o.signal });
  if (daemon.code !== 0) {
    notes.push(`cannot reach the Docker engine (is Docker running, and may this user use it without sudo?): ${(daemon.stderr || daemon.error || '').trim().split('\n').pop()}`);
    return result({});
  }

  // 2. which services, and how
  const { plans, skipped } = planServices(project, o.root, { only: o.services, config: o.config, sources: o.files });
  for (const s of skipped) notes.push(`${s.name}: ${s.why}`);
  if (skipped.length) needsConfig = true;
  if (!plans.length) {
    notes.push(
      `no service has this workspace's sources (${Object.keys(project.services).join(', ') || 'no services'}): CodeGraph traces services that mount it (volumes: - ./:/app) or copy it into their image (COPY . …) — or tell it where the code is with compose.sourcePath in .codegraph.json`,
    );
    return result({ needsConfig: true });
  }
  const pname = project.name;
  const base = ['compose', '-p', pname, ...fileArgs(o.composeFiles, o.profiles)];

  // 3. the traced copy and the CodeGraph folder
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
  log(
    `tracing ${plans.map((p) => `${p.name} (${[p.mounts.length ? `mounted at ${p.mounts.map((m) => m.target).join(', ')}` : '', p.image ? `image rebuilt from the copy${p.image.builds ? ', compiles in its Dockerfile' : ''}` : '', p.prebuild ? 'pre-build' : ''].filter(Boolean).join(', ')})`).join(', ')}`,
  );
  writeCodegraphDir(cgDir, o.runtimeDir, inst.fns.length, plans.map((p) => p.name));

  // 4. images built from the workspace: rebuilt from the copy, shims in their Dockerfile
  const dockerfiles = new Map<string, string>();
  for (const p of plans) {
    if (!p.image) continue;
    const ctx = path.join(mirror, ...p.image.contextRel.split('/').filter(Boolean));
    const original = p.image.inline ?? fs.readFileSync(p.image.dockerfile!, 'utf8');
    const traced = traceDockerfile(original, BUILD_CONTEXT, ctx);
    if (p.image.inline !== undefined) dockerfiles.set(p.name, traced.text);
    else {
      fs.writeFileSync(path.join(ctx, '.codegraph.Dockerfile'), traced.text);
      dockerfiles.set(p.name, '.codegraph.Dockerfile');
    }
  }
  const override = path.join(workDir, 'compose.codegraph.yaml');
  const writeOverride = () =>
    fs.writeFileSync(override, JSON.stringify(composeOverride(plans, { mirror, codegraph: cgDir, maxEvents: o.maxEvents, values: o.values, dockerfiles, live: !!o.live }), null, 2));
  writeOverride();
  const files = [...base, '-f', override];
  const imaged = plans.filter((p) => p.image).map((p) => p.name);
  let buildOutput = '';
  if (imaged.length) {
    o.onStage?.('build', `building ${imaged.join(', ')}`);
    log(`$ docker compose build ${imaged.join(' ')}   (from the traced copy)`);
    const b = await streamed(docker, [...files, 'build', ...imaged], { cwd, signal: o.signal, timeoutMs: o.startTimeoutMs, onLine: log });
    buildOutput = b.output;
    if (b.code !== 0) {
      notes.push(
        /additional_contexts|additional contexts/i.test(b.output)
          ? 'building the traced image needs Docker Compose 2.17+ with BuildKit'
          : `docker compose build ${imaged.join(' ')} failed (exit ${b.code}) — see the CodeGraph Run output`,
      );
      return result({ output: b.output, buildDiagnostics: buildErrors(b.output, plans, mirror, project) });
    }
  }

  // 5. what each wrapped container runs (the image's entrypoint/cmd when the compose file does not say)
  for (const p of plans) {
    if (!p.wrap) continue;
    const svc = project.services[p.name];
    let cfg: { Entrypoint?: string[] | null; Cmd?: string[] | null } | undefined;
    if (!(svc.entrypoint && svc.command)) {
      const image = p.image?.tag ?? svc.image ?? `${pname}-${p.name}`;
      cfg = await inspectImage(docker, image, cwd, o.signal);
      if (!cfg) {
        const args = svc.build ? [...base, 'build', p.name] : ['pull', image];
        log(`$ docker ${svc.build ? `compose build ${p.name}` : `pull ${image}`}`);
        const b = await streamed(docker, args, { cwd, signal: o.signal, timeoutMs: o.startTimeoutMs, onLine: log });
        if (b.code !== 0) {
          notes.push(`${svc.build ? `docker compose build ${p.name}` : `docker pull ${image}`} failed (exit ${b.code}) — see the CodeGraph Run output`);
          return result({ output: b.output });
        }
        cfg = await inspectImage(docker, image, cwd, o.signal);
      }
    }
    p.command = effectiveCommand(svc, cfg);
    if (!p.command) {
      notes.push(`${p.name}: no command to run (neither the compose file nor the image says) — its wrapper is left out`);
      p.wrap = false;
    }
  }
  writeOverride();

  // 6. containers of this project already up get recreated: ask first
  const ps0 = await run(docker, [...base, 'ps', '--format', '{{.Service}}'], { cwd, timeoutMs: 30_000, signal: o.signal });
  const running = ps0.code === 0 ? [...new Set(ps0.stdout.split('\n').map((l) => l.trim()).filter(Boolean))] : [];
  if (running.length && o.confirmRecreate && !(await o.confirmRecreate(running))) {
    notes.push('cancelled: the project is running');
    return result({});
  }

  // 7. up; stop when every traced container has ended, or at the time limit counted from the first
  //    traced program (image pulls and in-container builds do not count)
  const command = `docker compose up · ${plans.map((p) => p.name).join(', ')}`;
  o.onStage?.('build', 'docker compose up');
  log(`$ docker compose -p ${pname} ${o.composeFiles.map((f) => `-f ${path.relative(o.root, f) || f}`).join(' ')} -f <codegraph override> up`);
  const started = new Date().toISOString();
  let firstTrace = 0;
  let stopping: Promise<unknown> | undefined;
  let timedOut = false;
  let stoppedByYou = false;
  const stop = (why: string) => {
    if (stopping) return;
    log(`codegraph: ${why} — stopping the project`);
    stopping = run(docker, [...files, 'stop', '-t', '5'], { cwd, timeoutMs: 90_000 });
  };
  const tracesNow = () => plans.reduce((n, p) => n + safeList(path.join(cgDir, 'trace', p.name)).filter((f) => f.endsWith('.jsonl')).length, 0);
  const t0 = Date.now();
  let checking = false;
  let seenUp = false;
  const poll = setInterval(() => {
    if (!firstTrace && tracesNow() > 0) {
      firstTrace = Date.now();
      o.onStage?.('run', command);
    }
    if (firstTrace && o.timeoutMs > 0 && Date.now() - firstTrace > o.timeoutMs) {
      timedOut = true;
      stop(`time limit (${Math.round(o.timeoutMs / 1000)} s)`);
    } else if (!firstTrace && Date.now() - t0 > o.startTimeoutMs) stop(`no traced program started within ${Math.round(o.startTimeoutMs / 1000)} s`);
    if (checking || stopping) return;
    checking = true;
    void serviceStates(docker, files, cwd).then((st) => {
      checking = false;
      const mine = st.filter((x) => plans.some((p) => p.name === x.name));
      if (mine.some((x) => x.state === 'running')) seenUp = true;
      if (seenUp && mine.length && mine.every((x) => x.state === 'exited' || x.state === 'dead')) stop('the traced services have ended');
    });
  }, 1000);
  const onAbort = () => stop('cancelled');
  const onFinish = () => {
    stoppedByYou = true;
    stop('stopped by you');
  };
  o.signal?.addEventListener('abort', onAbort);
  o.finish?.addEventListener('abort', onFinish);
  // the containers as they run: every traced process's latest "what runs now"
  const tail = o.live
    ? new LiveTail({
        graph: o.graph,
        sources: () =>
          plans.flatMap((p) =>
            safeList(path.join(cgDir, 'trace', p.name))
              .filter((f) => /\.jsonl(\.\d+)?$/.test(f))
              .map((f) => ({
                file: path.join(cgDir, 'trace', p.name, f),
                proc: p.name,
                fns: inst.fns,
                mapFile: (h: Record<string, unknown>) => (typeof h.root === 'string' ? containerPaths(h.root, p.roots) : undefined),
              })),
          ),
        onUpdate: o.live,
      })
    : undefined;
  tail?.begin();
  const up = await streamed(docker, [...files, 'up', '--no-color'], { cwd, onLine: log, timeoutMs: o.timeoutMs > 0 ? o.startTimeoutMs + o.timeoutMs + 120_000 : undefined });
  clearInterval(poll);
  tail?.end();
  o.signal?.removeEventListener('abort', onAbort);
  o.finish?.removeEventListener('abort', onFinish);
  await stopping;
  if (timedOut) notes.push(`stopped after ${Math.round(o.timeoutMs / 1000)} s (codeGraph.run.timeoutSeconds)`);
  if (stoppedByYou) notes.push('stopped by you');
  if (up.error) notes.push(`docker compose up: ${up.error}`);

  // 8. how each container ended, the logs of services that never ran a traced program; then down
  const services = await serviceStates(docker, files, cwd);
  const traceFiles = new Map(plans.map((p) => [p.name, safeList(path.join(cgDir, 'trace', p.name)).filter((f) => /\.jsonl(\.\d+)?$/.test(f))]));
  const logsOf = new Map<string, string>();
  for (const p of plans) {
    if (traceFiles.get(p.name)!.length) continue;
    const r = await run(docker, [...files, 'logs', '--no-color', '--no-log-prefix', p.name], { cwd, timeoutMs: 30_000 });
    logsOf.set(p.name, r.stdout + r.stderr);
  }
  await run(docker, [...files, 'down', '--timeout', '5'], { cwd, timeoutMs: 120_000 });
  log('codegraph: project taken down');

  // 9. traces → one timeline; processes named after their container
  o.onStage?.('trace');
  const parts: { name: string; trace: RunTrace }[] = [];
  for (const p of plans) {
    const dir = path.join(cgDir, 'trace', p.name);
    const mine = services.filter((s) => s.name === p.name);
    const loaded: { trace: RunTrace; host: string }[] = [];
    for (const f of traceFiles.get(p.name)!) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const header = headerOf(text);
      const mapFile = header?.lang === 'python' && typeof header.root === 'string' ? containerPaths(header.root, p.roots) : undefined;
      const tr = parseTrace(text, o.graph, { fns: inst.fns, command: p.name, started, exit: { code: null, timedOut, stopped: stoppedByYou || undefined }, mapFile });
      if (!tr.spans.t.length) continue; // e.g. a Python helper that never touched workspace code
      loaded.push({ trace: tr, host: /^(.*)-\d+\.jsonl/.exec(f)?.[1] ?? '' });
    }
    const byContainer = new Map<string, { trace: RunTrace; host: string }[]>();
    for (const l of loaded) (byContainer.get(l.host) ?? byContainer.set(l.host, []).get(l.host)!).push(l);
    for (const [host, list] of byContainer) {
      const c = mine.find((s) => (s.id && host && s.id.startsWith(host)) || s.container === host) ?? (mine.length === 1 ? mine[0] : undefined);
      const label = mine.length > 1 && c?.container ? c.container.replace(new RegExp(`^${escapeRe(pname)}[-_]`), '') : p.name;
      for (const l of list) {
        // the container's exit code is its main process's: PID 1, or its only traced program
        // except when the run was stopped (Stop, time limit): docker stop's SIGTERM / SIGINT / SIGKILL (143, 130, 137) is
        // that stop, not a failure of the program
        const byStop = (timedOut || stoppedByYou) && (c?.exit === 143 || c?.exit === 130 || c?.exit === 137);
        if (c && (l.trace.pid === 1 || list.length === 1)) l.trace.exit = { ...l.trace.exit, code: byStop ? null : c.exit };
        parts.push({ name: list.length > 1 ? `${label}/${l.trace.exe ?? (l.trace.lang === 'python' ? 'python' : 'pid')}#${l.trace.pid ?? '?'}` : label, trace: l.trace });
      }
    }
  }
  for (const s of services) s.traces = parts.filter((x) => x.name === s.name || x.name.startsWith(s.name + '/')).length;
  const output = (buildOutput ? buildOutput + '\n' : '') + up.output;

  // services that never ran a traced program: their build errors in red, and what to do about it
  const buildDiagnostics: Diagnostic[] = [];
  for (const p of plans) {
    if (parts.some((x) => x.name === p.name || x.name.startsWith(p.name + '/') || x.name.startsWith(p.name + '-'))) continue;
    const st = services.find((x) => x.name === p.name);
    const own = logsOf.get(p.name) ?? '';
    const diags = errorsIn(own, p, mirror, project);
    buildDiagnostics.push(...diags);
    const errs = diags.filter((d) => d.severity === 'error').length;
    const compiled = fs.existsSync(path.join(cgDir, 'trace', p.name, '.compiled'));
    let why = '';
    if (errs) why = ` — ${errs} build error(s)`;
    else if (p.native && !compiled && !p.image?.builds) {
      why = ' — it compiled nothing in its container (does it run a program built elsewhere, or call the compiler by full path? set compose.build for it in .codegraph.json)';
      needsConfig = true;
    } else if (p.python && !p.native) {
      why = ` — no workspace Python code ran in it (looked under ${[...new Set(p.roots.map((r) => r.target))].join(', ')}; is its code somewhere else? set compose.sourcePath for it in .codegraph.json)`;
      needsConfig = true;
    }
    notes.push(`${p.name}: ${st ? (st.state === 'exited' ? `exited ${st.exit ?? '?'}` : st.state) : 'did not start'} without running a traced program${why}`);
  }
  if (!parts.length) {
    notes.push('no traced program ran (see the CodeGraph Run output for the containers’ logs)');
    return result({ output, command, services, buildDiagnostics });
  }
  const trace = mergeTraces(parts, o.graph, { command, output: output.length > OUTPUT_MAX ? '…' + output.slice(-OUTPUT_MAX) : output, started });
  if (trace.truncated) notes.push(`recorded the first ${o.maxEvents.toLocaleString('en')} events per process in detail; counts cover the whole run`);
  return { ok: true, trace, buildDiagnostics, runtimeDiagnostics: traceDiagnostics(trace, o.graph), notes, output, command, services, needsConfig };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function headerOf(text: string): Record<string, unknown> | undefined {
  try {
    const first = text.slice(0, text.indexOf('\n') >>> 0 || undefined);
    const h = JSON.parse(first) as Record<string, unknown>;
    return h && h.k === 'h' ? h : undefined;
  } catch {
    return undefined;
  }
}

/** Python traces record paths relative to their root (a container path, `/` for several): back to the workspace. */
export function containerPaths(root: string, roots: ServicePlan['roots']): (f: string) => string {
  const sorted = roots.map((r) => ({ rel: r.rel, target: r.target.replace(/\/+$/, '') })).sort((a, b) => b.target.length - a.target.length);
  return (f: string) => {
    const abs = path.posix.join(root || '/', f);
    const r = sorted.find((x) => abs === x.target || abs.startsWith(x.target + '/'));
    if (!r) return f;
    return [r.rel, abs.slice(r.target.length).replace(/^\//, '')].filter(Boolean).join('/');
  };
}

/** Compiler errors in a container's output, with its paths mapped back to the workspace. */
function errorsIn(text: string, p: ServicePlan, mirror: string, project: ComposeProject): Diagnostic[] {
  if (!text) return [];
  const svc = project.services[p.name];
  const toMirror = (t: string) => {
    let out = t;
    for (const m of [...p.roots].sort((a, b) => b.target.length - a.target.length))
      out = out.split(m.target.replace(/\/$/, '') + '/').join(path.join(mirror, ...m.rel.split('/').filter(Boolean)) + '/');
    return out;
  };
  const wd = svc.working_dir ? toMirror(svc.working_dir.replace(/\/$/, '') + '/').replace(/\/$/, '') : mirror;
  return parseCompilerOutput(toMirror(text), wd, mirror, 'compiler', (abs) => inside(mirror, abs)).diags;
}

/** Build output of traced images (BuildKit prefixes lines with step numbers): errors mapped back. */
function buildErrors(text: string, plans: ServicePlan[], mirror: string, project: ComposeProject): Diagnostic[] {
  const lines = text.split('\n').map((l) => l.replace(/^#\d+\s+[\d.]+\s+/, ''));
  return plans.filter((p) => p.image).flatMap((p) => errorsIn(lines.join('\n'), p, mirror, project));
}

async function inspectImage(docker: string, image: string, cwd: string, signal?: AbortSignal): Promise<{ Entrypoint?: string[] | null; Cmd?: string[] | null } | undefined> {
  const r = await run(docker, ['image', 'inspect', image, '--format', '{{json .Config}}'], { cwd, timeoutMs: 30_000, signal });
  if (r.code !== 0) return undefined;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
}

/** Exit code and state of every container of the project (`docker compose ps -a`). */
async function serviceStates(docker: string, files: string[], cwd: string): Promise<ServiceRun[]> {
  const r = await run(docker, [...files, 'ps', '-a', '--format', 'json'], { cwd, timeoutMs: 30_000 });
  if (r.code !== 0) return [];
  const rows: { Service?: string; Name?: string; ID?: string; ExitCode?: number; State?: string }[] = [];
  const text = r.stdout.trim();
  try {
    if (text.startsWith('[')) rows.push(...(JSON.parse(text) as typeof rows));
    else for (const l of text.split('\n')) if (l.trim()) rows.push(JSON.parse(l));
  } catch {
    return [];
  }
  return rows
    .filter((x) => x.Service)
    .map((x) => ({ name: x.Service!, container: x.Name, id: x.ID, exit: typeof x.ExitCode === 'number' ? x.ExitCode : null, state: x.State ?? '', traces: 0 }));
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
  o: { cwd: string; onLine?: (l: string) => void; signal?: AbortSignal; timeoutMs?: number },
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
    const timer = o.timeoutMs ? setTimeout(kill, o.timeoutMs) : undefined;
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
