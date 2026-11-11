/**
 * Swimlanes of a run followed live: every thread's call stack as sampled with each live update (about every
 * 250 ms), scrolling to the left as time goes on. The view follows the right end (now) until the user drags it or
 * moves it with Shift + wheel; *Now* (or a double-click) follows again. The wheel rules are the replay timeline's.
 * A click on a thread's name follows that thread in the circuit.
 */
import type { LiveUpdate } from '../core/live';
import { threadColor } from './traceview';
import { timelineWheel } from './wheel';

const NAME_W = 104;
const ROW = 4;
const ROWS = 6;
const LANE = ROWS * ROW + 8;
/** Samples kept: 20 minutes at 4 per second. */
const KEEP = 4800;

export interface LiveLanesHost {
  /** Short name of a graph entity, for the tooltip. */
  nameOf(entity: string): string;
  /** A thread's name was clicked: follow it (null: follow all again). */
  soloThread(th: number | null): void;
  t(key: string, vars?: Record<string, string | number>): string;
}

interface Sample {
  t: number;
  stacks: Map<number, string[]>;
}

/**
 * The visible window [t0, t1] (ms): the last `span` up to now while following (from the start while the run is
 * shorter than that, so the lanes fill from the left), else up to `end`.
 */
export function liveWindow(follow: boolean, end: number, span: number, now: number, first: number): [number, number] {
  const t1 = Math.max(first + span, follow ? now : Math.min(now, end));
  return [t1 - span, t1];
}

export class LiveLanes {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private canvas: HTMLCanvasElement;
  private nowBtn: HTMLButtonElement;
  private tip: HTMLElement;
  private samples: Sample[] = [];
  private threads: { id: number; name: string }[] = [];
  private only: ReadonlySet<number> | null = null;
  private solo: number | null = null;
  private follow = true;
  private end = 0;
  private span = 30_000;

  constructor(private host: LiveLanesHost) {
    this.el = document.createElement('div');
    this.el.className = 'live-lanes';
    this.nowBtn = document.createElement('button');
    this.nowBtn.className = 'btn ll-now';
    this.nowBtn.textContent = `⏭ ${host.t('liveNow')}`;
    this.nowBtn.title = host.t('liveNowHint');
    this.nowBtn.hidden = true;
    this.nowBtn.onclick = () => this.followNow();
    this.body = document.createElement('div');
    this.body.className = 'tl-body';
    this.canvas = document.createElement('canvas');
    this.tip = document.createElement('div');
    this.tip.className = 'tooltip';
    this.tip.hidden = true;
    this.body.append(this.canvas);
    this.el.append(this.body, this.nowBtn, this.tip);
    new ResizeObserver(() => this.draw()).observe(this.body);
    this.bind();
  }

  /** The button that brings the view back to now, for the live bar's head. */
  get nowButton(): HTMLElement {
    return this.nowBtn;
  }

  push(u: LiveUpdate): void {
    const stacks = new Map<number, string[]>();
    for (const s of u.stacks) stacks.set(s.th, s.fns);
    this.samples.push({ t: u.elapsedMs, stacks });
    if (this.samples.length > KEEP) this.samples.splice(0, this.samples.length - KEEP);
    const known = new Map(this.threads.map((x) => [x.id, x]));
    for (const th of u.threads) {
      const k = known.get(th.id);
      const name = th.proc ? `${th.proc} · ${th.name}` : th.name;
      if (k) k.name = name;
      else this.threads.push({ id: th.id, name });
    }
    this.draw();
  }

  /** The thread followed in the circuit (dims the other lanes), or null. */
  setSolo(th: number | null): void {
    this.solo = th;
    this.draw();
  }

  /** Show only these threads (a container's), or all. */
  setFilter(ths: ReadonlySet<number> | null): void {
    this.only = ths;
    this.draw();
  }

  private followNow(): void {
    this.follow = true;
    this.nowBtn.hidden = true;
    this.draw();
  }

  private unfollow(end: number): void {
    this.follow = false;
    this.end = end;
    this.nowBtn.hidden = false;
  }

  private lanes(): { id: number; name: string }[] {
    return this.threads.filter((x) => !this.only || this.only.has(x.id));
  }

  private window(): [number, number] {
    const now = this.samples.at(-1)?.t ?? 0;
    return liveWindow(this.follow, this.end, this.span, now, this.samples[0]?.t ?? 0);
  }

  draw(): void {
    const lanes = this.lanes();
    this.body.style.height = `${Math.max(1, Math.min(6, lanes.length)) * LANE + 18}px`;
    const r = this.body.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = r.width;
    const H = Math.max(lanes.length * LANE + 18, r.height);
    if (W <= 0) return;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
      this.canvas.style.width = `${W}px`;
      this.canvas.style.height = `${H}px`;
    }
    const c = this.canvas.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.body);
    const fg = css.getPropertyValue('--cc-fg').trim() || '#d5dde8';
    const muted = css.getPropertyValue('--cc-muted').trim() || '#8b98a9';
    const [t0, t1] = this.window();
    const x = (t: number) => NAME_W + ((t - t0) / (t1 - t0)) * (W - NAME_W - 8);
    // time axis: a tick every 5 s (every second when zoomed in)
    c.font = '10px var(--vscode-font-family, sans-serif)';
    c.fillStyle = muted;
    const step = t1 - t0 > 20_000 ? 5000 : t1 - t0 > 4000 ? 1000 : 250;
    for (let tt = Math.ceil(t0 / step) * step; tt <= t1; tt += step) {
      if (tt < 0) continue;
      const px = x(tt);
      c.fillRect(px, 10, 1, 4);
      c.fillText(`${(tt / 1000).toFixed(step < 1000 ? 2 : 0)} s`, px + 2, 9);
    }
    lanes.forEach((th, lane) => {
      const y = 14 + lane * LANE;
      const dim = this.solo !== null && this.solo !== th.id;
      c.globalAlpha = dim ? 0.3 : 1;
      c.fillStyle = threadColor(th.id);
      c.fillRect(4, y + 4, 6, 6);
      c.fillStyle = fg;
      c.fillText(truncate(th.name, 15), 14, y + 11);
      const col = threadColor(th.id);
      for (let i = 0; i < this.samples.length; i++) {
        const s = this.samples[i];
        const next = this.samples[i + 1]?.t ?? s.t + 250;
        if (next < t0 || s.t > t1) continue;
        const fns = s.stacks.get(th.id);
        if (!fns?.length) continue;
        const a = Math.max(NAME_W, x(s.t));
        const b = Math.min(W - 8, x(next));
        if (b <= a) continue;
        for (let d = 0; d < Math.min(ROWS, fns.length); d++) {
          c.fillStyle = col;
          c.globalAlpha = (dim ? 0.3 : 1) * (0.9 - d * 0.1);
          c.fillRect(a, y + 2 + d * ROW, Math.max(1, b - a - 0.5), ROW - 1);
        }
      }
      c.globalAlpha = 1;
    });
  }

  private at(e: MouseEvent): { x: number; y: number; w: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width };
  }

  private tAt(px: number, w: number): number {
    const [t0, t1] = this.window();
    return t0 + ((px - NAME_W) / Math.max(1, w - NAME_W - 8)) * (t1 - t0);
  }

  private bind(): void {
    let drag: { id: number; x: number; end: number; moved: boolean } | null = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      const p = this.at(e);
      if (p.x < NAME_W) {
        // a thread's name: follow that thread (again: all)
        const th = this.lanes()[Math.floor((p.y - 14) / LANE)];
        if (!th) return;
        this.solo = this.solo === th.id ? null : th.id;
        this.host.soloThread(this.solo);
        this.draw();
        return;
      }
      drag = { id: e.pointerId, x: e.clientX, end: this.window()[1], moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (drag && drag.id === e.pointerId) {
        const dx = e.clientX - drag.x;
        if (!drag.moved && Math.abs(dx) < 3) return;
        drag.moved = true;
        const w = this.at(e).w;
        this.unfollow(drag.end - (dx / Math.max(1, w - NAME_W - 8)) * this.span);
        this.draw();
        return;
      }
      const p = this.at(e);
      const th = this.lanes()[Math.floor((p.y - 14) / LANE)];
      const d = Math.floor((p.y - 14 - Math.floor((p.y - 14) / LANE) * LANE - 2) / ROW);
      const tt = this.tAt(p.x, p.w);
      let s: Sample | undefined;
      for (let i = this.samples.length - 1; i >= 0; i--) if (this.samples[i].t <= tt) {
        s = this.samples[i];
        break;
      }
      const fn = th && p.x >= NAME_W && d >= 0 && d < ROWS ? s?.stacks.get(th.id)?.[d] : undefined;
      this.tip.hidden = !fn;
      if (fn) {
        this.tip.textContent = `${th!.name}: ${this.host.nameOf(fn)}`;
        this.tip.style.left = `${p.x + 12}px`;
        this.tip.style.top = `${p.y + 12}px`;
      }
    });
    const end = (e: PointerEvent) => {
      if (drag?.id === e.pointerId) drag = null;
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('pointerleave', () => (this.tip.hidden = true));
    this.canvas.addEventListener('dblclick', () => this.followNow());
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        const act = timelineWheel(e);
        if (act === 'scroll') return;
        e.preventDefault();
        const w = this.at(e).w;
        const [, t1] = this.window();
        if ('pan' in act) {
          const moved = t1 + (act.pan / Math.max(1, w - NAME_W - 8)) * this.span;
          const now = this.samples.at(-1)?.t ?? 0;
          if (moved >= now) this.followNow();
          else this.unfollow(moved);
        } else this.span = Math.max(2000, Math.min(20 * 60_000, this.span * act.zoom));
        this.draw();
      },
      { passive: false },
    );
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
