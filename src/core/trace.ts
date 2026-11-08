/**
 * Runtime traces (schema code-graph-trace/1) and the model the viewer replays.
 *
 * Tracers (runtime/python/cg_tracer.py, runtime/c/cg_trace.c) write JSON lines:
 *
 *   {"k":"h", schema, lang, clock:"ns", pid, root?}       header
 *   {"k":"f", id, file, line, name, q}                     function table (Python; C/C++ ids come from the instrumenter)
 *   {"k":"t", id, name, parent?, t}                        thread first seen
 *   ["c", t, th, fid, args]              Python call       args: [[name, kind, repr, id?, size?], …]
 *   ["c", t, th, fid, self, args]        C/C++ call        self: "0x…" (this) or null
 *   ["r", t, th, fid, value?]            return            value: [kind, repr, id?, size?]
 *   ["x", t, th, fid, type, message, line]   exception leaving fid (Python) / crash inside fid (C/C++)
 *   ["s", t, th, entryFid, name]         thread started by th (Python)
 *   ["e", t, th]                         thread finished
 *   {"k":"exc", t, th, type, msg, frames:[[fid,line]…], uncaught}   uncaught exception with its traceback
 *   {"k":"stack", th, fids:[…]}         shadow stack of every thread at a crash (C/C++)
 *   {"k":"agg", calls:[[fid,n]…], edges?:[[from,to,th,n]…]}       complete counts (also past the event cap)
 *   {"k":"end", t, exit?, events, dropped}
 *
 * Value kinds: i int · d float · b bool · s string · n null/None · c container (size) · o object/pointer (identity).
 * Lines may arrive out of time order (per-thread buffers); the parser sorts.
 */
import type { CodeGraph, Diagnostic, Entity } from './model';

export type ValKind = 'i' | 'd' | 'b' | 's' | 'n' | 'c' | 'o';
/** [kind, repr, identity?, size?] */
export type Val = [ValKind, string, (string | null)?, number?];
/** [name, kind, repr, identity?, size?] */
export type ArgVal = [string, ValKind, string, (string | null)?, number?];

export interface TraceFn {
  /** Entity id in the static graph ('' when the function is not part of it). */
  id: string;
  name: string;
  file?: string;
  line?: number;
}

export interface TraceThread {
  id: number;
  name: string;
  parent?: number;
  /** Function the thread started in (index into fns). */
  entry?: number;
  start: number;
  end?: number;
  /** Process the thread belongs to (index into RunTrace.procs) in a trace of several processes. */
  proc?: number;
}

/** One program of a multi-process trace (e.g. one container of a Compose project). */
export interface TraceProcess {
  name: string;
  pid?: number;
  exit: RunTrace['exit'];
  /** Its threads (ids in the merged trace). */
  threads: number[];
}

export interface TraceException {
  t: number;
  th: number;
  fn: number;
  type: string;
  msg: string;
  line?: number;
  /** Set when the error is located in a file rather than a traced function (e.g. a SyntaxError on import). */
  file?: string;
  uncaught?: boolean;
  /** Call path, outermost first: [fn, line]. */
  frames?: [number, number][];
  /** Index of the span the exception left / crashed in. */
  span?: number;
}

export interface TraceObject {
  id: string;
  /** Type name or a short preview. */
  label: string;
  kind: ValKind;
  /** Times it was passed in, returned, or used as self/this. */
  n: number;
  fns: number[];
  threads: number[];
  first: number;
  last: number;
}

/** Calls as spans (start … end), in start order; parallel arrays keep the message small. */
export interface Spans {
  t: number[];
  end: number[];
  th: number[];
  fn: number[];
  /** Calling span, -1 for a thread's outermost call. */
  parent: number[];
  depth: number[];
}

export interface RunTrace {
  schema: 1;
  lang: 'python' | 'c' | 'cpp';
  command: string;
  started: string;
  durationNs: number;
  /** `stopped`: ended by the user (Stop) — like `timedOut`, not a failure. */
  exit: { code: number | null; signal?: string; timedOut?: boolean; stopped?: boolean; crash?: string };
  /** The detailed event cap was reached; counts in `calls` are still complete. */
  truncated: boolean;
  events: number;
  dropped: number;
  fns: TraceFn[];
  threads: TraceThread[];
  spans: Spans;
  args: Record<number, ArgVal[]>;
  rets: Record<number, Val>;
  selfs: Record<number, string>;
  exceptions: TraceException[];
  /** Complete call counts per function. */
  calls: [number, number][];
  /** caller fn → callee fn per thread with counts (-1 = thread root). */
  edges: [number, number, number, number][];
  stacks?: { th: number; fns: number[] }[];
  objects: TraceObject[];
  output: string;
  pid?: number;
  /** Program file name (C/C++ runtime). */
  exe?: string;
  /** Monotonic and wall clock (ns) at time 0, for lining up traces of processes that ran side by side. */
  clock?: { mono?: number; wall?: number };
  /** Set when the trace combines several processes (threads are numbered across all of them). */
  procs?: TraceProcess[];
}

export interface ParseTraceOptions {
  /** C/C++: function table produced by the instrumenter (fid → entity). */
  fns?: TraceFn[];
  /** Python: maps the tracer's root-relative paths to workspace paths (a container's root is elsewhere). */
  mapFile?: (file: string) => string;
  command?: string;
  exit?: RunTrace['exit'];
  output?: string;
  started?: string;
}

// ---------------------------------------------------------------------------
// function → entity
// ---------------------------------------------------------------------------

/** Finds the static entity a traced Python function belongs to. */
export class EntityLocator {
  private byDef = new Map<string, Entity>();
  private byFile = new Map<string, Entity[]>();
  private byQname = new Map<string, Entity[]>();

  constructor(private g: CodeGraph) {
    for (const e of g.entities) {
      const loc = e.def ?? e.decl;
      if (!loc) continue;
      if (e.kind === 'function' || e.kind === 'class') {
        this.byDef.set(`${loc.file}:${loc.line}`, e);
        (this.byFile.get(loc.file) ?? this.byFile.set(loc.file, []).get(loc.file)!).push(e);
      }
      const tail = e.qname.split(/::|\./).slice(-2).join('.');
      (this.byQname.get(tail) ?? this.byQname.set(tail, []).get(tail)!).push(e);
    }
  }

  locate(file: string, line: number, name: string, qual?: string): string {
    if (name === '<module>') {
      const m = this.g.entities.find((e) => e.kind === 'namespace' && e.sub === 'module' && (e.def ?? e.decl)?.file === file);
      return m?.id ?? 'f:' + file;
    }
    const exact = this.byDef.get(`${file}:${line}`);
    if (exact && exact.name === name) return exact.id;
    const inFile = this.byFile.get(file) ?? [];
    // decorators move co_firstlineno above the def line
    if (qual && !qual.includes('<')) {
      const parts = qual.split('.');
      const tail = parts.slice(-2).join('.');
      const cands = (this.byQname.get(tail) ?? []).filter((e) => (e.def ?? e.decl)?.file === file);
      if (cands.length === 1) return cands[0].id;
      const near = inFile.find((e) => e.name === name && Math.abs((e.def ?? e.decl)!.line - line) <= 6);
      if (near) return near.id;
    }
    // <genexpr>, <lambda>, nested helpers: the enclosing function
    let best: Entity | undefined;
    for (const e of inFile) {
      if (e.kind !== 'function') continue;
      const d = (e.def ?? e.decl)!;
      if (d.line <= line && line <= (d.endLine ?? d.line) && (!best || d.line >= (best.def ?? best.decl)!.line)) best = e;
    }
    return best?.id ?? exact?.id ?? '';
  }
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type Line = Record<string, unknown> | unknown[];

const isVal = (v: unknown): v is Val => Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string';

export function parseTrace(text: string, g: CodeGraph, opts: ParseTraceOptions = {}): RunTrace {
  const lines: Line[] = [];
  let bad = 0;
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    try {
      lines.push(JSON.parse(raw) as Line);
    } catch {
      bad++; // a line cut off by a crash or a kill
    }
  }
  let lang: RunTrace['lang'] = 'python';
  const fns: TraceFn[] = opts.fns ? opts.fns.map((f) => ({ ...f })) : [];
  const threads = new Map<number, TraceThread>();
  const events: unknown[][] = [];
  const exceptions: TraceException[] = [];
  const stacks: { th: number; fns: number[] }[] = [];
  let calls: [number, number][] = [];
  let edges: [number, number, number, number][] | undefined;
  let end: Record<string, unknown> | undefined;
  let crash: string | undefined;
  let header: Record<string, unknown> = {};
  const locator = new EntityLocator(g);
  const pyFn = new Map<number, number>();

  for (const l of lines) {
    if (Array.isArray(l)) {
      events.push(l);
      continue;
    }
    switch (l.k) {
      case 'h':
        lang = l.lang === 'cpp' ? 'cpp' : l.lang === 'c' ? 'c' : 'python';
        header = l;
        break;
      case 'f': {
        const file = opts.mapFile && l.file ? opts.mapFile(String(l.file)) : String(l.file ?? '');
        const line = Number(l.line ?? 0);
        const name = String(l.name ?? '?');
        const id = locator.locate(file, line, name, typeof l.q === 'string' ? l.q : undefined);
        pyFn.set(Number(l.id), fns.length);
        fns.push({ id, name: typeof l.q === 'string' ? l.q : name, file, line });
        break;
      }
      case 't': {
        const id = Number(l.id);
        threads.set(id, { id, name: String(l.name ?? `thread-${id}`), parent: typeof l.parent === 'number' ? l.parent : undefined, start: Number(l.t ?? 0) });
        break;
      }
      case 'exc':
        exceptions.push({
          t: Number(l.t ?? 0),
          th: Number(l.th ?? 0),
          fn: -1,
          type: String(l.type ?? 'Exception'),
          msg: String(l.msg ?? ''),
          uncaught: !!l.uncaught,
          frames: Array.isArray(l.frames) ? (l.frames as [number, number][]) : undefined,
          file: typeof l.file === 'string' ? (opts.mapFile ? opts.mapFile(l.file) : l.file) : undefined,
          line: typeof l.line === 'number' ? l.line : undefined,
        });
        break;
      case 'stack':
        stacks.push({ th: Number(l.th), fns: Array.isArray(l.fids) ? (l.fids as number[]) : [] });
        break;
      case 'agg':
        if (Array.isArray(l.calls)) calls = l.calls as [number, number][];
        if (Array.isArray(l.edges)) edges = l.edges as [number, number, number, number][];
        break;
      case 'crash':
        crash = String(l.sig ?? 'crash');
        break;
      case 'stopped':
        crash = crash ?? undefined;
        break;
      case 'end':
        end = l;
        break;
    }
  }
  // Python fids are dense per run and already in table order; C/C++ fids index opts.fns directly
  const F = (fid: unknown): number => {
    const n = Number(fid);
    if (lang === 'python') return pyFn.get(n) ?? -1;
    return n >= 0 && n < fns.length ? n : -1;
  };

  // events → spans (per-thread stacks); per-thread buffers arrive out of order
  events.sort((a, b) => Number(a[1]) - Number(b[1]));
  const spans: Spans = { t: [], end: [], th: [], fn: [], parent: [], depth: [] };
  const args: Record<number, ArgVal[]> = {};
  const rets: Record<number, Val> = {};
  const selfs: Record<number, string> = {};
  const stack = new Map<number, number[]>();
  const derivedEdges = new Map<string, number>();
  let tMax = 0;
  for (const ev of events) {
    const kind = ev[0];
    const t = Number(ev[1]);
    const th = Number(ev[2]);
    if (t > tMax) tMax = t;
    if (!threads.has(th)) threads.set(th, { id: th, name: th === 1 ? 'main' : `thread-${th}`, start: t });
    const st = stack.get(th) ?? stack.set(th, []).get(th)!;
    if (kind === 'c') {
      const fn = F(ev[3]);
      const i = spans.t.length;
      const parent = st.length ? st[st.length - 1] : -1;
      spans.t.push(t);
      spans.end.push(-1);
      spans.th.push(th);
      spans.fn.push(fn);
      spans.parent.push(parent);
      spans.depth.push(st.length);
      st.push(i);
      let a: unknown;
      if (lang === 'python') a = ev[4];
      else {
        if (typeof ev[4] === 'string') selfs[i] = ev[4];
        a = ev[5];
      }
      if (Array.isArray(a) && a.length) {
        const list = (a as unknown[]).filter((x): x is ArgVal => Array.isArray(x) && typeof x[0] === 'string');
        if (list.length) {
          args[i] = list;
          if (lang === 'python' && list[0][0] === 'self' && list[0][3]) selfs[i] = String(list[0][3]);
        }
      }
      const th0 = threads.get(th)!;
      if (th0.entry === undefined && parent === -1) th0.entry = fn;
      const key = `${parent >= 0 ? spans.fn[parent] : -1}|${fn}|${th}`;
      derivedEdges.set(key, (derivedEdges.get(key) ?? 0) + 1);
    } else if (kind === 'r' || kind === 'x') {
      const fn = F(ev[3]);
      // pop to the matching call (tolerates returns that never arrived)
      let k = st.length - 1;
      while (k >= 0 && spans.fn[st[k]] !== fn) k--;
      let span = -1;
      if (k >= 0) {
        span = st[k];
        while (st.length > k) {
          const s = st.pop()!;
          if (spans.end[s] < 0) spans.end[s] = t;
        }
      } else if (kind === 'x' && st.length) span = st[st.length - 1]; // C/C++ crash: still inside
      if (kind === 'r' && isVal(ev[4]) && span >= 0) rets[span] = ev[4];
      // SIGTERM / SIGINT: the run was stopped (time limit, docker stop), not a failure — the spans end, nothing turns red
      if (kind === 'x' && lang !== 'python' && (ev[4] === 'SIGTERM' || ev[4] === 'SIGINT')) continue;
      if (kind === 'x') {
        exceptions.push({
          t,
          th,
          fn,
          type: String(ev[4] ?? 'error'),
          msg: String(ev[5] ?? ''),
          line: Number(ev[6] ?? 0) || undefined,
          span: span >= 0 ? span : undefined,
        });
      }
    } else if (kind === 's') {
      // thread start request (python) — entry is known when the thread's first call arrives
    } else if (kind === 'e') {
      const tt = threads.get(th);
      if (tt) tt.end = t;
    }
  }
  const endT = Math.max(tMax, Number(end?.t ?? 0));
  for (let i = 0; i < spans.t.length; i++) if (spans.end[i] < 0) spans.end[i] = endT;
  for (const th of threads.values()) {
    if (th.end === undefined) th.end = endT;
  }

  // uncaught exceptions: attach to the innermost traced frame
  for (const x of exceptions) {
    if (x.fn >= 0 || !x.frames?.length) continue;
    x.frames = x.frames.map(([f, line]) => [F(f), line] as [number, number]).filter(([f]) => f >= 0);
    const last = x.frames[x.frames.length - 1];
    if (last) {
      x.fn = last[0];
      if (!x.file) x.line = last[1];
    }
  }
  // the crash event has the function; the uncaught record has the traceback: merge per thread
  const merged: TraceException[] = [];
  for (const x of exceptions) {
    const twin = merged.find((m) => m.th === x.th && m.type === x.type && m.msg === x.msg && Math.abs(m.t - x.t) < 5e9);
    if (twin) {
      twin.frames ??= x.frames;
      twin.uncaught ||= x.uncaught;
      if (twin.fn < 0) twin.fn = x.fn;
      twin.line ??= x.line;
      twin.span ??= x.span;
    } else merged.push(x);
  }
  // C/C++ crash: the frames are the shadow stack of the crashing thread
  for (const x of merged) {
    if (lang !== 'python' && !x.frames) {
      const s = stacks.find((st) => st.th === x.th);
      if (s) x.frames = s.fns.map((f) => [F(f), 0] as [number, number]).filter(([f]) => f >= 0);
    }
  }

  const finalEdges =
    edges?.map(([a, b, th, n]) => [a < 0 ? -1 : F(a), F(b), th, n] as [number, number, number, number]).filter((e) => e[1] >= 0) ??
    [...derivedEdges].map(([k, n]) => {
      const [a, b, th] = k.split('|').map(Number);
      return [a, b, th, n] as [number, number, number, number];
    });
  const finalCalls = calls.length
    ? calls.map(([f, n]) => [F(f), n] as [number, number]).filter(([f]) => f >= 0)
    : (() => {
        const m = new Map<number, number>();
        for (const f of spans.fn) m.set(f, (m.get(f) ?? 0) + 1);
        return [...m];
      })();

  inferParents(threads, spans, fns, g);
  nameThreads(threads, fns);

  const trace: RunTrace = {
    schema: 1,
    lang,
    command: opts.command ?? '',
    started: opts.started ?? new Date().toISOString(),
    durationNs: endT,
    exit: { ...(opts.exit ?? { code: typeof end?.exit === 'number' ? (end.exit as number) : null }), crash: crash ?? opts.exit?.crash },
    truncated: Number(end?.dropped ?? 0) > 0,
    events: Number(end?.events ?? events.length),
    dropped: Number(end?.dropped ?? 0) + bad,
    fns,
    threads: [...threads.values()].sort((a, b) => a.id - b.id),
    spans,
    args,
    rets,
    selfs,
    exceptions: merged,
    calls: finalCalls,
    edges: finalEdges,
    stacks: stacks.length ? stacks.map((s) => ({ th: s.th, fns: s.fns.map(F).filter((f) => f >= 0) })) : undefined,
    objects: [],
    output: opts.output ?? '',
    pid: typeof header.pid === 'number' ? header.pid : undefined,
    exe: typeof header.exe === 'string' && header.exe ? header.exe : undefined,
    clock: typeof header.mono === 'number' || typeof header.wall === 'number' ? { mono: num(header.mono), wall: num(header.wall) } : undefined,
  };
  trace.objects = collectObjects(trace, objectLabeler(trace, g));
  return trace;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Labels for objects from what the static graph knows: `this` → its class, a pointer argument → its declared type. */
function objectLabeler(tr: RunTrace, g: CodeGraph): (span: number, role: 'arg' | 'ret' | 'self', name?: string) => string | undefined {
  const ent = new Map(g.entities.map((e) => [e.id, e]));
  return (span, role, name) => {
    const e = ent.get(tr.fns[tr.spans.fn[span]]?.id ?? '');
    if (!e) return undefined;
    if (role === 'self') {
      const cls = e.parent ? ent.get(e.parent) : undefined;
      return cls?.kind === 'class' ? cls.name : undefined;
    }
    const p = name ? e.params?.find((x) => x.name === name) : undefined;
    return p?.type?.replace(/\s+/g, ' ');
  };
}

/**
 * One trace from the traces of several processes that ran at the same time (the containers of a
 * Compose project, a client and its server): one function table, threads numbered across all
 * processes and named after their process, calls on a common clock, object identities kept apart
 * per process (the same address in two processes is not the same object).
 */
export function mergeTraces(input: { name: string; trace: RunTrace }[], g: CodeGraph, o: { command: string; output?: string; started?: string }): RunTrace {
  const anchor = (tr: RunTrace) => tr.clock?.mono;
  // the process that started first comes first (a server before its clients)
  const start = (tr: RunTrace) => tr.clock?.mono ?? tr.clock?.wall;
  const parts = input.every((p) => start(p.trace) !== undefined) ? [...input].sort((a, b) => start(a.trace)! - start(b.trace)!) : input;
  const useMono = parts.every((p) => anchor(p.trace) !== undefined);
  const useWall = !useMono && parts.every((p) => p.trace.clock?.wall !== undefined);
  const base = Math.min(...parts.map((p) => (useMono ? anchor(p.trace)! : useWall ? p.trace.clock!.wall! : 0)));
  const offset = parts.map((p) => (useMono ? anchor(p.trace)! - base : useWall ? p.trace.clock!.wall! - base : 0));

  // one function table: C/C++ parts share the instrumenter's, Python parts number their own
  const fns: TraceFn[] = [];
  const fnKey = new Map<string, number>();
  const fnMap = parts.map((p) =>
    p.trace.fns.map((f) => {
      const k = `${f.id}|${f.name}|${f.file ?? ''}|${f.line ?? ''}`;
      let i = fnKey.get(k);
      if (i === undefined) {
        i = fns.length;
        fns.push({ ...f });
        fnKey.set(k, i);
      }
      return i;
    }),
  );
  const F = (p: number, f: number) => (f >= 0 ? (fnMap[p][f] ?? -1) : f);

  // threads, numbered across processes
  const threads: TraceThread[] = [];
  const procs: TraceProcess[] = [];
  const thMap = parts.map(() => new Map<number, number>());
  let nextId = 1;
  parts.forEach((p, pi) => {
    const ids: number[] = [];
    for (const th of p.trace.threads) {
      const id = nextId++;
      thMap[pi].set(th.id, id);
      ids.push(id);
    }
    for (const th of p.trace.threads) {
      threads.push({
        id: thMap[pi].get(th.id)!,
        name: parts.length > 1 ? `${p.name} · ${th.name}` : th.name,
        parent: th.parent !== undefined ? thMap[pi].get(th.parent) : undefined,
        entry: th.entry !== undefined ? F(pi, th.entry) : undefined,
        start: th.start + offset[pi],
        end: th.end !== undefined ? th.end + offset[pi] : undefined,
        proc: pi,
      });
    }
    procs.push({ name: p.name, pid: p.trace.pid, exit: p.trace.exit, threads: ids });
  });
  const TH = (p: number, th: number) => thMap[p].get(th) ?? th;
  const ident = (p: number, id: string | null | undefined) => (id && id !== '0x0' && id !== '(nil)' && parts.length > 1 ? `${parts[p].name}/${id}` : id);

  // spans on the common clock, in start order
  const order: [number, number][] = [];
  parts.forEach((p, pi) => {
    for (let i = 0; i < p.trace.spans.t.length; i++) order.push([pi, i]);
  });
  const tOf = ([pi, i]: [number, number]) => parts[pi].trace.spans.t[i] + offset[pi];
  order.sort((a, b) => tOf(a) - tOf(b));
  const spanMap = parts.map((p) => new Int32Array(p.trace.spans.t.length));
  order.forEach(([pi, i], k) => (spanMap[pi][i] = k));
  const spans: Spans = { t: [], end: [], th: [], fn: [], parent: [], depth: [] };
  const args: Record<number, ArgVal[]> = {};
  const rets: Record<number, Val> = {};
  const selfs: Record<number, string> = {};
  for (const [pi, i] of order) {
    const s = parts[pi].trace.spans;
    const k = spans.t.length;
    spans.t.push(s.t[i] + offset[pi]);
    spans.end.push(s.end[i] + offset[pi]);
    spans.th.push(TH(pi, s.th[i]));
    spans.fn.push(F(pi, s.fn[i]));
    spans.parent.push(s.parent[i] >= 0 ? spanMap[pi][s.parent[i]] : -1);
    spans.depth.push(s.depth[i]);
    const tr = parts[pi].trace;
    if (tr.args[i]) args[k] = tr.args[i].map((a) => (a[3] ? ([a[0], a[1], a[2], ident(pi, a[3]), a[4]] as ArgVal) : a));
    if (tr.rets[i]) {
      const v = tr.rets[i];
      rets[k] = v[2] ? ([v[0], v[1], ident(pi, v[2]), v[3]] as Val) : v;
    }
    if (tr.selfs[i]) selfs[k] = ident(pi, tr.selfs[i])!;
  }

  const calls = new Map<number, number>();
  parts.forEach((p, pi) => {
    for (const [f, n] of p.trace.calls) calls.set(F(pi, f), (calls.get(F(pi, f)) ?? 0) + n);
  });
  const crashed = parts.find((p) => p.trace.exit.crash && p.trace.exit.crash !== 'SIGTERM');
  const failed = parts.find((p) => p.trace.exit.code);
  const trace: RunTrace = {
    schema: 1,
    lang: parts.some((p) => p.trace.lang === 'cpp') ? 'cpp' : (parts[0]?.trace.lang ?? 'cpp'),
    command: o.command,
    started: o.started ?? parts[0]?.trace.started ?? new Date().toISOString(),
    durationNs: Math.max(0, ...parts.map((p, pi) => p.trace.durationNs + offset[pi])),
    exit: {
      code: failed?.trace.exit.code ?? (parts.every((p) => p.trace.exit.code === 0) ? 0 : null),
      crash: crashed ? `${crashed.name}: ${crashed.trace.exit.crash}` : undefined,
      timedOut: parts.some((p) => p.trace.exit.timedOut),
      stopped: parts.some((p) => p.trace.exit.stopped) || undefined,
      signal: crashed?.trace.exit.signal,
    },
    truncated: parts.some((p) => p.trace.truncated),
    events: parts.reduce((n, p) => n + p.trace.events, 0),
    dropped: parts.reduce((n, p) => n + p.trace.dropped, 0),
    fns,
    threads,
    spans,
    args,
    rets,
    selfs,
    exceptions: parts
      .flatMap((p, pi) =>
        p.trace.exceptions.map((x) => ({
          ...x,
          t: x.t + offset[pi],
          th: TH(pi, x.th),
          fn: F(pi, x.fn),
          frames: x.frames?.map(([f, line]) => [F(pi, f), line] as [number, number]),
          span: x.span !== undefined ? spanMap[pi][x.span] : undefined,
        })),
      )
      .sort((a, b) => a.t - b.t),
    calls: [...calls],
    edges: parts.flatMap((p, pi) => p.trace.edges.map(([a, b, th, n]) => [F(pi, a), F(pi, b), TH(pi, th), n] as [number, number, number, number])),
    stacks: parts.flatMap((p, pi) => (p.trace.stacks ?? []).map((st) => ({ th: TH(pi, st.th), fns: st.fns.map((f) => F(pi, f)) }))),
    objects: [],
    output: o.output ?? parts.map((p) => p.trace.output).join(''),
    clock: useMono ? { mono: base } : useWall ? { wall: base } : undefined,
    procs,
  };
  trace.objects = collectObjects(trace, objectLabeler(trace, g));
  return trace;
}

/**
 * One process of a trace of several (a container of a Compose run, one file of several loaded): its
 * threads, calls, values and failures only, on the same clock, so views of two processes line up.
 * Undefined when the trace has no process of that name.
 */
export function processTrace(tr: RunTrace, name: string, g: CodeGraph): RunTrace | undefined {
  const pi = tr.procs?.findIndex((p) => p.name === name) ?? -1;
  if (pi < 0) return undefined;
  const proc = tr.procs![pi];
  const mine = new Set(proc.threads);
  const prefix = `${name} · `;
  const spanMap = new Map<number, number>();
  const spans: Spans = { t: [], end: [], th: [], fn: [], parent: [], depth: [] };
  const args: Record<number, ArgVal[]> = {};
  const rets: Record<number, Val> = {};
  const selfs: Record<number, string> = {};
  for (let i = 0; i < tr.spans.t.length; i++) {
    if (!mine.has(tr.spans.th[i])) continue;
    const k = spans.t.length;
    spanMap.set(i, k);
    spans.t.push(tr.spans.t[i]);
    spans.end.push(tr.spans.end[i]);
    spans.th.push(tr.spans.th[i]);
    spans.fn.push(tr.spans.fn[i]);
    spans.parent.push(tr.spans.parent[i] >= 0 ? (spanMap.get(tr.spans.parent[i]) ?? -1) : -1);
    spans.depth.push(tr.spans.depth[i]);
    if (tr.args[i]) args[k] = tr.args[i];
    if (tr.rets[i]) rets[k] = tr.rets[i];
    if (tr.selfs[i]) selfs[k] = tr.selfs[i];
  }
  const edges = tr.edges.filter((e) => mine.has(e[2]));
  const calls = new Map<number, number>();
  for (const [, callee, , n] of edges) calls.set(callee, (calls.get(callee) ?? 0) + n);
  const out: RunTrace = {
    ...tr,
    command: name,
    exit: proc.exit,
    pid: proc.pid,
    threads: tr.threads
      .filter((th) => mine.has(th.id))
      .map((th) => ({ ...th, name: th.name.startsWith(prefix) ? th.name.slice(prefix.length) : th.name, proc: undefined })),
    spans,
    args,
    rets,
    selfs,
    exceptions: tr.exceptions
      .filter((x) => mine.has(x.th))
      .map((x) => ({ ...x, span: x.span !== undefined ? spanMap.get(x.span) : undefined })),
    calls: [...calls],
    edges,
    stacks: tr.stacks?.filter((st) => mine.has(st.th)),
    events: spans.t.length * 2,
    objects: [],
    procs: undefined,
  };
  out.objects = collectObjects(out, objectLabeler(out, g));
  return out;
}

/** Threads the OS left unnamed are called after the function they run: rxLoop, txLoop #1, txLoop #2 … */
function nameThreads(threads: Map<number, TraceThread>, fns: TraceFn[]): void {
  const generic = /^(thread-\d+|Dummy-\d+)$/;
  const base = (th: TraceThread) => (th.entry !== undefined ? (fns[th.entry]?.name ?? '').split(/::|\./).pop() ?? '' : '');
  const total = new Map<string, number>();
  for (const th of threads.values()) if (generic.test(th.name) && base(th)) total.set(base(th), (total.get(base(th)) ?? 0) + 1);
  const seen = new Map<string, number>();
  // number in the order the threads are listed (by id, as in the swimlanes), not by start time:
  // two threads can start in one order and take their ids in the other
  for (const th of [...threads.values()].sort((a, b) => a.id - b.id)) {
    const b = base(th);
    if (!generic.test(th.name) || !b) continue;
    const k = (seen.get(b) ?? 0) + 1;
    seen.set(b, k);
    th.name = (total.get(b) ?? 0) > 1 ? `${b} #${k}` : b;
  }
}

/**
 * C/C++ tracers do not see thread creation: a thread's parent is the thread that was running the
 * function that statically spawns the new thread's entry (e.g. Router::start → rxLoop) when it started.
 */
function inferParents(threads: Map<number, TraceThread>, spans: Spans, fns: TraceFn[], g: CodeGraph): void {
  const spawners = new Map<string, string[]>();
  for (const r of g.relations) if (r.kind === 'spawn') (spawners.get(r.to) ?? spawners.set(r.to, []).get(r.to)!).push(r.from);
  for (const th of threads.values()) {
    if (th.parent !== undefined || th.id === 1 || th.entry === undefined) continue;
    const from = new Set(spawners.get(fns[th.entry]?.id ?? '') ?? []);
    let best = -1;
    for (let i = 0; i < spans.t.length && spans.t[i] <= th.start; i++) {
      if (spans.th[i] === th.id || spans.end[i] < th.start) continue;
      if (from.has(fns[spans.fn[i]]?.id ?? '')) best = i;
    }
    if (best >= 0) th.parent = spans.th[best];
    else if (threads.has(1)) th.parent = 1;
  }
}

/** Values that carry an identity and travel: seen in ≥ 2 functions or threads. */
export function collectObjects(
  tr: RunTrace,
  labelOf?: (span: number, role: 'arg' | 'ret' | 'self', name?: string) => string | undefined,
): TraceObject[] {
  const m = new Map<string, TraceObject & { fnSet: Set<number>; thSet: Set<number> }>();
  const vague = (l: string) => l === 'self' || /^(0x|\(nil\))/.test(l);
  const see = (id: string | null | undefined, label: string, kind: ValKind, span: number, role: 'arg' | 'ret' | 'self' = 'arg', name?: string) => {
    if (!id || id === '0x0' || id === '(nil)') return;
    let o = m.get(id);
    const t = tr.spans.t[span];
    if (vague(label)) label = labelOf?.(span, role, name) ?? label;
    if (!o) {
      o = { id, label, kind, n: 0, fns: [], threads: [], first: t, last: t, fnSet: new Set(), thSet: new Set() };
      m.set(id, o);
    } else if (vague(o.label) && !vague(label)) o.label = label;
    o.n++;
    o.fnSet.add(tr.spans.fn[span]);
    o.thSet.add(tr.spans.th[span]);
    if (t < o.first) o.first = t;
    if (t > o.last) o.last = t;
    if (o.kind === 'o' && kind !== 'o') {
      o.kind = kind;
      o.label = label;
    }
  };
  for (const [k, list] of Object.entries(tr.args)) {
    const span = Number(k);
    for (const a of list) if (a[3] && (a[1] === 'o' || a[1] === 'c')) see(a[3], a[2], a[1], span, a[0] === 'self' ? 'self' : 'arg', a[0]);
  }
  for (const [k, v] of Object.entries(tr.rets)) if (v[2] && (v[0] === 'o' || v[0] === 'c')) see(v[2], v[1], v[0], Number(k), 'ret');
  for (const [k, id] of Object.entries(tr.selfs)) see(id, 'self', 'o', Number(k), 'self');
  const out: TraceObject[] = [];
  for (const o of m.values()) {
    if (o.fnSet.size < 2 && o.thSet.size < 2) continue;
    const { fnSet, thSet, ...rest } = o;
    out.push({ ...rest, fns: [...fnSet], threads: [...thSet] });
  }
  return out.sort((a, b) => b.threads.length - a.threads.length || b.fns.length - a.fns.length || b.n - a.n).slice(0, 400);
}

/** Runtime failures → diagnostics on the function where they happened. */
export function traceDiagnostics(tr: RunTrace, g: CodeGraph): Diagnostic[] {
  const byId = new Map(g.entities.map((e) => [e.id, e]));
  const out: Diagnostic[] = [];
  for (const x of tr.exceptions) {
    if (x.file && x.uncaught) {
      out.push({ file: x.file, line: x.line ?? 1, severity: 'error', source: 'runtime', message: `${x.type}: ${x.msg}`, target: 'f:' + x.file });
      continue;
    }
    if (x.fn < 0) continue;
    const crash = tr.lang !== 'python';
    if (!crash && !x.uncaught) continue;
    const f = tr.fns[x.fn];
    const e = f?.id ? byId.get(f.id) : undefined;
    const loc = e?.def ?? e?.decl;
    const file = f?.file ?? loc?.file;
    if (!file && !loc) continue;
    const th = tr.threads.find((t) => t.id === x.th);
    const where = th && tr.threads.length > 1 ? ` (thread ${th.name})` : '';
    out.push({
      file: loc?.file ?? file!,
      line: (crash ? undefined : x.line) ?? loc?.line ?? f?.line ?? 1,
      severity: 'error',
      source: 'runtime',
      message: `${x.type}: ${x.msg}${where}`,
      target: e?.id,
    });
  }
  return out;
}

/** Compact one-line description of a value for labels. */
export function showVal(kind: ValKind, repr: string, lang: RunTrace['lang']): string {
  if (kind === 's' && lang !== 'python' && !/^["']/.test(repr)) return `"${repr}"`;
  return repr;
}
