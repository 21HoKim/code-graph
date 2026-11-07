/**
 * SVG renderer: zones (expanded containers), wires, blocks, data labels.
 * Built as strings and swapped in one go — fast for thousands of elements.
 */
import type { Overlay } from './overlay';
import type { PEdge, PNode, Projection } from './projection';
import {
  HEADER_H,
  labelOf,
  roundedPath,
  smoothPath,
  tagWidth,
  truncate,
  type FlowDir,
  type LayoutResult,
  type LayoutStyle,
  type Measure,
  type Pt,
} from './layout';

const NS = 'http://www.w3.org/2000/svg';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface Highlight {
  node?: string;
  nodes: Set<string>;
  edges: Set<string>;
}

export function edgePath(pts: Pt[], style: LayoutStyle): string {
  return style === 'network' ? smoothPath(pts) : roundedPath(pts);
}

export class Renderer {
  readonly svg: SVGSVGElement;
  private world: SVGGElement;
  private gGrid: SVGGElement;
  private gZones: SVGGElement;
  private gEdges: SVGGElement;
  private gBreaks: SVGGElement;
  private gHits: SVGGElement;
  private gNodes: SVGGElement;
  private gLabels: SVGGElement;
  private els = new Map<string, Element[]>();
  private current?: { proj: Projection; layout: LayoutResult; style: LayoutStyle };

  constructor(stage: HTMLElement) {
    this.svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
    this.svg.classList.add('cc-svg');
    this.svg.innerHTML = `
      <defs>
        <pattern id="cc-grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" class="grid-dot"/>
        </pattern>
        ${['call', 'spawn', 'instantiate', 'include', 'import']
          .map(
            (k) => `<marker id="cc-a-${k}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <path d="M0,1.2 L9,5 L0,8.8 z" class="mk mk-${k}"/></marker>`,
          )
          .join('')}
        <marker id="cc-a-inherit" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="11" markerHeight="11" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
          <path d="M1,1 L11,6 L1,11 z" class="mk mk-inherit"/></marker>
      </defs>
      <g class="world">
        <g class="grid"></g><g class="zones"></g><g class="edges"></g><g class="breaks"></g><g class="hits"></g><g class="nodes"></g><g class="labels"></g>
      </g>`;
    stage.appendChild(this.svg);
    this.world = this.svg.querySelector('.world')!;
    this.gGrid = this.svg.querySelector('.grid')!;
    this.gZones = this.svg.querySelector('.zones')!;
    this.gEdges = this.svg.querySelector('.edges')!;
    this.gBreaks = this.svg.querySelector('.breaks')!;
    this.gHits = this.svg.querySelector('.hits')!;
    this.gNodes = this.svg.querySelector('.nodes')!;
    this.gLabels = this.svg.querySelector('.labels')!;
  }

  setTransform(x: number, y: number, k: number): void {
    this.world.setAttribute('transform', `translate(${x},${y}) scale(${k})`);
    this.svg.classList.toggle('far', k < 0.5);
    this.svg.classList.toggle('veryfar', k < 0.24);
  }

  draw(
    proj: Projection,
    layout: LayoutResult,
    style: LayoutStyle,
    dir: FlowDir,
    measure: Measure,
    counts: (n: PNode) => string,
    overlay?: Overlay,
    extraClass?: (e: PEdge) => string,
  ): void {
    this.current = { proj, layout, style };
    const zones: string[] = [];
    const nodes: string[] = [];
    const ordered = [...proj.nodes.values()].sort((a, b) => a.t.depth - b.t.depth);
    for (const n of ordered) {
      const b = layout.boxes.get(n.id);
      if (!b) continue;
      if (n.container) zones.push(this.zone(n, b, measure, overlay));
      else nodes.push(this.block(n, b, dir, measure, counts, overlay));
    }
    const edges: string[] = [];
    const hits: string[] = [];
    const breaks: string[] = [];
    for (const e of proj.edges) {
      const pts = layout.routes.get(e.id);
      if (!pts || pts.length < 2) continue;
      const d = edgePath(pts, style);
      const w = Math.min(4.5, 1.25 + Math.log2(1 + e.count) * 0.55);
      const st = overlay?.wires.get(e.id);
      const extra = extraClass?.(e) ?? '';
      edges.push(
        `<path class="e k-${e.kind} c-${e.conf}${st ? ' ' + st : ''}${extra ? ' ' + extra : ''}" data-id="${e.id}" d="${d}" style="stroke-width:${w.toFixed(2)}" marker-end="url(#cc-a-${e.kind})"/>`,
      );
      hits.push(`<path class="eh" data-id="${e.id}" data-edge="1" d="${d}"/>`);
      if (st === 'cut') {
        // the wire is severed just before it reaches the broken block
        const { p, angle } = pointAlong(pts, BREAK_AT);
        breaks.push(
          `<g class="brk" data-id="${e.id}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)}) rotate(${angle.toFixed(1)})">` +
            `<circle r="7"/><line x1="-3" y1="-6" x2="-1" y2="6"/><line x1="2" y1="-6" x2="4" y2="6"/></g>`,
        );
      }
    }
    const m = 2000;
    this.gGrid.innerHTML = `<rect x="${-m}" y="${-m}" width="${layout.width + 2 * m}" height="${layout.height + 2 * m}" fill="url(#cc-grid)"/>`;
    this.gZones.innerHTML = zones.join('');
    this.gEdges.innerHTML = edges.join('');
    this.gBreaks.innerHTML = breaks.join('');
    this.gHits.innerHTML = hits.join('');
    this.gNodes.innerHTML = nodes.join('');
    this.gLabels.innerHTML = '';
    this.els.clear();
    for (const el of this.svg.querySelectorAll('[data-id]')) {
      const id = el.getAttribute('data-id')!;
      const list = this.els.get(id);
      if (list) list.push(el);
      else this.els.set(id, [el]);
    }
  }

  private zone(n: PNode, b: { x: number; y: number; w: number; h: number }, measure: Measure, overlay?: Overlay): string {
    const t = n.t;
    const tw = tagWidth(t.tag, measure);
    const zs = overlay?.zones.get(n.id);
    const cls = `z k-${t.kind}${t.fragment ? ' fragment' : ''}${zs?.self ? ' zs-broken' : ''}`;
    const internalW = n.internal ? 9 * String(n.internal).length + 14 : 0;
    let errW = zs?.errors ? 7 * (2 + String(zs.errors).length) + 8 : 0;
    const room = (w: number) => Math.floor((b.w - tw - 50 - internalW - w) / 7);
    // narrow container: the title wins, the blocks inside carry their own error badges
    if (errW && room(errW) < 6) errW = 0;
    const title = truncate(t.label, Math.max(3, room(errW)));
    let badge = n.internal ? `<text class="zi" x="${b.x + b.w - 30}" y="${b.y + 18.5}" text-anchor="end">↻${n.internal}</text>` : '';
    if (errW) badge += `<text class="ze" x="${b.x + b.w - 30 - internalW}" y="${b.y + 18.5}" text-anchor="end">✕ ${zs!.errors}</text>`;
    return (
      `<g class="${cls}" data-id="${esc(n.id)}">` +
      `<rect class="zb" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10"/>` +
      `<path class="zh" d="M${b.x},${b.y + HEADER_H}V${b.y + 10}q0,-10 10,-10H${b.x + b.w - 10}q10,0 10,10V${b.y + HEADER_H}z"/>` +
      `<rect class="tg" x="${b.x + 10}" y="${b.y + 7.5}" width="${tw}" height="13" rx="3"/>` +
      `<text class="tt" x="${b.x + 10 + tw / 2}" y="${b.y + 17.2}" text-anchor="middle">${esc(t.tag)}</text>` +
      `<text class="zt" x="${b.x + 16 + tw}" y="${b.y + 18.5}">${esc(title)}</text>` +
      badge +
      `<text class="zx" data-act="collapse" x="${b.x + b.w - 12}" y="${b.y + 19}" text-anchor="middle">−</text>` +
      `</g>`
    );
  }

  private block(
    n: PNode,
    b: { x: number; y: number; w: number; h: number },
    dir: FlowDir,
    measure: Measure,
    counts: (n: PNode) => string,
    overlay?: Overlay,
  ): string {
    const t = n.t;
    const lab = labelOf(n, counts);
    const tw = tagWidth(t.tag, measure);
    const flags = t.entity?.flags ?? [];
    const thread = flags.includes('threadEntry');
    const st = overlay?.blocks.get(n.id);
    const cls = [
      'n',
      `k-${t.kind}`,
      st ? 'st-' + st.state : '',
      flags.includes('entry') ? 'entry' : '',
      thread ? 'thread' : '',
      flags.includes('decl') ? 'decl' : '',
      flags.includes('abstract') ? 'abstract' : '',
      t.children.length ? 'collapsed' : '',
      t.fragment ? 'fragment' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const h = b.h;
    const w = b.w;
    const y1 = lab.sub ? 17.5 : h / 2 + 4.2;
    const pins =
      dir === 'RIGHT'
        ? `<circle class="pin" cx="0" cy="${h / 2}" r="2.6"/><circle class="pin" cx="${w}" cy="${h / 2}" r="2.6"/>`
        : `<circle class="pin" cx="${w / 2}" cy="0" r="2.6"/><circle class="pin" cx="${w / 2}" cy="${h}" r="2.6"/>`;
    let badges = '';
    let bx = w - 6;
    const badge = (txt: string, c: string) => {
      const bw = Math.ceil(measure(txt, '600 9px var(--cc-font)')) + 8;
      bx -= bw;
      badges += `<g class="bd ${c}"><rect x="${bx}" y="-7" width="${bw}" height="13" rx="6.5"/><text x="${bx + bw / 2}" y="2.6" text-anchor="middle">${esc(txt)}</text></g>`;
      bx -= 3;
    };
    if (st?.state === 'broken') badge(`✕ ${st.errors}`, 'bd-err');
    else if (st?.state === 'affected') badge(`⚠ +${st.dist}`, 'bd-imp');
    if (thread) badge('⚡ thread', 'bd-thread');
    if (t.children.length) badge(`+${n.t.children.length}`, 'bd-more');
    if (n.internal) badge(`↻${n.internal}`, 'bd-int');
    return (
      `<g class="${cls}" data-id="${esc(n.id)}" transform="translate(${b.x},${b.y})">` +
      `<rect class="nb" width="${w}" height="${h}" rx="6"/>` +
      `<rect class="na" width="3.5" height="${h}" rx="1.75"/>` +
      pins +
      `<rect class="tg" x="10" y="${y1 - 9.8}" width="${tw}" height="13" rx="3"/>` +
      `<text class="tt" x="${10 + tw / 2}" y="${y1 - 0.4}" text-anchor="middle">${esc(t.tag)}</text>` +
      `<text class="t1" x="${16 + tw}" y="${y1}">${esc(truncate(lab.title, 34))}</text>` +
      (lab.sub ? `<text class="t2" x="10" y="${h - 9}">${esc(lab.sub)}</text>` : '') +
      badges +
      `</g>`
    );
  }

  highlight(h: Highlight | null): void {
    this.svg.classList.toggle('has-sel', !!h);
    for (const el of this.svg.querySelectorAll('.hl, .sel')) el.classList.remove('hl', 'sel');
    this.gLabels.innerHTML = '';
    if (!h) return;
    for (const id of h.nodes) for (const el of this.els.get(id) ?? []) el.classList.add('hl');
    for (const id of h.edges) for (const el of this.els.get(id) ?? []) el.classList.add('hl');
    if (h.node) for (const el of this.els.get(h.node) ?? []) el.classList.add('sel', 'hl');
  }

  /** Data labels on highlighted wires: what travels on them. */
  dataLabels(items: { edge: PEdge; text: string }[], measure: Measure): void {
    if (!this.current) return;
    const out: string[] = [];
    for (const { edge, text } of items.slice(0, 40)) {
      const pts = this.current.layout.routes.get(edge.id);
      if (!pts || pts.length < 2) continue;
      const mid = midpoint(pts);
      const w = Math.ceil(measure(text, '10px var(--cc-mono)')) + 12;
      out.push(
        `<g class="dl k-${edge.kind}" transform="translate(${mid.x - w / 2},${mid.y - 8})"><rect width="${w}" height="16" rx="8"/><text x="${w / 2}" y="11.3" text-anchor="middle">${esc(text)}</text></g>`,
      );
    }
    this.gLabels.innerHTML = out.join('');
  }

  pulseNode(id: string | null): void {
    for (const el of this.svg.querySelectorAll('.cursor')) el.classList.remove('cursor');
    if (id) for (const el of this.els.get(id) ?? []) el.classList.add('cursor');
  }

  elementsOf(id: string): Element[] {
    return this.els.get(id) ?? [];
  }
}

/** Where along a cut wire the break is drawn (and where its current dies). */
export const BREAK_AT = 0.8;

export function pointAlong(pts: Pt[], frac: number): { p: Pt; angle: number } {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const l = Math.hypot(dx, dy);
    if (acc + l >= total * frac) {
      const u = (total * frac - acc) / (l || 1);
      return { p: { x: pts[i - 1].x + dx * u, y: pts[i - 1].y + dy * u }, angle: (Math.atan2(dy, dx) * 180) / Math.PI };
    }
    acc += l;
  }
  return { p: pts[pts.length - 1], angle: 0 };
}

export function midpoint(pts: Pt[]): Pt {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc + l >= total / 2) {
      const u = (total / 2 - acc) / (l || 1);
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * u, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * u };
    }
    acc += l;
  }
  return pts[0];
}
