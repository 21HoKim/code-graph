/**
 * Live view of a run: follows the trace files while the programs run. With CODE_GRAPH_LIVE=1 the
 * runtimes append, every 200 ms, what runs right now — each thread's call stack, the call counts and
 * the caller → callee counts so far. This turns the latest of those records, per file (process),
 * into one update for the viewer: the threads, their stacks as graph entities, and the calls since
 * the previous update. The detailed events in between are left to the trace read at the end.
 */
import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { CodeGraph } from './model';
import { EntityLocator, type TraceFn } from './trace';

export interface LiveThread {
  /** Numbered across all processes, in the order they showed up. */
  id: number;
  name: string;
  /** The process (container) it belongs to, when the run has several. */
  proc?: string;
}

export interface LiveUpdate {
  /** Since following began (ms). */
  elapsedMs: number;
  threads: LiveThread[];
  /** Each thread's call stack, outermost first, as graph entity ids. */
  stacks: { th: number; fns: string[] }[];
  /** Calls since the previous update: caller entity ('' = a thread's first call), callee entity, count. */
  edges: [string, string, number][];
  /** Calls since the previous update, per entity. */
  hot: [string, number][];
  /** Calls so far, all processes. */
  calls: number;
}

export interface LiveSource {
  file: string;
  /** Process label (e.g. the container's service). Several files with one label get `/pid` after it. */
  proc?: string;
  /** C/C++: the instrumenter's function table. */
  fns?: TraceFn[];
  /** Python: maps the tracer's file paths (relative to the root in its header) to workspace paths. */
  mapFile?: (header: Record<string, unknown>) => ((file: string) => string) | undefined;
}

interface LiveRecord {
  th: [number, string, number[]][];
  calls: [number, number][];
  edges: [number, number, number][];
}

interface FileState {
  src: LiveSource;
  offset: number;
  rest: string;
  decoder: StringDecoder;
  header?: Record<string, unknown>;
  map?: (file: string) => string;
  /** Python: function id → entity. */
  py: Map<number, string>;
  live?: LiveRecord;
  /** The process ended (its trace has its end record): its last moment is shown once, then it leaves. */
  ended?: 'now' | 'shown';
  prevCalls: Map<number, number>;
  prevEdges: Map<string, number>;
}

/** A C/C++ file needs only its latest live record: further back than this, the detailed events are skipped. */
const TAIL = 1 << 20;
const MAX_READ = 64 << 20;

/** `cc:net::Server::serve` → serve, `py:app.py:Runner._pump` → _pump, `cc:work@main.c` → work. */
function shortName(entity: string): string {
  return entity.replace(/@[^@]*$/, '').split(/::|\.|:/).pop() || entity;
}

export class LiveTail {
  private files = new Map<string, FileState>();
  private ids = new Map<string, number>();
  private names = new Map<string, string>();
  private locator: EntityLocator;
  private timer?: NodeJS.Timeout;
  private start = Date.now();

  constructor(
    private o: {
      graph: CodeGraph;
      /** The trace files to follow (asked again on every tick: processes start later). */
      sources: () => LiveSource[];
      onUpdate: (u: LiveUpdate) => void;
      intervalMs?: number;
    },
  ) {
    this.locator = new EntityLocator(o.graph);
  }

  begin(): void {
    this.start = Date.now();
    this.timer = setInterval(() => this.tick(), this.o.intervalMs ?? 250);
  }

  end(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reads what the files gained and reports. */
  tick(): void {
    try {
      for (const src of this.o.sources()) {
        if (!this.files.has(src.file)) this.files.set(src.file, { src, offset: 0, rest: '', decoder: new StringDecoder('utf8'), py: new Map(), prevCalls: new Map(), prevEdges: new Map() });
      }
      for (const st of this.files.values()) this.read(st);
      this.o.onUpdate(this.update());
    } catch {
      // a file vanished mid-read, a half-written line: the next tick catches up
    }
  }

  private read(st: FileState): void {
    let fd: number;
    try {
      fd = fs.openSync(st.src.file, 'r');
    } catch {
      return;
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= st.offset) return;
      let from = st.offset;
      let partial = false;
      if (st.header && st.header.lang !== 'python' && size - from > TAIL) {
        from = size - TAIL;
        st.rest = '';
        st.decoder = new StringDecoder('utf8');
        partial = true;
      }
      const len = Math.min(size - from, MAX_READ);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, from);
      st.offset = from + n;
      const lines = (st.rest + st.decoder.write(buf.subarray(0, n))).split('\n');
      st.rest = lines.pop() ?? '';
      if (partial) lines.shift();
      for (const l of lines) this.line(st, l);
    } finally {
      fs.closeSync(fd);
    }
  }

  private line(st: FileState, l: string): void {
    if (!l) return;
    if (!st.header && /^\{"k": ?"h"/.test(l)) {
      try {
        st.header = JSON.parse(l) as Record<string, unknown>;
        st.map = st.src.mapFile?.(st.header);
      } catch {
        /* not a header after all */
      }
      return;
    }
    if (/^\{"k": ?"f"/.test(l)) {
      try {
        const r = JSON.parse(l) as Record<string, unknown>;
        const file = r.file ? (st.map ? st.map(String(r.file)) : String(r.file)) : '';
        st.py.set(Number(r.id), this.locator.locate(file, Number(r.line ?? 0), String(r.name ?? '?'), typeof r.q === 'string' ? r.q : undefined));
      } catch {
        /* half a line */
      }
      return;
    }
    if (/^\{"k": ?"end"/.test(l)) {
      st.ended ??= 'now';
      return;
    }
    // a live record, possibly right after a line a thread had not finished (C/C++ buffers)
    const i = l.search(/\{"k": ?"live"/);
    if (i < 0) return;
    try {
      const r = JSON.parse(l.slice(i)) as Partial<LiveRecord>;
      st.live = { th: r.th ?? [], calls: r.calls ?? [], edges: r.edges ?? [] };
    } catch {
      /* cut off: the next one comes in 200 ms */
    }
  }

  private update(): LiveUpdate {
    const threads: LiveThread[] = [];
    const stacks: LiveUpdate['stacks'] = [];
    const hot = new Map<string, number>();
    const edges = new Map<string, number>();
    let calls = 0;
    const perProc = new Map<string, number>();
    for (const st of this.files.values()) if (st.src.proc !== undefined) perProc.set(st.src.proc, (perProc.get(st.src.proc) ?? 0) + 1);
    for (const st of this.files.values()) {
      const live = st.live;
      if (!live) continue;
      const native = st.header?.lang !== 'python';
      const ent = (f: number) => (native ? (st.src.fns?.[f]?.id ?? '') : (st.py.get(f) ?? ''));
      const proc =
        st.src.proc !== undefined && (perProc.get(st.src.proc) ?? 0) > 1 ? `${st.src.proc}/${String(st.header?.pid ?? '?')}` : st.src.proc;
      const gone = st.ended === 'shown';
      if (st.ended === 'now') st.ended = 'shown';
      for (const [id, name, stack] of gone ? [] : live.th) {
        const key = `${st.src.file}#${id}`;
        let g = this.ids.get(key);
        if (g === undefined) this.ids.set(key, (g = this.ids.size + 1));
        const fns = stack.map(ent).filter(Boolean);
        // threads the OS left unnamed are called after the function they run, as in the trace
        if (/^(thread-\d+|Dummy-\d+|Thread-\d+( \(.*\))?)$/.test(String(name)) && fns.length) this.names.set(key, shortName(fns[0]));
        threads.push({ id: g, name: this.names.get(key) ?? String(name), proc });
        stacks.push({ th: g, fns });
      }
      for (const [f, n] of live.calls) {
        calls += n;
        const d = n - (st.prevCalls.get(f) ?? 0);
        st.prevCalls.set(f, n);
        const e = d > 0 ? ent(f) : '';
        if (e) hot.set(e, (hot.get(e) ?? 0) + d);
      }
      for (const [a, b, n] of live.edges) {
        const k = `${a},${b}`;
        const d = n - (st.prevEdges.get(k) ?? 0);
        st.prevEdges.set(k, n);
        const eb = d > 0 ? ent(b) : '';
        if (!eb) continue;
        const key = `${a >= 0 ? ent(a) : ''}\u0001${eb}`;
        edges.set(key, (edges.get(key) ?? 0) + d);
      }
    }
    const top = <T>(m: Map<string, number>, n: number, f: (k: string, v: number) => T) =>
      [...m].sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => f(k, v));
    return {
      elapsedMs: Date.now() - this.start,
      threads,
      stacks,
      edges: top(edges, 80, (k, v) => [...(k.split('\u0001') as [string, string]), v] as [string, string, number]),
      hot: top(hot, 60, (k, v) => [k, v] as [string, number]),
      calls,
    };
  }
}
