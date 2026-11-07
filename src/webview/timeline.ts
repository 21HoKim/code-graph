/**
 * Thread swimlanes for a runtime trace: one lane per thread, calls drawn as a
 * small flame chart, a playhead to scrub, exceptions marked in red. Drives the
 * replay on the circuit (the app listens to seek / play / select).
 */
import type { TraceModel } from './traceview';
import { fmtNs, threadColor } from './traceview';

export interface TimelineHost {
  seek(t: number): void;
  togglePlay(): void;
  step(dir: 1 | -1): void;
  setSpeed(x: number): void;
  selectSpan(span: number): void;
  soloThread(th: number | null): void;
  close(): void;
  fnName(fn: number): string;
  t(key: string, vars?: Record<string, string | number>): string;
}

const NAME_W = 104;
const ROW = 4;
const ROWS = 6;
const LANE = ROWS * ROW + 8;

export const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 10];

export class Timeline {
  readonly el: HTMLElement;
  private head: HTMLElement;
  private body: HTMLElement;
  private base: HTMLCanvasElement;
  private over: HTMLCanvasElement;
  private tip: HTMLElement;
  private v0 = 0;
  private v1: number;
  private now = 0;
  private dirty = true;
  private threads: number[];
  private highlightFns = new Set<number>();
  private marks: { t: number; th: number }[] = [];
  private solo: number | null = null;
  playing = false;
  speed = 1;

  constructor(
    private m: TraceModel,
    private host: TimelineHost,
  ) {
    this.v1 = m.duration;
    this.threads = m.tr.threads.map((t) => t.id);
    this.el = document.createElement('div');
    this.el.className = 'timeline ui';
    this.head = document.createElement('div');
    this.head.className = 'tl-head';
    this.body = document.createElement('div');
    this.body.className = 'tl-body';
    this.base = document.createElement('canvas');
    this.over = document.createElement('canvas');
    this.over.className = 'tl-over';
    this.tip = document.createElement('div');
    this.tip.className = 'tooltip';
    this.tip.hidden = true;
    this.body.append(this.base, this.over);
    this.el.append(this.head, this.body, this.tip);
    this.buildHead();
    this.body.style.height = `${Math.min(6, this.threads.length) * LANE + 18}px`;
    new ResizeObserver(() => this.resize()).observe(this.body);
    this.bind();
  }

  private buildHead(): void {
    const t = this.host.t;
    const tr = this.m.tr;
    const exc = tr.exceptions.filter((x) => x.uncaught || tr.lang !== 'python').length;
    const ex = tr.exit;
    const status =
      ex.crash && ex.crash !== 'SIGTERM'
        ? `<span class="flag bad">✕ ${esc(ex.crash)}</span>`
        : ex.timedOut
          ? `<span class="flag warn">⏱ ${esc(t('stopped'))}</span>`
          : ex.code
            ? `<span class="flag bad">${esc(t('exitCode', { n: ex.code }))}</span>`
            : `<span class="flag good">✓ ${esc(t('exitOk'))}</span>`;
    this.head.innerHTML =
      `<button class="btn" data-a="play" title="Space">▶</button>` +
      `<button class="btn" data-a="prev" title="←">⏮</button><button class="btn" data-a="next" title="→">⏭</button>` +
      `<select data-a="speed" title="${esc(t('speed'))}">${SPEEDS.map((s) => `<option value="${s}"${s === 1 ? ' selected' : ''}>${s}×</option>`).join('')}</select>` +
      `<span class="tl-time mono"></span>` +
      status +
      (exc ? `<button class="chip bad" data-a="exc">✕ ${exc}</button>` : '') +
      `<span class="tl-threads">${tr.threads
        .map((th) => `<button class="chip th" data-th="${th.id}" title="${esc(th.name)}"><i style="background:${threadColor(th.id)}"></i>${esc(th.name)}</button>`)
        .join('')}</span>` +
      `<span class="spacer"></span>` +
      `<button class="btn" data-a="close" title="${esc(t('closeTrace'))}">✕</button>`;
    this.head.querySelector<HTMLElement>('[data-a=play]')!.onclick = () => this.host.togglePlay();
    this.head.querySelector<HTMLElement>('[data-a=prev]')!.onclick = () => this.host.step(-1);
    this.head.querySelector<HTMLElement>('[data-a=next]')!.onclick = () => this.host.step(1);
    this.head.querySelector<HTMLElement>('[data-a=close]')!.onclick = () => this.host.close();
    const sp = this.head.querySelector<HTMLSelectElement>('[data-a=speed]')!;
    sp.onchange = () => this.host.setSpeed(Number(sp.value));
    const excBtn = this.head.querySelector<HTMLElement>('[data-a=exc]');
    if (excBtn) {
      excBtn.onclick = () => {
        const x = tr.exceptions.find((e) => e.uncaught || tr.lang !== 'python') ?? tr.exceptions[0];
        if (x) this.host.seek(x.t);
      };
    }
    for (const b of this.head.querySelectorAll<HTMLElement>('[data-th]')) {
      b.onclick = () => {
        const th = Number(b.dataset.th);
        this.solo = this.solo === th ? null : th;
        for (const o of this.head.querySelectorAll<HTMLElement>('[data-th]')) o.classList.toggle('on', Number(o.dataset.th) === this.solo);
        this.host.soloThread(this.solo);
        this.dirty = true;
        this.draw();
      };
    }
  }

  setPlaying(p: boolean): void {
    this.playing = p;
    const b = this.head.querySelector<HTMLElement>('[data-a=play]');
    if (b) b.textContent = p ? '⏸' : '▶';
  }

  setSpeed(x: number): void {
    this.speed = x;
    const sp = this.head.querySelector<HTMLSelectElement>('[data-a=speed]');
    if (sp) sp.value = String(x);
  }

  setTime(t: number): void {
    this.now = t;
    // keep the playhead in view while playing
    if (this.playing && (t > this.v1 || t < this.v0)) {
      const w = this.v1 - this.v0;
      this.v0 = Math.max(0, Math.min(this.m.duration - w, t - w * 0.1));
      this.v1 = this.v0 + w;
      this.dirty = true;
    }
    const lab = this.head.querySelector('.tl-time');
    if (lab) lab.textContent = `${fmtNs(t)} / ${fmtNs(this.m.duration)}`;
    this.draw();
  }

  /** Calls of these functions are drawn white (the selected block). */
  setHighlight(fns: Set<number>): void {
    if (fns.size === this.highlightFns.size && [...fns].every((f) => this.highlightFns.has(f))) return;
    this.highlightFns = fns;
    this.dirty = true;
    this.draw();
  }

  /** Small diamonds: where a followed object appeared. */
  setMarks(marks: { t: number; th: number }[]): void {
    this.marks = marks;
    this.draw();
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.body.getBoundingClientRect();
    const h = Math.max(this.threads.length * LANE + 18, r.height);
    for (const c of [this.base, this.over]) {
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
      c.style.width = `${r.width}px`;
      c.style.height = `${h}px`;
    }
    this.dirty = true;
    this.draw();
  }

  private x(t: number, w: number): number {
    return NAME_W + ((t - this.v0) / (this.v1 - this.v0)) * (w - NAME_W - 8);
  }

  private tAt(px: number, w: number): number {
    return this.v0 + ((px - NAME_W) / (w - NAME_W - 8)) * (this.v1 - this.v0);
  }

  draw(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = this.base.width / dpr;
    if (this.dirty) {
      this.dirty = false;
      this.drawBase(W, dpr);
    }
    const c = this.over.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, this.over.height / dpr);
    const tr = this.m.tr;
    // exceptions
    for (const x of tr.exceptions) {
      const lane = this.threads.indexOf(x.th);
      if (lane < 0 || x.t < this.v0 || x.t > this.v1) continue;
      const px = this.x(x.t, W);
      const y = 14 + lane * LANE;
      c.fillStyle = '#ff4d5e';
      c.beginPath();
      c.moveTo(px - 5, y - 1);
      c.lineTo(px + 5, y - 1);
      c.lineTo(px, y + 7);
      c.fill();
    }
    // followed object: diamonds, or thin ticks when there are many
    c.fillStyle = '#ffffff';
    const dense = this.marks.length > 200;
    let lastPx = -10;
    let lastLane = -1;
    for (const mk of this.marks) {
      const lane = this.threads.indexOf(mk.th);
      if (lane < 0 || mk.t < this.v0 || mk.t > this.v1) continue;
      const px = this.x(mk.t, W);
      const y = 14 + lane * LANE + LANE - 6;
      if (dense) {
        if (lane === lastLane && px - lastPx < 1) continue;
        lastPx = px;
        lastLane = lane;
        c.fillRect(px, y - 3, 1, 6);
        continue;
      }
      c.beginPath();
      c.moveTo(px, y - 4);
      c.lineTo(px + 4, y);
      c.lineTo(px, y + 4);
      c.lineTo(px - 4, y);
      c.fill();
    }
    // playhead
    const px = this.x(this.now, W);
    if (px >= NAME_W) {
      c.strokeStyle = 'rgba(255,255,255,0.9)';
      c.lineWidth = 1.2;
      c.beginPath();
      c.moveTo(px, 0);
      c.lineTo(px, this.over.height / dpr);
      c.stroke();
    }
  }

  private drawBase(W: number, dpr: number): void {
    const c = this.base.getContext('2d')!;
    const H = this.base.height / dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const cs = getComputedStyle(document.body);
    const fg = cs.getPropertyValue('--cc-fg').trim() || '#ddd';
    const muted = cs.getPropertyValue('--cc-muted').trim() || '#888';
    const border = cs.getPropertyValue('--cc-border').trim() || '#333';
    const s = this.m.tr.spans;
    c.font = `11px ${cs.getPropertyValue('--cc-font').trim() || 'sans-serif'}`;
    // time axis
    c.fillStyle = muted;
    c.strokeStyle = border;
    c.lineWidth = 1;
    const ticks = Math.max(2, Math.min(6, Math.floor((W - NAME_W) / 120)));
    for (let i = 0; i <= ticks; i++) {
      const tt = this.v0 + ((this.v1 - this.v0) * i) / ticks;
      const x = this.x(tt, W);
      c.globalAlpha = 0.35;
      c.beginPath();
      c.moveTo(x, 10);
      c.lineTo(x, H);
      c.stroke();
      c.globalAlpha = 1;
      c.fillText(fmtNs(tt), x + 3, 9);
    }
    this.threads.forEach((th, lane) => {
      const y0 = 14 + lane * LANE;
      const info = this.m.tr.threads.find((x) => x.id === th);
      const dim = this.solo !== null && this.solo !== th;
      c.globalAlpha = dim ? 0.3 : 1;
      c.fillStyle = threadColor(th);
      c.fillRect(6, y0 + 4, 3, LANE - 12);
      c.fillStyle = fg;
      c.fillText(truncate(info?.name ?? `thread ${th}`, 14), 13, y0 + 13);
      const list = this.m.byThread.get(th) ?? [];
      const col = threadColor(th);
      const wpx = (W - NAME_W - 8) / (this.v1 - this.v0);
      let lastX = -1;
      let lastD = -1;
      for (const i of list) {
        if (s.end[i] < this.v0 || s.t[i] > this.v1) continue;
        const d = s.depth[i];
        if (d >= ROWS) continue;
        const x0 = Math.max(NAME_W, this.x(s.t[i], W));
        const x1 = Math.min(W - 8, this.x(s.end[i], W));
        const wd = Math.max(1, x1 - x0);
        if (wd < 1.5 && Math.floor(x0) === lastX && d === lastD) continue; // pixel already painted
        lastX = Math.floor(x0);
        lastD = d;
        const hl = this.highlightFns.has(s.fn[i]);
        c.fillStyle = hl ? '#ffffff' : col;
        c.globalAlpha = (dim ? 0.25 : 1) * (hl ? 1 : Math.max(0.35, 0.9 - d * 0.1));
        c.fillRect(x0, y0 + 6 + d * ROW, wd, ROW - 1);
        void wpx;
      }
      c.globalAlpha = 1;
      c.strokeStyle = border;
      c.beginPath();
      c.moveTo(0, y0 + LANE - 0.5);
      c.lineTo(W, y0 + LANE - 0.5);
      c.stroke();
    });
  }

  private bind(): void {
    let dragging = false;
    const at = (e: PointerEvent | MouseEvent) => {
      const r = this.over.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width };
    };
    this.over.addEventListener('pointerdown', (e) => {
      const p = at(e);
      if (p.x < NAME_W) return;
      dragging = true;
      this.over.setPointerCapture(e.pointerId);
      this.host.seek(Math.max(0, Math.min(this.m.duration, this.tAt(p.x, p.w))));
    });
    this.over.addEventListener('pointermove', (e) => {
      const p = at(e);
      if (dragging) {
        this.host.seek(Math.max(0, Math.min(this.m.duration, this.tAt(p.x, p.w))));
        return;
      }
      const span = this.spanAt(p.x, p.y, p.w);
      if (span < 0) {
        this.tip.hidden = true;
        return;
      }
      const s = this.m.tr.spans;
      this.tip.innerHTML = `<b>${esc(this.host.fnName(s.fn[span]))}</b><div class="mono">${fmtNs(s.end[span] - s.t[span])} @ ${fmtNs(s.t[span])}</div>`;
      this.tip.hidden = false;
      const r = this.el.getBoundingClientRect();
      const o = this.over.getBoundingClientRect();
      this.tip.style.left = `${Math.min(p.x + 12, r.width - 220)}px`;
      this.tip.style.top = `${o.top - r.top + p.y - 34}px`;
    });
    this.over.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      const p = at(e);
      const span = this.spanAt(p.x, p.y, p.w);
      if (span >= 0) this.host.selectSpan(span);
    });
    this.over.addEventListener('pointerleave', () => (this.tip.hidden = true));
    this.over.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = at(e);
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          const w = this.v1 - this.v0;
          const dt = (e.deltaX / p.w) * w;
          this.v0 = Math.max(0, Math.min(this.m.duration - w, this.v0 + dt));
          this.v1 = this.v0 + w;
        } else {
          const tc = this.tAt(Math.max(NAME_W, p.x), p.w);
          const f = Math.exp(e.deltaY * 0.0015);
          const w = Math.max(this.m.duration / 5e5, Math.min(this.m.duration, (this.v1 - this.v0) * f));
          const u = (tc - this.v0) / (this.v1 - this.v0);
          this.v0 = Math.max(0, tc - u * w);
          this.v1 = Math.min(this.m.duration, this.v0 + w);
          this.v0 = Math.max(0, this.v1 - w);
        }
        this.dirty = true;
        this.draw();
      },
      { passive: false },
    );
    this.over.addEventListener('dblclick', () => {
      this.v0 = 0;
      this.v1 = this.m.duration;
      this.dirty = true;
      this.draw();
    });
  }

  private spanAt(px: number, py: number, w: number): number {
    if (px < NAME_W) return -1;
    const lane = Math.floor((py - 14) / LANE);
    const th = this.threads[lane];
    if (th === undefined) return -1;
    const depth = Math.floor((py - 14 - lane * LANE - 6) / ROW);
    if (depth < 0 || depth >= ROWS) return -1;
    const t = this.tAt(px, w);
    const tol = ((this.v1 - this.v0) / w) * 2;
    const act = this.m.activeAt(t).get(th);
    if (act === undefined) {
      // a very short call under the cursor
      const s = this.m.tr.spans;
      for (const i of this.m.byThread.get(th) ?? []) if (s.depth[i] === depth && s.t[i] <= t + tol && s.end[i] >= t - tol) return i;
      return -1;
    }
    const stack = this.m.stackOf(act);
    return stack[depth] ?? -1;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
