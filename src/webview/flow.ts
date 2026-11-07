/**
 * Electric-flow layer: glowing charges travelling along wires on a canvas
 * overlay. Forward charges = arguments flowing caller → callee; amber
 * charges travelling backwards = return values.
 *
 * Cheap by design: pre-rendered glow sprites + drawImage, viewport culling,
 * a global particle budget, and the loop sleeps when nothing is visible or
 * the panel is hidden.
 */
import type { RelationKind } from '../core/model';
import type { Pt } from './layout';

/** Must match render.ts BREAK_AT (kept local to avoid a render↔flow import cycle). */
const BREAK_AT = 0.8;

export type FlowMode = 'all' | 'focus' | 'off';

export interface FlowPath {
  id: string;
  kind: RelationKind;
  pts: Float32Array; // x0,y0,x1,y1,…
  cum: Float32Array; // cumulative length at each point
  len: number;
  weight: number;
  returns: boolean;
  dashed: boolean;
  bbox: [number, number, number, number];
  phase: number;
  /** ok: current flows · cut: it sparks and dies at the break · dead: nothing flows */
  state: 'ok' | 'cut' | 'dead';
}

export interface FlowPalette {
  call: string;
  spawn: string;
  instantiate: string;
  inherit: string;
  include: string;
  ret: string;
  broken: string;
}

/** Optional live events (dynamic tracing): bright pulses fired on demand. */
interface Burst {
  path: FlowPath;
  t0: number;
  color: string;
  reverse: boolean;
  dur: number;
}

const SPEED: Partial<Record<RelationKind, number>> = { call: 75, instantiate: 60, spawn: 120 };
const SPACING = 60;
/** ambient (not highlighted) wires carry sparser, dimmer charges */
const AMBIENT = 2.4;

export function makePath(
  id: string,
  kind: RelationKind,
  pts: Pt[],
  weight: number,
  returns: boolean,
  dashed: boolean,
  state: 'ok' | 'cut' | 'dead' = 'ok',
): FlowPath {
  const n = pts.length;
  const arr = new Float32Array(n * 2);
  const cum = new Float32Array(n);
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    arr[i * 2] = p.x;
    arr[i * 2 + 1] = p.y;
    if (i) cum[i] = cum[i - 1] + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
    minx = Math.min(minx, p.x);
    miny = Math.min(miny, p.y);
    maxx = Math.max(maxx, p.x);
    maxy = Math.max(maxy, p.y);
  }
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return { id, kind, pts: arr, cum, len: cum[n - 1] ?? 0, weight, returns, dashed, bbox: [minx, miny, maxx, maxy], phase: (h % 1000) / 1000, state };
}

export class FlowLayer {
  private ctx: CanvasRenderingContext2D;
  private paths: FlowPath[] = [];
  private byId = new Map<string, FlowPath>();
  private focus: Set<string> | null = null;
  private mode: FlowMode = 'all';
  private tx = 0;
  private ty = 0;
  private k = 1;
  private raf = 0;
  private sprites = new Map<string, HTMLCanvasElement>();
  private bursts: Burst[] = [];
  private dpr = 1;
  maxParticles = 2500;
  speed = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private palette: FlowPalette,
  ) {
    this.ctx = canvas.getContext('2d')!;
    document.addEventListener('visibilitychange', () => (document.hidden ? this.stop() : this.start()));
  }

  setPalette(p: FlowPalette): void {
    this.palette = p;
    this.sprites.clear();
  }

  setPaths(paths: FlowPath[]): void {
    this.paths = paths;
    this.byId = new Map(paths.map((p) => [p.id, p]));
    this.kick();
  }

  setFocus(ids: Set<string> | null): void {
    this.focus = ids;
    this.kick();
  }

  setMode(m: FlowMode): void {
    this.mode = m;
    this.kick();
  }

  setTransform(x: number, y: number, k: number): void {
    this.tx = x;
    this.ty = y;
    this.k = k;
    this.kick();
  }

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.kick();
  }

  /** Fire a single pulse along a wire (used by trace replay). */
  pulse(edgeId: string, color: string, reverse = false, dur = 700): void {
    const p = this.byId.get(edgeId);
    if (!p) return;
    this.bursts.push({ path: p, t0: performance.now(), color, reverse, dur });
    this.kick();
  }

  start(): void {
    this.kick();
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private kick(): void {
    if (!this.raf && !document.hidden) this.raf = requestAnimationFrame(this.frame);
  }

  private sprite(color: string, size: number): HTMLCanvasElement {
    const key = color + size;
    let s = this.sprites.get(key);
    if (s) return s;
    s = document.createElement('canvas');
    s.width = s.height = size;
    const c = s.getContext('2d')!;
    const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.22, color);
    g.addColorStop(0.55, withAlpha(color, 0.35));
    g.addColorStop(1, withAlpha(color, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);
    this.sprites.set(key, s);
    return s;
  }

  private frame = (now: number): void => {
    this.raf = 0;
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const animating = this.mode !== 'off' || this.bursts.length > 0;
    if (!animating || !this.paths.length) return;

    const d = this.dpr;
    const k = this.k;
    // visible world rectangle
    const vx0 = -this.tx / k;
    const vy0 = -this.ty / k;
    const vx1 = vx0 + W / d / k;
    const vy1 = vy0 + H / d / k;
    const t = (now / 1000) * this.speed;
    const size = Math.round(Math.max(5, Math.min(16, 11 * Math.sqrt(k))) * d);
    const half = size / 2;
    ctx.globalCompositeOperation = 'lighter';

    // particle budget → spacing multiplier
    let total = 0;
    const visible: FlowPath[] = [];
    if (this.mode !== 'off') {
      for (const p of this.paths) {
        if (p.state === 'dead' || (p.dashed && p.state !== 'cut') || !SPEED[p.kind]) continue;
        const b = p.bbox;
        if (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1) continue;
        const hot = !this.focus || this.focus.has(p.id);
        if (this.mode === 'focus' && !hot) continue;
        visible.push(p);
        total += p.len / SPACING;
      }
    }
    const budget = Math.max(1, total / this.maxParticles);

    for (const p of visible) {
      const hot = !this.focus || this.focus.has(p.id);
      if (p.state === 'cut') {
        this.drawCut(ctx, p, t, size, half, hot);
        continue;
      }
      const color = (this.palette as unknown as Record<string, string>)[p.kind] ?? this.palette.call;
      const spr = this.sprite(color, size);
      const lit = hot && !!this.focus;
      const spacing = (SPACING * budget * (lit ? 1 : AMBIENT)) / Math.min(2.2, 1 + Math.log2(p.weight) * 0.35);
      const v = SPEED[p.kind]!;
      ctx.globalAlpha = lit ? 1 : this.focus ? 0.22 : 0.55;
      const off = (t * v + p.phase * spacing) % spacing;
      for (let s = off; s < p.len; s += spacing) this.draw(ctx, p, s, spr, half);
      if (p.returns && lit) {
        const rs = this.sprite(this.palette.ret, Math.round(size * 0.8));
        const rsp = spacing * 1.9;
        const roff = (t * v * 0.75 + p.phase * rsp * 0.5) % rsp;
        for (let s = roff; s < p.len; s += rsp) this.draw(ctx, p, p.len - s, rs, half * 0.8);
      }
    }

    // trace bursts
    if (this.bursts.length) {
      const nowMs = performance.now();
      this.bursts = this.bursts.filter((b) => nowMs - b.t0 < b.dur);
      ctx.globalAlpha = 1;
      for (const b of this.bursts) {
        const u = (nowMs - b.t0) / b.dur;
        const s = (b.reverse ? 1 - u : u) * b.path.len;
        const spr = this.sprite(b.color, Math.round(size * 1.5));
        for (let tail = 0; tail < 4; tail++) {
          ctx.globalAlpha = 1 - tail * 0.22;
          this.draw(ctx, b.path, s - (b.reverse ? -1 : 1) * tail * 7, spr, half * 1.5);
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Current runs up to the break, then sparks and dies. */
  private drawCut(ctx: CanvasRenderingContext2D, p: FlowPath, t: number, size: number, half: number, hot: boolean): void {
    const end = p.len * BREAK_AT;
    const spr = this.sprite(this.palette.broken, size);
    ctx.globalAlpha = hot ? 1 : 0.45;
    const spacing = SPACING * 1.4;
    const off = (t * 55 + p.phase * spacing) % spacing;
    for (let s = off; s < end; s += spacing) {
      ctx.globalAlpha = (hot ? 1 : 0.45) * Math.min(1, (end - s) / 30 + 0.15);
      this.draw(ctx, p, s, spr, half);
    }
    // sparks at the break
    const spark = this.sprite('#ffffff', Math.round(size * 0.7));
    for (let i = 0; i < 3; i++) {
      const j = Math.sin(t * 23 + i * 2.1 + p.phase * 9);
      if (j < 0.2) continue;
      ctx.globalAlpha = j * (hot ? 0.9 : 0.4);
      this.draw(ctx, p, end + (j - 0.6) * 6, spark, half * 0.7);
    }
  }

  private draw(ctx: CanvasRenderingContext2D, p: FlowPath, s: number, spr: HTMLCanvasElement, half: number): void {
    if (s < 0 || s > p.len) return;
    const cum = p.cum;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const seg = cum[hi] - cum[lo] || 1;
    const u = (s - cum[lo]) / seg;
    const x = p.pts[lo * 2] + (p.pts[hi * 2] - p.pts[lo * 2]) * u;
    const y = p.pts[lo * 2 + 1] + (p.pts[hi * 2 + 1] - p.pts[lo * 2 + 1]) * u;
    const d = this.dpr;
    ctx.drawImage(spr, (x * this.k + this.tx) * d - half, (y * this.k + this.ty) * d - half);
  }
}

function withAlpha(color: string, a: number): string {
  const c = color.trim();
  if (c.startsWith('#')) {
    const hex = c.length === 4 ? c.slice(1).split('').map((h) => h + h).join('') : c.slice(1, 7);
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (m) {
    const [r, g, b] = m[1].split(',').map((s) => s.trim());
    return `rgba(${r},${g},${b},${a})`;
  }
  return c;
}
