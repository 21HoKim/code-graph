/**
 * Runtime trace → what the circuit shows: which blocks and wires ran (per thread),
 * what was active at time t, which calls start/end in a time window (replay), and
 * where one object travelled (data tracking).
 */
import type { CodeGraph, Relation } from '../core/model';
import type { ArgVal, RunTrace, Val } from '../core/trace';
import type { Projection } from './projection';

/** Distinct, readable on dark and light themes; thread 1 (main) gets the first. */
const THREAD_COLORS = ['#5ce1ff', '#ff9f43', '#7ee787', '#f778ba', '#d2a8ff', '#ffd166', '#4dd4ac', '#ff7b72', '#79c0ff', '#e3b341', '#a5d6ff', '#56d364'];

export function threadColor(th: number): string {
  return THREAD_COLORS[(th - 1 + THREAD_COLORS.length) % THREAD_COLORS.length];
}

export interface Sighting {
  span: number;
  role: 'arg' | 'ret' | 'self';
  name?: string;
}

export interface FnStat {
  n: number;
  /** inclusive time, ns (detailed part of the trace) */
  ns: number;
  threads: number[];
}

export class TraceModel {
  readonly byEnd: number[];
  readonly byThread = new Map<number, number[]>();
  readonly stats: FnStat[];
  private objIndex?: Map<string, Sighting[]>;

  constructor(readonly tr: RunTrace) {
    const s = tr.spans;
    this.byEnd = s.t.map((_, i) => i).sort((a, b) => s.end[a] - s.end[b]);
    for (let i = 0; i < s.t.length; i++) (this.byThread.get(s.th[i]) ?? this.byThread.set(s.th[i], []).get(s.th[i])!).push(i);
    const stats: FnStat[] = tr.fns.map(() => ({ n: 0, ns: 0, threads: [] }));
    const thr = tr.fns.map(() => new Set<number>());
    for (let i = 0; i < s.t.length; i++) {
      const f = s.fn[i];
      if (f < 0) continue;
      stats[f].n++;
      // inclusive time without double counting recursion
      let rec = false;
      for (let p = s.parent[i]; p >= 0; p = s.parent[p])
        if (s.fn[p] === f) {
          rec = true;
          break;
        }
      if (!rec) stats[f].ns += Math.max(0, s.end[i] - s.t[i]);
      thr[f].add(s.th[i]);
    }
    for (const [f, n] of tr.calls) if (f >= 0 && n > stats[f].n) stats[f].n = n;
    for (const [, f, th] of tr.edges) if (f >= 0) thr[f].add(th);
    stats.forEach((st, f) => (st.threads = [...thr[f]].sort((a, b) => a - b)));
    this.stats = stats;
  }

  get duration(): number {
    return Math.max(1, this.tr.durationNs);
  }

  /** Calls that start in (a, b]. */
  startedIn(a: number, b: number, max = 4000): number[] {
    const t = this.tr.spans.t;
    let i = upper(t.length, (k) => t[k] <= a);
    const out: number[] = [];
    for (; i < t.length && t[i] <= b && out.length < max; i++) out.push(i);
    return out;
  }

  /** Calls that end in (a, b]. */
  endedIn(a: number, b: number, max = 4000): number[] {
    const e = this.tr.spans.end;
    const be = this.byEnd;
    let i = upper(be.length, (k) => e[be[k]] <= a);
    const out: number[] = [];
    for (; i < be.length && e[be[i]] <= b && out.length < max; i++) out.push(be[i]);
    return out;
  }

  /** Innermost running call of every thread at time t. */
  activeAt(t: number): Map<number, number> {
    const s = this.tr.spans;
    const out = new Map<number, number>();
    for (const [th, list] of this.byThread) {
      let k = upper(list.length, (j) => s.t[list[j]] <= t) - 1;
      if (k < 0) continue;
      let i = list[k];
      while (i >= 0 && s.end[i] <= t) i = s.parent[i];
      if (i >= 0) out.set(th, i);
    }
    return out;
  }

  stackOf(span: number): number[] {
    const out: number[] = [];
    for (let i = span; i >= 0; i = this.tr.spans.parent[i]) out.push(i);
    return out.reverse();
  }

  /** Every place an object (identity) appeared, in time order. */
  sightings(id: string): Sighting[] {
    if (!this.objIndex) {
      const m = new Map<string, Sighting[]>();
      const add = (oid: string | null | undefined, s: Sighting) => {
        if (!oid) return;
        (m.get(oid) ?? m.set(oid, []).get(oid)!).push(s);
      };
      for (const [k, list] of Object.entries(this.tr.args)) for (const a of list) if (a[1] === 'o' || a[1] === 'c') add(a[3], { span: Number(k), role: a[0] === 'self' ? 'self' : 'arg', name: a[0] });
      for (const [k, v] of Object.entries(this.tr.rets)) if (v[0] === 'o' || v[0] === 'c') add(v[2], { span: Number(k), role: 'ret' });
      for (const [k, v] of Object.entries(this.tr.selfs)) {
        const span = Number(k);
        if (this.tr.lang === 'python') continue; // python self is already an arg
        add(v, { span, role: 'self', name: 'this' });
      }
      for (const list of m.values()) list.sort((a, b) => this.tr.spans.t[a.span] - this.tr.spans.t[b.span]);
      this.objIndex = m;
    }
    return this.objIndex.get(id) ?? [];
  }

  /** Recent calls of a function with their arguments / return values (newest last). */
  recentCalls(f: number, max = 8): number[] {
    const out: number[] = [];
    const fn = this.tr.spans.fn;
    for (let i = fn.length - 1; i >= 0 && out.length < max; i--) if (fn[i] === f) out.push(i);
    return out.reverse();
  }
}

/** Index of the first k in [0, n) for which pred(k) is false (pred must be monotone true→false). */
function upper(n: number, pred: (k: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Calls the program made that the static analysis did not see (virtual dispatch, callbacks,
 * function pointers, dynamic Python), and threads it started that way: added as relations so they get wires of
 * their own.
 */
export function augmentGraph(g: CodeGraph, tr: RunTrace): CodeGraph {
  const kindOf = new Map(g.entities.map((e) => [e.id, e.kind]));
  const known = new Set(g.relations.filter((r) => r.kind === 'call' || r.kind === 'spawn' || r.kind === 'instantiate').map((r) => r.from + '\u0001' + r.to));
  const extra = new Map<string, Relation>();
  for (const [a, b, , n] of tr.edges) {
    if (a < 0 || b < 0) continue;
    const from = tr.fns[a]?.id;
    const to = tr.fns[b]?.id;
    if (!from || !to || from === to) continue;
    if (kindOf.get(to) !== 'function' || (kindOf.get(from) !== 'function' && kindOf.get(from) !== 'namespace')) continue;
    const key = from + '\u0001' + to;
    if (known.has(key)) continue;
    const r = extra.get(key);
    if (r) r.count += n;
    else extra.set(key, { id: `rt:${extra.size}`, kind: 'call', from, to, conf: 'exact', count: n, via: 'runtime' });
  }
  // a thread the tracer saw being started: from the function that started it to the one it runs
  for (const th of tr.threads) {
    if (th.by === undefined || th.entry === undefined) continue;
    const from = tr.fns[th.by]?.id;
    const to = tr.fns[th.entry]?.id;
    if (!from || !to || from === to || kindOf.get(to) !== 'function') continue;
    const key = from + '\u0001' + to;
    if (known.has(key)) continue;
    const k = 's' + key;
    const r = extra.get(k);
    if (r) r.count++;
    else extra.set(k, { id: `rt:${extra.size}`, kind: 'spawn', from, to, conf: 'exact', count: 1, via: 'runtime' });
  }
  if (!extra.size) return g;
  return { ...g, relations: [...g.relations, ...extra.values()] };
}

export interface RuntimeOverlay {
  blocks: Map<string, { n: number; threads: number[] }>;
  wires: Map<string, { n: number; threads: number[]; observed: boolean }>;
}

/** Runtime facts lifted onto the current projection. */
export class RuntimeMap {
  readonly fnNode: (string | undefined)[];
  private ends = new Map<string, string>();
  readonly overlay: RuntimeOverlay;

  constructor(
    readonly model: TraceModel,
    readonly proj: Projection,
  ) {
    const tr = model.tr;
    this.fnNode = tr.fns.map((f) => (f.id ? proj.repOf(f.id) : undefined));
    const rank = (k: string) => (k === 'call' ? 0 : k === 'spawn' ? 1 : k === 'instantiate' ? 2 : 3);
    const pick = new Map<string, { id: string; r: number }>();
    for (const e of proj.edges) {
      const key = e.src + '\u0001' + e.dst;
      const r = rank(e.kind);
      const cur = pick.get(key);
      if (!cur || r < cur.r) pick.set(key, { id: e.id, r });
    }
    for (const [k, v] of pick) this.ends.set(k, v.id);

    const blocks = new Map<string, { n: number; threads: Set<number> }>();
    model.stats.forEach((st, f) => {
      const node = this.fnNode[f];
      if (!node || !st.n) return;
      const b = blocks.get(node) ?? blocks.set(node, { n: 0, threads: new Set() }).get(node)!;
      b.n += st.n;
      for (const th of st.threads) b.threads.add(th);
    });
    const observed = new Set(proj.edges.filter((e) => e.rels.length && e.rels.every((r) => r.via === 'runtime')).map((e) => e.id));
    const wires = new Map<string, { n: number; threads: Set<number> }>();
    for (const [a, b, th, n] of tr.edges) {
      const id = this.edgeOf(a, b);
      if (!id) continue;
      const w = wires.get(id) ?? wires.set(id, { n: 0, threads: new Set() }).get(id)!;
      w.n += n;
      w.threads.add(th);
    }
    // thread starts travel on spawn wires
    for (const th of tr.threads) {
      if (th.parent === undefined || th.entry === undefined) continue;
      const id = (th.by !== undefined ? this.edgeOf(th.by, th.entry) : undefined) ?? this.spawnEdge(th.parent, th.entry, th.start);
      if (!id) continue;
      const w = wires.get(id) ?? wires.set(id, { n: 0, threads: new Set() }).get(id)!;
      w.n++;
      w.threads.add(th.id);
    }
    this.overlay = {
      blocks: new Map([...blocks].map(([k, v]) => [k, { n: v.n, threads: [...v.threads].sort((x, y) => x - y) }])),
      wires: new Map([...wires].map(([k, v]) => [k, { n: v.n, threads: [...v.threads].sort((x, y) => x - y), observed: observed.has(k) }])),
    };
  }

  /** Projected wire carrying a call from fn a to fn b (undefined when both sit in the same block). */
  edgeOf(a: number, b: number): string | undefined {
    if (a < 0 || b < 0) return undefined;
    const na = this.fnNode[a];
    const nb = this.fnNode[b];
    if (!na || !nb || na === nb) return undefined;
    return this.ends.get(na + '\u0001' + nb);
  }

  /** Wire from whatever the parent thread was running when the child started to the child's entry. */
  spawnEdge(parentTh: number, entryFn: number, t: number): string | undefined {
    const act = this.model.activeAt(t).get(parentTh);
    for (let i = act ?? -1; i >= 0; i = this.model.tr.spans.parent[i]) {
      const id = this.edgeOf(this.model.tr.spans.fn[i], entryFn);
      if (id) return id;
    }
    return undefined;
  }
}

/** "name=value" list for a call, compact. */
export function argsText(args: ArgVal[] | undefined, lang: RunTrace['lang'], max = 2): string {
  if (!args?.length) return '';
  const shown = args
    .filter((a) => a[0] !== 'self')
    .slice(0, max)
    .map((a) => `${a[0]}=${valText(a[1], a[2], lang)}`);
  const rest = args.filter((a) => a[0] !== 'self').length - shown.length;
  return shown.join(', ') + (rest > 0 ? ', …' : '');
}

export function valText(kind: string, repr: string, lang: RunTrace['lang'], max = 24): string {
  let s = kind === 's' && lang !== 'python' && !/^["']/.test(repr) ? `"${repr}"` : repr;
  if (kind === 'o' && /^0x/.test(s)) s = '@' + s.slice(-6);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function retText(v: Val | undefined, lang: RunTrace['lang']): string {
  return v && v[0] !== 'n' ? valText(v[0], v[1], lang) : '';
}

export function fmtNs(ns: number): string {
  if (ns < 999.5) return `${Math.round(ns)} ns`;
  if (ns < 999.5e3) return `${(ns / 1e3).toFixed(ns < 9.995e3 ? 1 : 0)} µs`;
  if (ns < 999.95e6) return `${(ns / 1e6).toFixed(ns < 9.995e6 ? 2 : 1)} ms`;
  return `${(ns / 1e9).toFixed(2)} s`;
}
