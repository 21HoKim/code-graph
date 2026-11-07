/** Pan / zoom / pinch for the stage. World -> screen: s = w * k + (x, y). */
export interface ViewportEvents {
  onChange(): void;
  /** Tap/click without drag. target = element under the pointer. */
  onTap(target: Element | null, ev: PointerEvent): void;
  onDoubleTap(target: Element | null, ev: PointerEvent): void;
}

export class Viewport {
  x = 0;
  y = 0;
  k = 1;
  minK = 0.05;
  maxK = 4;
  private pointers = new Map<number, { x: number; y: number }>();
  private dragStart: { x: number; y: number; vx: number; vy: number } | null = null;
  private pinch: { d: number; k: number; cx: number; cy: number; vx: number; vy: number } | null = null;
  private moved = 0;
  private lastTap = { t: 0, target: null as Element | null };
  private anim = 0;

  constructor(
    private el: HTMLElement,
    private ev: ViewportEvents,
  ) {
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('dblclick', (e) => e.preventDefault());
  }

  set(x: number, y: number, k: number): void {
    this.x = x;
    this.y = y;
    this.k = Math.max(this.minK, Math.min(this.maxK, k));
    this.ev.onChange();
  }

  zoomAt(px: number, py: number, factor: number): void {
    const k = Math.max(this.minK, Math.min(this.maxK, this.k * factor));
    const f = k / this.k;
    this.set(px - (px - this.x) * f, py - (py - this.y) * f, k);
  }

  /** Fit world rect into the element. */
  fit(wx: number, wy: number, ww: number, wh: number, pad = 40, maxK = 1.2, animate = false): void {
    const r = this.el.getBoundingClientRect();
    const k = Math.max(this.minK, Math.min(maxK, Math.min((r.width - pad * 2) / Math.max(ww, 1), (r.height - pad * 2) / Math.max(wh, 1))));
    const x = (r.width - ww * k) / 2 - wx * k;
    const y = (r.height - wh * k) / 2 - wy * k;
    if (animate) this.animateTo(x, y, k);
    else this.set(x, y, k);
  }

  centerOn(wx: number, wy: number, k = this.k, animate = true): void {
    const r = this.el.getBoundingClientRect();
    const x = r.width / 2 - wx * k;
    const y = r.height / 2 - wy * k;
    if (animate) this.animateTo(x, y, k);
    else this.set(x, y, k);
  }

  animateTo(x: number, y: number, k: number, ms = 280): void {
    cancelAnimationFrame(this.anim);
    const from = { x: this.x, y: this.y, k: this.k };
    const t0 = performance.now();
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - u, 3);
      this.set(from.x + (x - from.x) * e, from.y + (y - from.y) * e, from.k + (k - from.k) * e);
      if (u < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  toWorld(px: number, py: number): { x: number; y: number } {
    return { x: (px - this.x) / this.k, y: (py - this.y) / this.k };
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.local(e);
    // trackpad pan (pixel deltas, no ctrl) vs. zoom (mouse wheel, ctrl/pinch)
    if (!e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaX) > 0.5) {
      this.set(this.x - e.deltaX, this.y - e.deltaY, this.k);
      return;
    }
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.zoomAt(p.x, p.y, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)));
  };

  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if ((e.target as Element)?.closest?.('.ui')) return;
    cancelAnimationFrame(this.anim);
    this.el.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.moved = 0;
    if (this.pointers.size === 1) this.dragStart = { x: p.x, y: p.y, vx: this.x, vy: this.y };
    else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: this.k, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, vx: this.x, vy: this.y };
      this.dragStart = null;
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const k = Math.max(this.minK, Math.min(this.maxK, (this.pinch.k * d) / Math.max(1, this.pinch.d)));
      const f = k / this.pinch.k;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      this.moved += 10;
      this.set(cx - (this.pinch.cx - this.pinch.vx) * f, cy - (this.pinch.cy - this.pinch.vy) * f, k);
      return;
    }
    if (this.dragStart) {
      const dx = p.x - this.dragStart.x;
      const dy = p.y - this.dragStart.y;
      this.moved = Math.max(this.moved, Math.hypot(dx, dy));
      if (this.moved > 3) {
        this.el.classList.add('panning');
        this.set(this.dragStart.vx + dx, this.dragStart.vy + dy, this.k);
      }
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    this.el.classList.remove('panning');
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) {
      const wasTap = this.moved <= 4 && e.type === 'pointerup';
      this.dragStart = null;
      if (!wasTap) return;
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const now = performance.now();
      const n = target?.closest('[data-id]') ?? null;
      if (now - this.lastTap.t < 320 && n === this.lastTap.target) {
        this.lastTap = { t: 0, target: null };
        this.ev.onDoubleTap(target, e);
      } else {
        this.lastTap = { t: now, target: n };
        this.ev.onTap(target, e);
      }
    } else if (this.pointers.size === 1) {
      const [p] = [...this.pointers.values()];
      this.dragStart = { x: p.x, y: p.y, vx: this.x, vy: this.y };
    }
  };
}
