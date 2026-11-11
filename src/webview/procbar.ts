/**
 * The containers (processes) of a run as cards on the right of the circuit, live and in the replay: what each is
 * doing, and which of them the circuit and the swimlanes show. A click shows only that container, Ctrl / ⌘ + click
 * adds or removes one, a click on the only one shown shows all again. ⧉ opens a container in a view of its own.
 */

export interface ProcCard {
  name: string;
  /** running · ok (ended normally) · bad (exit code, crash) · stop (stopped, timed out) */
  state: 'run' | 'ok' | 'bad' | 'stop';
  /** How it ended or that it runs, in words. */
  status: string;
  pid?: number;
  threads: number;
  calls: number;
  /** Live: calls per second right now. */
  rate?: number;
  /** Activity over time, oldest first (any scale). */
  spark: number[];
  /** Colours of its threads. */
  colors: string[];
}

export interface ProcBarHost {
  onSelect(selected: ReadonlySet<string>): void;
  /** Open one container in a view of its own (absent where there is no host, e.g. the demo page). */
  onOpen?(name: string): void;
  t(key: string, vars?: Record<string, string | number>): string;
}

/**
 * The selection after a click on `name`: alone (plain click), toggled (Ctrl / ⌘), or all again (a plain click on
 * the only one shown). An empty set means every container.
 */
export function nextSelection(sel: ReadonlySet<string>, name: string, additive: boolean): Set<string> {
  if (additive) {
    const out = new Set(sel);
    if (out.has(name)) out.delete(name);
    else out.add(name);
    return out;
  }
  return sel.size === 1 && sel.has(name) ? new Set() : new Set([name]);
}

export class ProcBar {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private head: HTMLElement;
  private cards = new Map<string, HTMLElement>();
  private sel = new Set<string>();
  private folded = false;

  constructor(private host: ProcBarHost) {
    this.el = document.createElement('div');
    this.el.className = 'procbar ui';
    this.head = document.createElement('button');
    this.head.className = 'pb-head';
    this.head.onclick = () => {
      this.folded = !this.folded;
      this.el.classList.toggle('folded', this.folded);
    };
    this.list = document.createElement('div');
    this.list.className = 'pb-list';
    this.el.append(this.head, this.list);
  }

  get selected(): ReadonlySet<string> {
    return this.sel;
  }

  /** Set the selection without telling the host (it already knows: a view kept across live → replay). */
  select(sel: ReadonlySet<string>): void {
    this.sel = new Set(sel);
    this.paintSelection();
  }

  /** Cards are made once per container and updated in place, so a click never lands on a replaced element. */
  update(cards: ProcCard[]): void {
    const t = this.host.t;
    this.head.innerHTML = `<span class="lg-caret">▾</span>${esc(t('containers', { n: cards.length }))}`;
    this.head.title = t('containersHint');
    const names = new Set(cards.map((c) => c.name));
    for (const [name, el] of this.cards) {
      if (!names.has(name)) {
        el.remove();
        this.cards.delete(name);
      }
    }
    for (const c of cards) {
      let el = this.cards.get(c.name);
      if (!el) {
        el = this.make(c.name);
        this.cards.set(c.name, el);
      }
      this.list.append(el); // keeps the order of `cards`
      el.dataset.state = c.state;
      el.querySelector<HTMLElement>('.pb-status')!.textContent = c.status;
      el.querySelector<HTMLElement>('.pb-pid')!.textContent = c.pid !== undefined ? `pid ${c.pid}` : '';
      const nums = t('procNums', { th: c.threads, n: c.calls.toLocaleString() }) + (c.rate !== undefined ? ` · ${t('perSecond', { n: Math.round(c.rate).toLocaleString() })}` : '');
      el.querySelector<HTMLElement>('.pb-nums')!.textContent = nums;
      el.querySelector<HTMLElement>('.pb-threads')!.innerHTML = c.colors
        .slice(0, 12)
        .map((col) => `<i style="background:${col}"></i>`)
        .join('') + (c.colors.length > 12 ? `<span>+${c.colors.length - 12}</span>` : '');
      el.querySelector('.pb-spark')!.innerHTML = sparkPath(c.spark);
    }
    // a container that is gone is no longer selected
    for (const s of [...this.sel]) if (!names.has(s)) this.sel.delete(s);
    this.paintSelection();
  }

  private make(name: string): HTMLElement {
    const t = this.host.t;
    const el = document.createElement('div');
    el.className = 'pb-card';
    el.tabIndex = 0;
    el.innerHTML =
      `<div class="pb-top"><span class="pb-dot"></span><b class="pb-name"></b>` +
      (this.host.onOpen ? `<button class="pb-open" title="${esc(t('splitOne'))}">⧉</button>` : '') +
      `</div><div class="pb-status"></div><div class="pb-nums mono"></div>` +
      `<svg class="pb-spark" viewBox="0 0 100 16" preserveAspectRatio="none"></svg><div class="pb-threads"></div><div class="pb-pid mono"></div>`;
    el.querySelector<HTMLElement>('.pb-name')!.textContent = name;
    el.title = t('procCardHint');
    el.addEventListener('click', (e) => {
      if ((e.target as Element).closest('.pb-open')) {
        this.host.onOpen?.(name);
        return;
      }
      this.sel = nextSelection(this.sel, name, e.ctrlKey || e.metaKey);
      this.paintSelection();
      this.host.onSelect(this.sel);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      this.sel = nextSelection(this.sel, name, e.ctrlKey || e.metaKey);
      this.paintSelection();
      this.host.onSelect(this.sel);
    });
    return el;
  }

  private paintSelection(): void {
    for (const [name, el] of this.cards) {
      el.classList.toggle('on', this.sel.has(name));
      el.classList.toggle('dim', this.sel.size > 0 && !this.sel.has(name));
    }
  }
}

/** A filled sparkline in a 100 × 16 box. */
export function sparkPath(values: number[]): string {
  if (values.length < 2) return '';
  const max = Math.max(1, ...values);
  const step = 100 / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(15.5 - (v / max) * 14).toFixed(1)}`);
  return `<path class="area" d="M0,16 L${pts.join(' L')} L100,16 Z"/><path class="line" d="M${pts.join(' L')}"/>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
