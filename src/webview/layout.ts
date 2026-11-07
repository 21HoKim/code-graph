/**
 * ELK layout. Two styles share one renderer:
 *   circuit – layered left→right, orthogonal "PCB trace" wires
 *   network – layered top→down, polyline wires drawn as smooth curves
 * Both use INCLUDE_CHILDREN so wires are routed across nesting levels.
 */
import type { PNode, Projection } from './projection';

export type LayoutStyle = 'circuit' | 'network';
/** Main signal direction. Circuit flows left→right on wide screens, top→down on tall (phone) screens. */
export type FlowDir = 'RIGHT' | 'DOWN';

export interface Pt {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface LayoutResult {
  boxes: Map<string, Box>;
  routes: Map<string, Pt[]>;
  width: number;
  height: number;
  ms: number;
  fallback?: boolean;
  /** Large view: containers laid out independently, wires drawn as elbows. */
  fast?: boolean;
}

/**
 * Full hierarchical routing is the prettiest for small views but sprawls (≈2% of the area covered by blocks)
 * and gets slow quickly; the compact layout is 3-5x denser and much faster on mid-size views
 * (measured on cJSON, requests and Redis).
 */
export const FULL_ROUTING_MAX_WIRES = 140;
export const FULL_ROUTING_MAX_BLOCKS = 160;
const PACK_ABOVE_CHILDREN = 60;

/** Minimal surface of elkjs we use (keeps the bundle typing simple). */
export interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
}

export interface ElkNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkNode[];
  edges?: ElkEdge[];
  layoutOptions?: Record<string, string>;
}
interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  sections?: { startPoint: Pt; endPoint: Pt; bendPoints?: Pt[] }[];
}

export type Measure = (text: string, font: string) => number;

export const FONT_TITLE = '600 12px var(--cc-font)';
export const FONT_SUB = '10.5px var(--cc-mono)';
export const FONT_HEAD = '600 12px var(--cc-font)';
export const FONT_TAG = '600 9px var(--cc-mono)';
export const HEADER_H = 28;
const PAD = 14;

export interface NodeLabel {
  title: string;
  sub?: string;
}

export function signature(n: PNode): string | undefined {
  const e = n.t.entity;
  if (!e || e.kind !== 'function') return undefined;
  const ps = (e.params ?? []).map((p) => (p.type ? p.type : p.name ?? '?')).join(', ');
  const ret = e.returns ? ` → ${e.returns}` : '';
  return `(${ps})${ret}`;
}

export function labelOf(n: PNode, counts: (n: PNode) => string): NodeLabel {
  const t = n.t;
  if (n.container) return { title: t.label };
  if (t.kind === 'function' && !t.children.length) return { title: t.label, sub: truncate(signature(n) ?? '', 38) };
  return { title: t.label, sub: counts(n) };
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function tagWidth(tag: string, measure: Measure): number {
  return Math.ceil(measure(tag, FONT_TAG)) + 8;
}

export function leafSize(n: PNode, label: NodeLabel, measure: Measure): { w: number; h: number } {
  const title = truncate(label.title, 34);
  const tw = measure(title, FONT_TITLE);
  const sw = label.sub ? measure(label.sub, FONT_SUB) : 0;
  const w = Math.ceil(Math.max(tw + tagWidth(n.t.tag, measure) + 6, sw) + 26);
  return { w: Math.max(96, Math.min(300, w)), h: label.sub ? 42 : 30 };
}

function rootOptions(style: LayoutStyle, dir: FlowDir, hierarchy: 'INCLUDE_CHILDREN' | 'SEPARATE_CHILDREN'): Record<string, string> {
  const circuit = style === 'circuit';
  return {
    'elk.algorithm': 'layered',
    'elk.direction': dir,
    'elk.hierarchyHandling': hierarchy,
    'elk.edgeRouting': circuit ? 'ORTHOGONAL' : 'POLYLINE',
    'elk.layered.spacing.nodeNodeBetweenLayers': circuit ? '64' : '56',
    'elk.spacing.nodeNode': circuit ? '20' : '28',
    'elk.spacing.edgeNode': '14',
    'elk.spacing.edgeEdge': '6',
    'elk.layered.spacing.edgeNodeBetweenLayers': '14',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '6',
    'elk.spacing.componentComponent': '36',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
    'elk.layered.mergeEdges': 'false',
    'elk.aspectRatio': dir === 'DOWN' ? '0.7' : '1.6',
    'org.eclipse.elk.json.shapeCoords': 'ROOT',
    'org.eclipse.elk.json.edgeCoords': 'ROOT',
  };
}

export function buildElkGraph(
  p: Projection,
  style: LayoutStyle,
  dir: FlowDir,
  measure: Measure,
  counts: (n: PNode) => string,
  hierarchy: 'INCLUDE_CHILDREN' | 'SEPARATE_CHILDREN' = 'INCLUDE_CHILDREN',
): ElkNode {
  const root: ElkNode = { id: '__root', layoutOptions: rootOptions(style, dir, hierarchy), children: [], edges: [] };
  const byId = new Map<string, ElkNode>([['__root', root]]);
  const build = (id: string, parent: ElkNode) => {
    const n = p.nodes.get(id)!;
    const e: ElkNode = { id };
    if (n.container) {
      const headW = measure(n.t.label, FONT_HEAD) + tagWidth(n.t.tag, measure) + 56;
      e.children = [];
      e.edges = [];
      e.layoutOptions = {
        'elk.padding': `[top=${HEADER_H + 10},left=${PAD},bottom=${PAD},right=${PAD}]`,
        'elk.nodeSize.constraints': '[MINIMUM_SIZE]',
        'elk.nodeSize.minimum': `(${Math.ceil(headW)}, 64)`,
      };
      for (const c of n.children) build(c, e);
    } else {
      const s = leafSize(n, labelOf(n, counts), measure);
      e.width = s.w;
      e.height = s.h;
    }
    parent.children!.push(e);
    byId.set(id, e);
  };
  for (const r of p.roots) build(r, root);
  if (hierarchy === 'INCLUDE_CHILDREN') {
    for (const e of p.edges) {
      const host = (e.lca && byId.get(e.lca)) || root;
      host.edges!.push({ id: e.id, sources: [e.src], targets: [e.dst] });
    }
  } else {
    // fallback: only sibling edges guide placement; wires are drawn straight
    const parentOf = (id: string) => p.nodes.get(id)?.parent ?? null;
    const lift = (id: string, lca: string | null) => {
      let cur = id;
      while (parentOf(cur) !== lca) cur = parentOf(cur)!;
      return cur;
    };
    const seen = new Set<string>();
    for (const e of p.edges) {
      const a = lift(e.src, e.lca);
      const b = lift(e.dst, e.lca);
      if (a === b || seen.has(a + '>' + b)) continue;
      seen.add(a + '>' + b);
      const host = (e.lca && byId.get(e.lca)) || root;
      host.edges!.push({ id: 'L' + seen.size, sources: [a], targets: [b] });
    }
  }
  return root;
}

/** Cheap per-container settings for big views: pack crowded containers, light layering elsewhere. */
function tuneFast(n: ElkNode): void {
  const kids = n.children?.length ?? 0;
  if (kids) {
    n.layoutOptions ??= {};
    if (kids > PACK_ABOVE_CHILDREN) {
      n.layoutOptions['elk.algorithm'] = 'rectpacking';
      n.layoutOptions['elk.spacing.nodeNode'] = '18';
      n.edges = [];
    } else {
      n.layoutOptions['elk.layered.thoroughness'] = '2';
      n.layoutOptions['elk.layered.crossingMinimization.greedySwitch.type'] = 'OFF';
      n.layoutOptions['elk.layered.nodePlacement.strategy'] = 'BRANDES_KOEPF';
    }
  }
  for (const c of n.children ?? []) tuneFast(c);
}

/** One-bend "circuit" wire between two boxes, used when ELK did not route. */
function elbow(a: Box, b: Box, dir: FlowDir): Pt[] {
  const ca = center(a);
  const cb = center(b);
  const horizontal = dir === 'RIGHT' ? Math.abs(cb.x - ca.x) >= Math.abs(cb.y - ca.y) * 0.6 : Math.abs(cb.x - ca.x) > Math.abs(cb.y - ca.y) * 1.6;
  if (horizontal) {
    const s = { x: cb.x >= ca.x ? a.x + a.w : a.x, y: ca.y };
    const e = { x: cb.x >= ca.x ? b.x : b.x + b.w, y: cb.y };
    const mx = (s.x + e.x) / 2;
    return Math.abs(s.y - e.y) < 1 ? [s, e] : [s, { x: mx, y: s.y }, { x: mx, y: e.y }, e];
  }
  const s = { x: ca.x, y: cb.y >= ca.y ? a.y + a.h : a.y };
  const e = { x: cb.x, y: cb.y >= ca.y ? b.y : b.y + b.h };
  const my = (s.y + e.y) / 2;
  return Math.abs(s.x - e.x) < 1 ? [s, e] : [s, { x: s.x, y: my }, { x: e.x, y: my }, e];
}

function collect(n: ElkNode, boxes: Map<string, Box>, routes: Map<string, Pt[]>): void {
  for (const c of n.children ?? []) {
    boxes.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 });
    collect(c, boxes, routes);
  }
  for (const e of n.edges ?? []) {
    const s = e.sections?.[0];
    if (!s) continue;
    routes.set(e.id, [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]);
  }
}

function center(b: Box): Pt {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** Point where the segment from the box centre towards `to` leaves the box. */
function borderPoint(b: Box, to: Pt): Pt {
  const c = center(b);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  if (!dx && !dy) return c;
  const sx = dx ? b.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy ? b.h / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

export async function runLayout(
  elk: ElkLike,
  p: Projection,
  style: LayoutStyle,
  dir: FlowDir,
  measure: Measure,
  counts: (n: PNode) => string,
  routing: 'auto' | 'full' | 'fast' = 'auto',
): Promise<LayoutResult> {
  const t0 = performance.now();
  const fast = routing === 'fast' || (routing === 'auto' && (p.edges.length > FULL_ROUTING_MAX_WIRES || p.leaves > FULL_ROUTING_MAX_BLOCKS));
  let fallback = false;
  let out: ElkNode;
  const separate = () => {
    const g = buildElkGraph(p, style, dir, measure, counts, 'SEPARATE_CHILDREN');
    tuneFast(g);
    return elk.layout(g);
  };
  if (fast) out = await separate();
  else {
    try {
      out = await elk.layout(buildElkGraph(p, style, dir, measure, counts));
    } catch (err) {
      console.warn('[CodeCurrent] hierarchical layout failed, falling back', err);
      fallback = true;
      out = await separate();
    }
  }
  const boxes = new Map<string, Box>();
  const routes = new Map<string, Pt[]>();
  collect(out, boxes, routes);
  if (fast || fallback) routes.clear();
  for (const e of p.edges) {
    if (routes.has(e.id)) continue;
    const a = boxes.get(e.src);
    const b = boxes.get(e.dst);
    if (!a || !b) continue;
    routes.set(e.id, style === 'circuit' ? elbow(a, b, dir) : [borderPoint(a, center(b)), borderPoint(b, center(a))]);
  }
  return { boxes, routes, width: out.width ?? 0, height: out.height ?? 0, ms: performance.now() - t0, fallback, fast };
}

// ---------------------------------------------------------------------------
// Path geometry shared by SVG wires and flow particles
// ---------------------------------------------------------------------------

/** Orthogonal polyline with rounded corners. */
export function roundedPath(pts: Pt[], r = 7): string {
  if (pts.length < 2) return '';
  let d = `M${f(pts[0].x)},${f(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const l1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const l2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    if (rr < 0.5) {
      d += `L${f(p1.x)},${f(p1.y)}`;
      continue;
    }
    const a = { x: p1.x + ((p0.x - p1.x) / l1) * rr, y: p1.y + ((p0.y - p1.y) / l1) * rr };
    const b = { x: p1.x + ((p2.x - p1.x) / l2) * rr, y: p1.y + ((p2.y - p1.y) / l2) * rr };
    d += `L${f(a.x)},${f(a.y)}Q${f(p1.x)},${f(p1.y)} ${f(b.x)},${f(b.y)}`;
  }
  const last = pts[pts.length - 1];
  return d + `L${f(last.x)},${f(last.y)}`;
}

/** Catmull-Rom spline through the points (network style). */
export function smoothPath(pts: Pt[]): string {
  if (pts.length < 3) return roundedPath(pts);
  let d = `M${f(pts[0].x)},${f(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += `C${f(c1.x)},${f(c1.y)} ${f(c2.x)},${f(c2.y)} ${f(p2.x)},${f(p2.y)}`;
  }
  return d;
}

/** Points along the drawn curve, for particles. */
export function samplePath(pts: Pt[], smooth: boolean): Pt[] {
  if (!smooth || pts.length < 3) return pts;
  const out: Pt[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    for (let s = 1; s <= 8; s++) {
      const t = s / 8;
      const u = 1 - t;
      out.push({
        x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
        y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y,
      });
    }
  }
  return out;
}

function f(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}
