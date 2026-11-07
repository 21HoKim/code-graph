/**
 * Health of the circuit: where it is broken and how far the damage spreads.
 *
 *   broken     a block that has an error (compile error, parse failure, missing implementation,
 *              undefined name, runtime exception…)
 *   cut        a wire that leads into a broken block — current cannot pass
 *   affected   every block that (transitively) depends on a broken one: callers, creators, subclasses,
 *              includers / importers. `dist` = how many hops away the break is.
 *   unpowered  blocks the program's entry points (main, __main__) can only reach *through* a broken
 *              block: with the break, current never arrives there
 *   dead       wires that carry no current any more (they leave a broken or unpowered block)
 *
 * Pure functions over the CodeGraph: no Node or DOM dependencies (used by the webview and tests).
 */
import type { CodeGraph, Diagnostic, Relation } from './model';

export interface Affected {
  dist: number;
  /** relation that links this block to the next block on the way to the break */
  via: string;
  /** the broken block this impact comes from */
  cause: string;
}

export interface Health {
  broken: Map<string, Diagnostic[]>;
  warnings: Map<string, Diagnostic[]>;
  affected: Map<string, Affected>;
  unpowered: Set<string>;
  cut: Set<string>;
  dead: Set<string>;
  entries: string[];
  errors: number;
  warningCount: number;
}

const DEPENDENCY: ReadonlySet<string> = new Set(['call', 'spawn', 'instantiate', 'inherit', 'include', 'import']);
const HEADER = /\.(h|hh|hpp|hxx|h\+\+|inl|ipp)$/i;
/** Problems that stop a file from compiling (so everything including it fails too). */
const COMPILE_BREAKING: ReadonlySet<string> = new Set(['compiler', 'syntax', 'editor']);
/** Failures that take a whole file down (the module cannot be imported / the TU cannot start). */
const WHOLE_FILE = /^(SyntaxError|IndentationError|TabError|cannot resolve relative import)|No such file or directory|file not found/;
const CURRENT: ReadonlySet<string> = new Set(['call', 'spawn', 'instantiate']);

/** Give every diagnostic a target: the innermost function/class containing its line, else its file. */
export function attachDiagnostics(g: CodeGraph, diags: Diagnostic[]): Diagnostic[] {
  const byFile = new Map<string, { id: string; line: number; end: number }[]>();
  for (const e of g.entities) {
    if (e.kind === 'namespace' && e.sub !== 'module') continue;
    for (const loc of [e.def, e.decl]) {
      if (!loc) continue;
      let list = byFile.get(loc.file);
      if (!list) byFile.set(loc.file, (list = []));
      list.push({ id: e.id, line: loc.line, end: loc.endLine });
    }
  }
  const files = new Set(g.files.map((f) => f.path));
  return diags.map((d) => {
    if (d.target) return d;
    if (WHOLE_FILE.test(d.message) && files.has(d.file)) return { ...d, target: 'f:' + d.file };
    let best: { id: string; line: number; end: number } | undefined;
    for (const r of byFile.get(d.file) ?? []) {
      if (d.line < r.line || d.line > r.end) continue;
      if (!best || r.end - r.line < best.end - best.line) best = r;
    }
    return { ...d, target: best?.id ?? (files.has(d.file) ? 'f:' + d.file : undefined) };
  });
}

export function computeHealth(g: CodeGraph, diags: Diagnostic[]): Health {
  const broken = new Map<string, Diagnostic[]>();
  const warnings = new Map<string, Diagnostic[]>();
  let errors = 0;
  let warningCount = 0;
  for (const d of diags) {
    if (!d.target) continue;
    const m = d.severity === 'error' ? broken : warnings;
    const list = m.get(d.target);
    if (list) list.push(d);
    else m.set(d.target, [d]);
    if (d.severity === 'error') errors++;
    else warningCount++;
  }

  // python module code is "the module" in the graph; files hold include/import edges
  const moduleOfFile = new Map<string, string>();
  for (const e of g.entities) if (e.kind === 'namespace' && e.sub === 'module' && e.def) moduleOfFile.set('f:' + e.def.file, e.id);
  // a broken file breaks its python module too (and vice versa), so both edge kinds see it
  for (const [fid, mid] of moduleOfFile) {
    if (broken.has(fid) && !broken.has(mid)) broken.set(mid, broken.get(fid)!);
    else if (broken.has(mid) && !broken.has(fid)) broken.set(fid, broken.get(mid)!);
  }

  // where the break propagates from: broken blocks, plus headers that no longer compile
  const seeds = new Set<string>(broken.keys());
  for (const ds of broken.values()) {
    for (const d of ds) if (COMPILE_BREAKING.has(d.source) && HEADER.test(d.file)) seeds.add('f:' + d.file);
  }
  // a file that fails as a whole takes every symbol defined in it down with it
  const brokenFiles = new Set([...seeds].filter((id) => id.startsWith('f:')));
  if (brokenFiles.size) {
    for (const e of g.entities) {
      const f = (e.def ?? e.decl)?.file;
      if (f && brokenFiles.has('f:' + f)) seeds.add(e.id);
    }
  }

  const reverse = new Map<string, Relation[]>();
  const forward = new Map<string, Relation[]>();
  for (const r of g.relations) {
    if (DEPENDENCY.has(r.kind)) {
      let l = reverse.get(r.to);
      if (!l) reverse.set(r.to, (l = []));
      l.push(r);
    }
    if (CURRENT.has(r.kind)) {
      let l = forward.get(r.from);
      if (!l) forward.set(r.from, (l = []));
      l.push(r);
    }
  }

  // cut wires and upstream impact (breadth-first: nearest break wins)
  const cut = new Set<string>();
  const affected = new Map<string, Affected>();
  const queue: string[] = [];
  for (const b of seeds) {
    for (const r of reverse.get(b) ?? []) cut.add(r.id);
    queue.push(b);
  }
  const causeOf = new Map<string, string>([...seeds].map((b) => [b, b]));
  const distOf = new Map<string, number>([...seeds].map((b) => [b, 0]));
  while (queue.length) {
    const cur = queue.shift()!;
    const d = distOf.get(cur)!;
    for (const r of reverse.get(cur) ?? []) {
      const dep = r.from;
      if (seeds.has(dep) || distOf.has(dep)) continue;
      distOf.set(dep, d + 1);
      causeOf.set(dep, causeOf.get(cur)!);
      affected.set(dep, { dist: d + 1, via: r.id, cause: causeOf.get(cur)! });
      queue.push(dep);
      // an importing/including file means its module code depends on the break as well
      const mod = moduleOfFile.get(dep);
      if (mod && !broken.has(mod) && !distOf.has(mod)) {
        distOf.set(mod, d + 1);
        causeOf.set(mod, causeOf.get(cur)!);
        affected.set(mod, { dist: d + 1, via: r.id, cause: causeOf.get(cur)! });
        queue.push(mod);
      }
    }
  }

  // downstream: what can current still reach from the entry points?
  const entries = g.entities.filter((e) => e.flags?.includes('entry')).map((e) => e.id);
  const reach = (blockBroken: boolean): Set<string> => {
    const seen = new Set<string>(entries);
    const q = [...entries];
    while (q.length) {
      const cur = q.shift()!;
      if (blockBroken && seeds.has(cur)) continue; // a break stops the current here
      for (const r of forward.get(cur) ?? []) {
        if (!seen.has(r.to)) {
          seen.add(r.to);
          q.push(r.to);
        }
      }
    }
    return seen;
  };
  const unpowered = new Set<string>();
  const dead = new Set<string>();
  if (entries.length && seeds.size) {
    const all = reach(false);
    const powered = reach(true);
    for (const id of all) if (!powered.has(id) && !seeds.has(id)) unpowered.add(id);
    for (const r of g.relations) if (CURRENT.has(r.kind) && (seeds.has(r.from) || unpowered.has(r.from))) dead.add(r.id);
  }

  return { broken, warnings, affected, unpowered, cut, dead, entries, errors, warningCount };
}

/** Walk the impact chain from an affected block back to the break: [block, next, …, broken]. */
export function impactPath(h: Health, g: CodeGraph, id: string, max = 12): { node: string; rel?: Relation }[] {
  const rels = new Map(g.relations.map((r) => [r.id, r]));
  const out: { node: string; rel?: Relation }[] = [{ node: id }];
  let cur = id;
  for (let i = 0; i < max; i++) {
    const a = h.affected.get(cur);
    if (!a) break;
    const r = rels.get(a.via);
    if (!r) break;
    out[out.length - 1].rel = r;
    cur = r.to;
    out.push({ node: cur });
    if (h.broken.has(cur)) break;
  }
  return out;
}
