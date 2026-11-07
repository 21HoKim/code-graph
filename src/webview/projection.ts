/**
 * Projection: CodeGraph -> view tree -> visible graph at an abstraction level.
 *
 *   buildTree()  places entities in a containment tree
 *                  files mode:   dir / file / namespace / class / function
 *                  symbols mode: namespace / class / function (merged across files)
 *   project()    decides which tree nodes are expanded (containers) or collapsed
 *                (blocks), lifts every relation to the nearest visible ancestors and
 *                aggregates parallel wires.
 *
 * Pure functions, no DOM: unit-tested in Node.
 */
import type { CodeGraph, Confidence, Entity, FileInfo, Loc, Relation, RelationKind } from '../core/model';

export type ViewKind = 'dir' | 'file' | 'namespace' | 'class' | 'function';
export type GroupMode = 'files' | 'symbols';
export const LEVELS: ViewKind[] = ['dir', 'file', 'namespace', 'class', 'function'];
export const RANK: Record<ViewKind, number> = { dir: 0, file: 1, namespace: 2, class: 3, function: 4 };
export const CONF_RANK: Record<Confidence, number> = { exact: 3, likely: 2, guess: 1 };
export const ALL_KINDS: RelationKind[] = ['call', 'spawn', 'instantiate', 'inherit', 'include', 'import'];

export interface TNode {
  id: string;
  kind: ViewKind;
  label: string;
  /** Short badge text: cpp, h, c, py, ns, pkg, mod, class, struct, fn, ... */
  tag: string;
  parent: string | null;
  children: string[];
  entity?: Entity;
  file?: FileInfo;
  loc?: Loc;
  /** Class implementation fragment living in another file than the class itself. */
  fragment?: boolean;
  /** Number of function nodes in this subtree (self included). */
  fnCount: number;
  depth: number;
}

export interface ViewTree {
  mode: GroupMode;
  nodes: Map<string, TNode>;
  roots: string[];
  /** entity id -> tree node that represents it */
  entityNode: Map<string, string>;
  /** file id ('f:path') -> tree node */
  fileNode: Map<string, string>;
}

const EXT_TAG: Record<string, string> = {
  c: 'c', h: 'h', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', 'c++': 'cpp', hpp: 'hpp', hh: 'hpp', hxx: 'hpp',
  ipp: 'hpp', inl: 'hpp', py: 'py', pyi: 'pyi',
};

function fileTag(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return EXT_TAG[ext] ?? ext;
}

function entityTag(e: Entity): string {
  if (e.kind === 'namespace') return e.sub === 'package' ? 'pkg' : e.sub === 'module' ? 'mod' : 'ns';
  if (e.kind === 'class') return e.sub === 'struct' ? 'struct' : e.sub === 'union' ? 'union' : 'class';
  if (e.sub === 'ctor') return 'new';
  if (e.sub === 'dtor') return 'del';
  return e.sub === 'method' ? 'm' : 'fn';
}

function newTree(mode: GroupMode): ViewTree {
  return { mode, nodes: new Map(), roots: [], entityNode: new Map(), fileNode: new Map() };
}

function addNode(t: ViewTree, n: TNode): TNode {
  t.nodes.set(n.id, n);
  if (n.parent) t.nodes.get(n.parent)!.children.push(n.id);
  else t.roots.push(n.id);
  return n;
}

function entityViewNode(id: string, e: Entity, parent: string | null): TNode {
  return {
    id,
    kind: e.kind === 'namespace' ? 'namespace' : e.kind,
    label: e.name,
    tag: entityTag(e),
    parent,
    children: [],
    entity: e,
    loc: e.def ?? e.decl,
    fnCount: 0,
    depth: 0,
  };
}

export function buildTree(g: CodeGraph, mode: GroupMode): ViewTree {
  const t = mode === 'files' ? buildFilesTree(g) : buildSymbolsTree(g);
  compact(t, 'dir', '/');
  compact(t, 'namespace', '::');
  finalize(t);
  return t;
}

function isFileLevelNamespace(e: Entity): boolean {
  return e.kind === 'namespace' && (e.sub === 'module' || e.sub === 'package');
}

function buildFilesTree(g: CodeGraph): ViewTree {
  const t = newTree('files');
  for (const f of g.files) {
    const parts = f.path.split('/');
    let parent: string | null = null;
    for (let i = 0; i < parts.length - 1; i++) {
      const id = 'd:' + parts.slice(0, i + 1).join('/');
      if (!t.nodes.has(id)) {
        addNode(t, { id, kind: 'dir', label: parts[i], tag: 'dir', parent, children: [], fnCount: 0, depth: 0 });
      }
      parent = id;
    }
    const id = 'f:' + f.path;
    addNode(t, {
      id,
      kind: 'file',
      label: parts[parts.length - 1],
      tag: fileTag(f.path),
      parent,
      children: [],
      file: f,
      loc: { file: f.path, line: 1, endLine: f.lines },
      fnCount: 0,
      depth: 0,
    });
    t.fileNode.set(f.id, id);
  }
  const ents = new Map(g.entities.map((e) => [e.id, e]));
  const order = (e: Entity) => (e.kind === 'class' ? 0 : 1);
  const placed = g.entities
    .filter((e) => e.kind !== 'namespace' && (e.def ?? e.decl))
    .sort((a, b) => order(a) - order(b) || (a.def ?? a.decl)!.line - (b.def ?? b.decl)!.line);
  for (const e of placed) {
    const loc = (e.def ?? e.decl)!;
    const fid = 'f:' + loc.file;
    if (!t.nodes.has(fid)) continue;
    const chain: Entity[] = [];
    for (let p = e.parent ? ents.get(e.parent) : undefined; p; p = p.parent ? ents.get(p.parent) : undefined) {
      if (!isFileLevelNamespace(p)) chain.unshift(p);
    }
    let parent = fid;
    for (const a of chain) {
      const id = fid + '|' + a.id;
      if (!t.nodes.has(id)) {
        const n = addNode(t, entityViewNode(id, a, parent));
        const home = a.def ?? a.decl;
        if (a.kind === 'class' && home && home.file !== loc.file) n.fragment = true;
      }
      parent = id;
    }
    const id = fid + '|' + e.id;
    if (!t.nodes.has(id)) addNode(t, entityViewNode(id, e, parent));
    if (!t.entityNode.has(e.id)) t.entityNode.set(e.id, id);
  }
  for (const e of g.entities) {
    if (e.kind === 'namespace' && e.sub === 'module' && e.def) t.entityNode.set(e.id, 'f:' + e.def.file);
  }
  return t;
}

function buildSymbolsTree(g: CodeGraph): ViewTree {
  const t = newTree('symbols');
  const ents = new Map(g.entities.map((e) => [e.id, e]));
  const depthOf = (e: Entity) => {
    let d = 0;
    for (let p = e.parent ? ents.get(e.parent) : undefined; p && d < 64; p = p.parent ? ents.get(p.parent) : undefined) d++;
    return d;
  };
  const sorted = [...g.entities].sort((a, b) => depthOf(a) - depthOf(b));
  const GLOBAL = 'g:cc';
  for (const e of sorted) {
    let parent: string | null = e.parent && ents.has(e.parent) ? 'e:' + e.parent : null;
    if (!parent && e.lang !== 'python' && e.kind !== 'namespace') {
      if (!t.nodes.has(GLOBAL)) {
        addNode(t, { id: GLOBAL, kind: 'namespace', label: '(global)', tag: 'ns', parent: null, children: [], fnCount: 0, depth: 0 });
      }
      parent = GLOBAL;
    }
    const id = 'e:' + e.id;
    addNode(t, entityViewNode(id, e, parent));
    t.entityNode.set(e.id, id);
    if (e.kind === 'namespace' && e.sub === 'module' && e.def) t.fileNode.set('f:' + e.def.file, id);
  }
  return t;
}

/** Merge single-child chains of the same kind: src/ -> net/ becomes "src/net". */
function compact(t: ViewTree, kind: ViewKind, sep: string): void {
  const remap = new Map<string, string>();
  for (const id of [...t.nodes.keys()]) {
    const n = t.nodes.get(id);
    if (!n || n.kind !== kind || n.children.length !== 1) continue;
    const c = t.nodes.get(n.children[0])!;
    if (c.kind !== kind || c.entity?.sub === 'module' || n.entity?.sub === 'module') continue;
    // splice n out: c takes its place
    const s = n.entity?.lang === 'python' || c.entity?.lang === 'python' ? '.' : sep;
    c.label = n.label + s + c.label;
    c.parent = n.parent;
    const siblings = n.parent ? t.nodes.get(n.parent)!.children : t.roots;
    siblings[siblings.indexOf(n.id)] = c.id;
    t.nodes.delete(n.id);
    remap.set(n.id, c.id);
  }
  if (!remap.size) return;
  const resolve = (id: string) => {
    let r = id;
    for (let i = 0; i < 64 && remap.has(r); i++) r = remap.get(r)!;
    return r;
  };
  for (const m of [t.entityNode, t.fileNode]) for (const [k, v] of m) if (remap.has(v)) m.set(k, resolve(v));
}

function finalize(t: ViewTree): void {
  const rank = (n: TNode) => (n.kind === 'dir' ? 0 : n.kind === 'file' ? 1 : n.kind === 'namespace' ? 2 : n.kind === 'class' ? 3 : 4);
  const walk = (id: string, depth: number): number => {
    const n = t.nodes.get(id)!;
    n.depth = depth;
    n.children.sort((a, b) => {
      const A = t.nodes.get(a)!;
      const B = t.nodes.get(b)!;
      return rank(A) - rank(B) || (A.loc?.line ?? 0) - (B.loc?.line ?? 0) || A.label.localeCompare(B.label);
    });
    let c = n.kind === 'function' ? 1 : 0;
    for (const ch of n.children) c += walk(ch, depth + 1);
    n.fnCount = c;
    return c;
  };
  t.roots.sort((a, b) => rank(t.nodes.get(a)!) - rank(t.nodes.get(b)!) || t.nodes.get(a)!.label.localeCompare(t.nodes.get(b)!.label));
  for (const r of t.roots) walk(r, 0);
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export interface ProjectOptions {
  level: ViewKind;
  expand: Set<string>;
  collapse: Set<string>;
  kinds: Set<RelationKind>;
  minConf: Confidence;
  focus?: { id: string; hops: number } | null;
  hideIsolated?: boolean;
}

export interface PNode {
  id: string;
  t: TNode;
  container: boolean;
  parent: string | null;
  children: string[];
  /** relations whose both ends fell inside this block */
  internal: number;
  degIn: number;
  degOut: number;
}

export interface PEdge {
  id: string;
  kind: RelationKind;
  src: string;
  dst: string;
  count: number;
  conf: Confidence;
  rels: Relation[];
  /** lowest common visible container, null = root */
  lca: string | null;
  /** callee returns a value: data flows back along the wire */
  returns: boolean;
}

export interface Projection {
  nodes: Map<string, PNode>;
  roots: string[];
  edges: PEdge[];
  leaves: number;
}

export function effectiveLevel(tree: ViewTree, level: ViewKind): ViewKind {
  return tree.mode === 'symbols' && RANK[level] < RANK.namespace ? 'namespace' : level;
}

export function isExpanded(tree: ViewTree, n: TNode, o: Pick<ProjectOptions, 'level' | 'expand' | 'collapse'>): boolean {
  if (!n.children.length) return false;
  if (o.collapse.has(n.id)) return false;
  if (o.expand.has(n.id)) return true;
  const r = RANK[n.kind];
  const L = RANK[effectiveLevel(tree, o.level)];
  if (r < L) return true;
  // nested namespaces / classes open up to show the finest unit of that kind;
  // folders do not (that would spill their loose files onto the Folder level)
  if (r === L && n.kind !== 'dir') return n.children.some((c) => tree.nodes.get(c)!.kind === n.kind);
  return false;
}

export function project(tree: ViewTree, g: CodeGraph, o: ProjectOptions): Projection {
  const nodes = new Map<string, PNode>();
  const visit = (id: string, parent: string | null) => {
    const t = tree.nodes.get(id)!;
    const container = isExpanded(tree, t, o);
    const p: PNode = { id, t, container, parent, children: [], internal: 0, degIn: 0, degOut: 0 };
    nodes.set(id, p);
    if (container) {
      for (const c of t.children) {
        visit(c, id);
        p.children.push(c);
      }
    }
  };
  for (const r of tree.roots) visit(r, null);

  const repCache = new Map<string, string | undefined>();
  const rep = (id: string): string | undefined => {
    if (nodes.has(id)) return id;
    if (repCache.has(id)) return repCache.get(id);
    let cur: string | null | undefined = id;
    while (cur && !nodes.has(cur)) cur = tree.nodes.get(cur)?.parent;
    repCache.set(id, cur ?? undefined);
    return cur ?? undefined;
  };
  const isAncestor = (a: string, b: string) => {
    for (let c = nodes.get(b)?.parent ?? null; c; c = nodes.get(c)?.parent ?? null) if (c === a) return true;
    return false;
  };
  const endpoint = (id: string) => (id.startsWith('f:') ? tree.fileNode.get(id) : tree.entityNode.get(id));
  const entities = new Map(g.entities.map((e) => [e.id, e]));

  const agg = new Map<string, PEdge>();
  const minRank = CONF_RANK[o.minConf];
  for (const r of g.relations) {
    if (!o.kinds.has(r.kind) || CONF_RANK[r.conf] < minRank) continue;
    const a = endpoint(r.from);
    const b = endpoint(r.to);
    if (!a || !b) continue;
    const ra = rep(a);
    const rb = rep(b);
    if (!ra || !rb) continue;
    if (ra === rb || isAncestor(ra, rb) || isAncestor(rb, ra)) {
      nodes.get(ra === rb ? ra : isAncestor(ra, rb) ? ra : rb)!.internal += r.count;
      continue;
    }
    const structural = r.kind === 'include' || r.kind === 'import';
    if (structural && (nodes.get(ra)!.container || nodes.get(rb)!.container)) continue;
    const key = ra + '\u0000' + rb + '\u0000' + r.kind;
    let e = agg.get(key);
    if (!e) {
      e = { id: 'e' + agg.size, kind: r.kind, src: ra, dst: rb, count: 0, conf: r.conf, rels: [], lca: null, returns: false };
      agg.set(key, e);
    }
    e.count += r.count;
    e.rels.push(r);
    if (CONF_RANK[r.conf] > CONF_RANK[e.conf]) e.conf = r.conf;
    if (r.kind === 'call') {
      const ret = entities.get(r.to)?.returns;
      if (ret && !/^(void|None|-> None)$/.test(ret.trim())) e.returns = true;
    }
  }
  let edges = [...agg.values()];

  let roots = [...tree.roots];
  const keepOnly = (keep: Set<string>) => {
    for (const id of [...nodes.keys()]) if (!keep.has(id)) nodes.delete(id);
    for (const n of nodes.values()) n.children = n.children.filter((c) => nodes.has(c));
    roots = roots.filter((r) => nodes.has(r));
    edges = edges.filter((e) => nodes.has(e.src) && nodes.has(e.dst));
  };
  const withAncestors = (ids: Iterable<string>) => {
    const keep = new Set<string>();
    for (const id of ids) for (let c: string | null = id; c && !keep.has(c); c = nodes.get(c)?.parent ?? null) keep.add(c);
    return keep;
  };

  if (o.focus) {
    const start = rep(o.focus.id) ?? (nodes.has(o.focus.id) ? o.focus.id : undefined);
    if (start) {
      const adj = new Map<string, string[]>();
      const link = (a: string, b: string) => (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
      for (const e of edges) {
        link(e.src, e.dst);
        link(e.dst, e.src);
      }
      // a focused container brings its whole visible subtree
      const seeds = [start];
      const stack = [start];
      while (stack.length) {
        const n = nodes.get(stack.pop()!)!;
        for (const c of n.children) {
          seeds.push(c);
          stack.push(c);
        }
      }
      const dist = new Map<string, number>(seeds.map((s) => [s, 0]));
      const queue = [...seeds];
      while (queue.length) {
        const cur = queue.shift()!;
        const d = dist.get(cur)!;
        if (d >= o.focus.hops) continue;
        for (const nb of adj.get(cur) ?? []) {
          if (!dist.has(nb)) {
            dist.set(nb, d + 1);
            queue.push(nb);
          }
        }
      }
      keepOnly(withAncestors(dist.keys()));
    }
  }
  if (o.hideIsolated) {
    const used = new Set<string>();
    for (const e of edges) {
      used.add(e.src);
      used.add(e.dst);
    }
    const leaves = [...nodes.values()].filter((n) => !n.container && used.has(n.id)).map((n) => n.id);
    keepOnly(withAncestors(leaves));
  }

  // lowest common ancestor container for each edge (ELK wants edges there)
  const chain = (id: string) => {
    const out: string[] = [];
    for (let c = nodes.get(id)?.parent ?? null; c; c = nodes.get(c)?.parent ?? null) out.push(c);
    return out;
  };
  for (const e of edges) {
    const a = new Set(chain(e.src));
    e.lca = chain(e.dst).find((c) => a.has(c)) ?? null;
    nodes.get(e.src)!.degOut += e.count;
    nodes.get(e.dst)!.degIn += e.count;
  }
  let leaves = 0;
  for (const n of nodes.values()) if (!n.container) leaves++;
  return { nodes, roots, edges, leaves };
}

/** Count visible blocks at each level (used to pick a readable starting level). */
export function leavesAtLevel(tree: ViewTree, level: ViewKind): number {
  let n = 0;
  const empty = new Set<string>();
  const o = { level, expand: empty, collapse: empty };
  const walk = (id: string) => {
    const t = tree.nodes.get(id)!;
    if (isExpanded(tree, t, o)) t.children.forEach(walk);
    else n++;
  };
  tree.roots.forEach(walk);
  return n;
}

export function pickLevel(tree: ViewTree, maxBlocks = 40): ViewKind {
  const order: ViewKind[] = tree.mode === 'symbols' ? ['namespace', 'class', 'function'] : ['dir', 'file', 'namespace', 'class', 'function'];
  let best: ViewKind = order[0];
  for (const l of order) {
    if (leavesAtLevel(tree, l) <= maxBlocks) best = l;
    else break;
  }
  return best;
}

export function ancestorsOf(tree: ViewTree, id: string): string[] {
  const out: string[] = [];
  for (let c = tree.nodes.get(id)?.parent ?? null; c; c = tree.nodes.get(c)?.parent ?? null) out.push(c);
  return out;
}
