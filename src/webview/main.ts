/**
 * CodeCurrent webview app.
 * State → project() → ELK (worker) → SVG blocks/wires + canvas flow.
 */
import ELK from 'elkjs/lib/elk-api.js';
import './style.css';
import type { CodeGraph, Confidence, Entity, Relation, RelationKind } from '../core/model';
import type { HostMessage, ViewSettings, WebviewMessage } from '../shared/protocol';
import { FlowLayer, makePath, type FlowMode, type FlowPalette } from './flow';
import { setLang, t } from './i18n';
import { runLayout, samplePath, signature, type ElkLike, type FlowDir, type LayoutResult, type LayoutStyle, type Measure } from './layout';
import {
  ALL_KINDS,
  LEVELS,
  RANK,
  ancestorsOf,
  buildTree,
  effectiveLevel,
  pickLevel,
  project,
  type GroupMode,
  type PEdge,
  type PNode,
  type Projection,
  type TNode,
  type ViewKind,
  type ViewTree,
} from './projection';
import { Renderer, esc } from './render';
import { Viewport } from './viewport';

interface VsApi {
  postMessage(m: WebviewMessage): void;
  getState(): unknown;
  setState(s: unknown): void;
}
declare function acquireVsCodeApi(): VsApi;
declare global {
  interface Window {
    __CODE_CURRENT_DEMO__?: { graph: CodeGraph; settings: ViewSettings };
  }
}

const api: VsApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : {
        postMessage: () => undefined,
        getState: () => {
          try {
            return JSON.parse(localStorage.getItem('code-current-state') ?? 'null');
          } catch {
            return undefined;
          }
        },
        setState: (s) => {
          try {
            localStorage.setItem('code-current-state', JSON.stringify(s));
          } catch {
            /* storage unavailable */
          }
        },
      };

interface UIState {
  level: ViewKind;
  levelChosen: boolean;
  mode: GroupMode;
  style: LayoutStyle;
  expand: string[];
  collapse: string[];
  kinds: RelationKind[];
  minConf: Confidence;
  flow: FlowMode;
  focus: { id: string; hops: number } | null;
  selected: string | null;
}

const DEFAULT_STATE: UIState = {
  level: 'file',
  levelChosen: false,
  mode: 'files',
  style: 'circuit',
  expand: [],
  collapse: [],
  kinds: [...ALL_KINDS],
  minConf: 'guess',
  flow: 'all',
  focus: null,
  selected: null,
};

const KIND_ICON: Record<RelationKind, string> = { call: '→', spawn: '⚡', instantiate: '✚', inherit: '△', include: '#', import: '⇣' };

// ---------------------------------------------------------------------------

type ElkCtor = new (o: object) => ElkLike & { knownLayoutAlgorithms(): Promise<unknown> };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('ELK worker timeout')), ms))]);
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}

/** Hosted demo page: ELK comes from a CDN (the page itself only carries CodeCurrent's code). */
async function createElkFromCdn(base: string): Promise<ElkLike> {
  try {
    const boot = `importScripts(${JSON.stringify(base + 'elk-worker.min.js')});`;
    const blobUrl = URL.createObjectURL(new Blob([boot], { type: 'application/javascript' }));
    const elk = new (ELK as unknown as ElkCtor)({ workerFactory: () => new Worker(blobUrl) });
    await withTimeout(elk.knownLayoutAlgorithms(), 15000);
    return elk;
  } catch (err) {
    console.warn('[CodeCurrent] CDN worker unavailable, laying out on the main thread', err);
    await loadScript(base + 'elk.bundled.js');
    const Global = (window as unknown as { ELK: new () => ElkLike }).ELK;
    return new Global();
  }
}

async function createElk(): Promise<ElkLike> {
  if (document.body.dataset.elkCdn) return createElkFromCdn(document.body.dataset.elkCdn);
  const inline = document.getElementById('elk-worker-src');
  const url = document.body.dataset.elkWorker;
  let code = inline?.textContent ?? undefined;
  try {
    if (!code && url) code = await (await fetch(url)).text();
    if (!code) throw new Error('no ELK worker source');
    const blobUrl = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    const elk = new (ELK as unknown as ElkCtor)({ workerFactory: () => new Worker(blobUrl) });
    await withTimeout(elk.knownLayoutAlgorithms(), 5000);
    return elk;
  } catch (err) {
    console.warn('[CodeCurrent] ELK web worker unavailable, laying out on the main thread', err);
    const shim = window as unknown as { module?: { exports: Record<string, unknown> } };
    shim.module = { exports: {} };
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      const nonce = (document.querySelector('script[nonce]') as HTMLScriptElement | null)?.nonce;
      if (nonce) s.nonce = nonce;
      if (code) s.textContent = code;
      else s.src = url!;
      s.onload = () => resolve();
      s.onerror = reject;
      document.head.appendChild(s);
      if (code) resolve();
    });
    const FakeWorker = shim.module!.exports.Worker as new (u?: string) => Worker;
    return new (ELK as unknown as new (o: object) => ElkLike)({ workerFactory: () => new FakeWorker() });
  }
}

function makeMeasure(): Measure {
  const ctx = document.createElement('canvas').getContext('2d')!;
  const cs = getComputedStyle(document.body);
  const fam = cs.getPropertyValue('--cc-font').trim() || 'sans-serif';
  const mono = cs.getPropertyValue('--cc-mono').trim() || 'monospace';
  const cache = new Map<string, number>();
  return (text, font) => {
    const key = font + '\u0000' + text;
    let w = cache.get(key);
    if (w === undefined) {
      ctx.font = font.replace('var(--cc-font)', fam).replace('var(--cc-mono)', mono);
      w = ctx.measureText(text).width;
      if (cache.size > 30000) cache.clear();
      cache.set(key, w);
    }
    return w;
  };
}

function readPalette(): FlowPalette {
  const cs = getComputedStyle(document.body);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return {
    call: v('--cc-call', '#36d6ff'),
    spawn: v('--cc-spawn', '#ff9f43'),
    instantiate: v('--cc-instantiate', '#3ddc97'),
    inherit: v('--cc-inherit', '#c792ea'),
    include: v('--cc-include', '#7d8a9c'),
    ret: v('--cc-ret', '#ffb347'),
  };
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (html) el.innerHTML = html;
  return el;
}

const LOGO = `<svg viewBox="0 0 16 16"><rect x="1" y="1" width="5" height="5" rx="1.2" fill="none" stroke="var(--cc-call)" stroke-width="1.4"/><rect x="10" y="10" width="5" height="5" rx="1.2" fill="none" stroke="var(--cc-class)" stroke-width="1.4"/><path d="M6 3.5h3.5v9H10" fill="none" stroke="var(--cc-call)" stroke-width="1.4"/><circle cx="9.5" cy="8" r="1.6" fill="var(--cc-ret)"/></svg>`;

// ---------------------------------------------------------------------------

class App {
  private state: UIState;
  private settings?: ViewSettings;
  private graph?: CodeGraph;
  private tree?: ViewTree;
  private proj?: Projection;
  private layout?: LayoutResult;
  private entities = new Map<string, Entity>();
  private gen = 0;
  private elk: Promise<ElkLike>;
  private measure: Measure;
  private renderer: Renderer;
  private flow: FlowLayer;
  private vp: Viewport;
  private fileCounts = new Map<string, number>();
  private fitPending = true;
  private selectedEdge: string | null = null;
  private dir: FlowDir = 'RIGHT';

  // DOM
  private root = document.getElementById('app') ?? document.body.appendChild(h('div', { id: 'app' }));
  private toolbar = h('div', { class: 'toolbar ui' });
  private stage = h('div', { class: 'stage' });
  private details = h('aside', { class: 'details ui', hidden: '' });
  private status = h('div', { class: 'status ui' });
  private tooltip = h('div', { class: 'tooltip', hidden: '' });
  private busy = h('div', { class: 'busy ui', hidden: '' });
  private notice = h('div', { class: 'notice ui', hidden: '' });
  private legend = h('div', { class: 'legend ui' });
  private empty = h('div', { class: 'empty' });
  private canvas = h('canvas');

  constructor() {
    const saved = api.getState() as Partial<UIState> | undefined;
    this.state = { ...DEFAULT_STATE, ...(saved ?? {}) };
    setLang(document.body.dataset.lang ?? navigator.language);
    this.measure = makeMeasure();
    this.elk = createElk();

    const main = h('div', { class: 'main' });
    main.append(this.stage, this.details);
    this.root.append(this.toolbar, main, this.status);
    this.renderer = new Renderer(this.stage);
    this.stage.append(this.canvas, this.legend, this.busy, this.notice, this.tooltip, this.empty);
    this.empty.innerHTML = `<div>${esc(t('analyzing'))}</div><div class="bar"><i></i></div>`;
    this.flow = new FlowLayer(this.canvas, readPalette());

    this.vp = new Viewport(this.stage, {
      onChange: () => {
        this.renderer.setTransform(this.vp.x, this.vp.y, this.vp.k);
        this.flow.setTransform(this.vp.x, this.vp.y, this.vp.k);
      },
      onTap: (target) => this.onTap(target),
      onDoubleTap: (target) => this.onDoubleTap(target),
    });
    new ResizeObserver(() => {
      this.flow.resize();
      // phone rotated / panel reshaped: re-flow the circuit along the long side
      if (this.graph && this.direction() !== this.dir) {
        this.fitPending = true;
        void this.refresh();
      }
    }).observe(this.stage);
    new MutationObserver(() => this.flow.setPalette(readPalette())).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    this.stage.addEventListener('pointermove', (e) => this.onHover(e));
    this.stage.addEventListener('pointerleave', () => (this.tooltip.hidden = true));
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('message', (e) => this.onHost(e.data as HostMessage));
    this.buildToolbar();
    this.buildLegend();
    this.flow.setMode(this.state.flow);
    this.flow.resize();
    api.postMessage({ type: 'ready' });
  }

  // -------------------------------------------------------------------------
  // host messages
  // -------------------------------------------------------------------------

  onHost(m: HostMessage): void {
    switch (m.type) {
      case 'progress': {
        const bar = this.empty.querySelector('.bar i') as HTMLElement | null;
        if (bar) bar.style.width = `${Math.round((100 * m.done) / Math.max(1, m.total))}%`;
        this.status.textContent = `${t('analyzing')} ${m.done}/${m.total}`;
        break;
      }
      case 'graph':
        this.setGraph(m.graph, m.settings, m.reason);
        break;
      case 'cursor':
        this.onCursor(m.file, m.line);
        break;
      case 'focusFile':
        this.focusFile(m.file);
        break;
      case 'error':
        this.showNotice(m.message, 8000);
        break;
    }
  }

  /** Standalone demo: swap the whole dataset and reset the view. */
  loadDemo(g: CodeGraph, settings: ViewSettings): void {
    this.state = { ...DEFAULT_STATE, style: this.state.style, flow: this.state.flow };
    this.graph = undefined;
    this.fitPending = true;
    this.setGraph(g, settings, 'initial');
  }

  private setGraph(g: CodeGraph, settings: ViewSettings, reason: 'initial' | 'update'): void {
    const first = !this.graph;
    this.graph = g;
    this.settings = settings;
    setLang(settings.lang);
    this.flow.maxParticles = settings.maxParticles;
    this.entities = new Map(g.entities.map((e) => [e.id, e]));
    this.empty.hidden = g.files.length > 0;
    if (!g.files.length) this.empty.innerHTML = `<div>${esc(t('empty'))}</div>`;
    if (first && !(api.getState() as UIState | undefined)) {
      this.state.style = settings.layout;
      this.state.flow = settings.flow;
      this.state.minConf = settings.showGuesses ? 'guess' : 'likely';
      this.flow.setMode(this.state.flow);
    }
    this.rebuildTree();
    if (!this.state.levelChosen && (first || reason === 'initial')) {
      this.state.level = settings.defaultLevel === 'auto' ? pickLevel(this.tree!, this.blockBudget()) : settings.defaultLevel;
    }
    this.fitPending = this.fitPending || reason === 'initial';
    this.buildToolbar();
    void this.refresh();
  }

  private rebuildTree(): void {
    if (!this.graph) return;
    this.tree = buildTree(this.graph, this.state.mode);
    this.fileCounts.clear();
  }

  // -------------------------------------------------------------------------
  // pipeline
  // -------------------------------------------------------------------------

  private counts = (n: PNode): string => {
    const tn = n.t;
    switch (tn.kind) {
      case 'dir':
        return `${t('filesN', { n: this.fileCount(tn) })} · ${t('fns', { n: tn.fnCount })}`;
      case 'file':
        return `${t('fns', { n: tn.fnCount })} · ${t('lines', { n: tn.file?.lines ?? 0 })}`;
      case 'class':
        return t('methods', { n: tn.fnCount });
      default:
        return t('fns', { n: tn.fnCount });
    }
  };

  private fileCount(tn: TNode): number {
    let c = this.fileCounts.get(tn.id);
    if (c !== undefined) return c;
    c = tn.kind === 'file' ? 1 : 0;
    for (const ch of tn.children) c += this.fileCount(this.tree!.nodes.get(ch)!);
    this.fileCounts.set(tn.id, c);
    return c;
  }

  private save(): void {
    api.setState(this.state);
  }

  /** Based on the window, not the stage, so opening the details sheet doesn't re-flow the circuit. */
  private direction(): FlowDir {
    if (this.state.style === 'network') return 'DOWN';
    return window.innerHeight > window.innerWidth * 1.15 ? 'DOWN' : 'RIGHT';
  }

  /** How many blocks fit legibly on this screen (phone ≈ 16, laptop ≈ 40). */
  private blockBudget(): number {
    return Math.max(16, Math.min(45, (window.innerWidth * window.innerHeight) / 30000));
  }

  async refresh(anchor?: { id: string; sx: number; sy: number }): Promise<void> {
    if (!this.graph || !this.tree) return;
    const gen = ++this.gen;
    const s = this.state;
    const proj = project(this.tree, this.graph, {
      level: s.level,
      expand: new Set(s.expand),
      collapse: new Set(s.collapse),
      kinds: new Set(s.kinds),
      minConf: s.minConf,
      focus: s.focus,
    });
    if (proj.leaves > 6000) {
      // keep the current picture; a 10k-block SVG would freeze the panel
      this.showNotice(t('tooMany', { n: proj.leaves }), 8000);
      if (this.proj) return;
    }
    const busyTimer = setTimeout(() => {
      this.busy.innerHTML = `<span class="spin"></span>${esc(t('layingOut', { n: proj.leaves }))}`;
      this.busy.hidden = false;
    }, 160);
    let layout: LayoutResult;
    const dir = this.direction();
    try {
      const routing = (window as unknown as { CODE_CURRENT_ROUTING?: 'auto' | 'full' | 'fast' }).CODE_CURRENT_ROUTING ?? 'auto';
      layout = await runLayout(await this.elk, proj, s.style, dir, this.measure, this.counts, routing);
    } catch (err) {
      clearTimeout(busyTimer);
      this.busy.hidden = true;
      this.showNotice(String((err as Error)?.message ?? err), 8000);
      return;
    }
    clearTimeout(busyTimer);
    if (gen !== this.gen) return;
    this.busy.hidden = true;
    this.proj = proj;
    this.layout = layout;
    this.dir = dir;
    this.renderer.draw(proj, layout, s.style, dir, this.measure, this.counts);
    this.flow.setPaths(
      proj.edges
        .map((e) => {
          const pts = layout.routes.get(e.id);
          if (!pts || pts.length < 2) return undefined;
          const structural = e.kind === 'include' || e.kind === 'import' || e.kind === 'inherit';
          return makePath(e.id, e.kind, samplePath(pts, s.style === 'network'), e.count, e.returns, structural || e.conf === 'guess');
        })
        .filter((p): p is NonNullable<typeof p> => !!p),
    );
    if (anchor) {
      const b = layout.boxes.get(anchor.id);
      if (b) this.vp.set(anchor.sx - b.x * this.vp.k, anchor.sy - b.y * this.vp.k, this.vp.k);
    } else if (this.fitPending) {
      this.fitPending = false;
      this.fit(false);
    }
    this.renderer.setTransform(this.vp.x, this.vp.y, this.vp.k);
    if (this.selectedEdge && proj.edges.some((e) => e.id === this.selectedEdge)) this.selectEdge(this.selectedEdge);
    else this.select(s.selected && proj.nodes.has(s.selected) ? s.selected : null, !this.details.hidden);
    if (layout.fast && proj.leaves > 300) this.showNotice(t('fastLayout', { n: proj.leaves, w: proj.edges.length }), 7000);
    else if (layout.fallback) this.showNotice(t('fallback'), 5000);
    this.updateStatus();
    this.updateToolbarState();
  }

  private fit(animate = true): void {
    const l = this.layout;
    if (!l || !l.width) return;
    this.vp.fit(0, 0, l.width, l.height, 30, 1.1, animate);
  }

  private updateStatus(): void {
    const g = this.graph;
    if (!g) return;
    const st = g.stats;
    const pct = st.callSites ? Math.round((100 * st.resolvedCalls) / st.callSites) : 100;
    this.status.innerHTML =
      `<span>${esc(t('statFiles', { n: st.files }))}</span><span>${esc(t('statFns', { n: st.functions }))}</span>` +
      `<span>${esc(t('statLinks', { n: this.proj?.edges.length ?? 0 }))}</span><span>${esc(t('statResolved', { p: pct }))}</span>` +
      `<span>${esc(t('statLayout', { ms: Math.round(this.layout?.ms ?? 0) }))}${this.layout?.fast ? ' · ' + esc(t('compact')) : ''}</span><span class="hint">${esc(t('hint'))}</span>`;
  }

  private showNotice(msg: string, ms: number): void {
    this.notice.textContent = msg;
    this.notice.hidden = false;
    clearTimeout((this.notice as unknown as { _t?: number })._t);
    (this.notice as unknown as { _t?: number })._t = window.setTimeout(() => (this.notice.hidden = true), ms);
  }

  // -------------------------------------------------------------------------
  // toolbar & legend
  // -------------------------------------------------------------------------

  private buildToolbar(): void {
    const tb = this.toolbar;
    tb.innerHTML = '';
    tb.append(h('span', { class: 'brand' }, `${LOGO}<span>CodeCurrent</span>`));

    const levels = h('div', { class: 'seg', role: 'group', 'data-role': 'levels' });
    for (const l of LEVELS) {
      const b = h('button', { 'data-level': l, title: `${t(l)} (${LEVELS.indexOf(l) + 1})` }, esc(t(l)));
      b.onclick = () => this.setLevel(l);
      levels.append(b);
    }
    const modes = h('div', { class: 'seg', 'data-role': 'modes' });
    for (const m of ['files', 'symbols'] as GroupMode[]) {
      const b = h('button', { 'data-mode': m }, esc(t(m)));
      b.onclick = () => this.setMode(m);
      modes.append(b);
    }
    const styles = h('div', { class: 'seg', 'data-role': 'styles' });
    for (const st of ['circuit', 'network'] as LayoutStyle[]) {
      const b = h('button', { 'data-style': st }, esc(t(st)));
      b.onclick = () => {
        this.state.style = st;
        this.fitPending = true;
        this.save();
        void this.refresh();
      };
      styles.append(b);
    }
    tb.append(levels, modes, styles);

    // search
    const search = h('div', { class: 'search' });
    const input = h('input', { type: 'search', placeholder: t('search'), spellcheck: 'false' });
    const results = h('div', { class: 'results', hidden: '' });
    search.append(input, results);
    let active = 0;
    let hits: TNode[] = [];
    const renderHits = () => {
      results.hidden = !input.value.trim();
      results.innerHTML = hits.length
        ? hits
            .map(
              (n, i) =>
                `<div class="r${i === active ? ' active' : ''}" data-i="${i}"><span class="pill k-${n.kind}" style="--k:var(--cc-${n.kind})">${esc(n.tag)}</span>` +
                `<span>${esc(n.label)}</span><span class="q">${esc(n.entity?.qname ?? n.file?.path ?? '')}</span></div>`,
            )
            .join('')
        : `<div class="r">${esc(t('noResults'))}</div>`;
    };
    input.oninput = () => {
      hits = this.searchNodes(input.value);
      active = 0;
      renderHits();
    };
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown') active = Math.min(hits.length - 1, active + 1);
      else if (e.key === 'ArrowUp') active = Math.max(0, active - 1);
      else if (e.key === 'Enter' && hits[active]) {
        this.reveal(hits[active].id);
        results.hidden = true;
        input.blur();
        return;
      } else if (e.key === 'Escape') {
        results.hidden = true;
        input.blur();
        return;
      } else return;
      e.preventDefault();
      renderHits();
    };
    input.onblur = () => setTimeout(() => (results.hidden = true), 150);
    results.onmousedown = (e) => {
      const r = (e.target as Element).closest('[data-i]');
      if (!r) return;
      this.reveal(hits[Number(r.getAttribute('data-i'))].id);
      results.hidden = true;
    };
    tb.append(search);

    const flowBtn = h('button', { class: 'btn', 'data-role': 'flow' });
    flowBtn.onclick = () => {
      const order: FlowMode[] = ['all', 'focus', 'off'];
      this.state.flow = order[(order.indexOf(this.state.flow) + 1) % order.length];
      this.flow.setMode(this.state.flow);
      this.save();
      this.updateToolbarState();
    };
    const wires = h('button', { class: 'btn' }, `${esc(t('edges'))} ▾`);
    wires.onclick = (e) => {
      e.stopPropagation();
      this.toggleWirePopover(wires);
    };
    const fit = h('button', { class: 'btn', title: 'F' }, esc(t('fit')));
    fit.onclick = () => this.fit();
    tb.append(flowBtn, wires, fit);
    const focusChip = h('span', { class: 'chip', 'data-role': 'focus', hidden: '' });
    tb.append(focusChip);
    tb.append(h('span', { class: 'spacer' }));
    if (this.settings?.host !== false) {
      const re = h('button', { class: 'btn', title: t('reanalyze') }, '↻');
      re.onclick = () => api.postMessage({ type: 'reanalyze' });
      tb.append(re);
    }
    this.updateToolbarState();
  }

  private updateToolbarState(): void {
    const s = this.state;
    const eff = this.tree ? effectiveLevel(this.tree, s.level) : s.level;
    for (const b of this.toolbar.querySelectorAll<HTMLButtonElement>('[data-level]')) {
      const l = b.dataset.level as ViewKind;
      b.classList.toggle('on', l === eff);
      b.disabled = s.mode === 'symbols' && RANK[l] < RANK.namespace;
    }
    for (const b of this.toolbar.querySelectorAll<HTMLButtonElement>('[data-mode]')) b.classList.toggle('on', b.dataset.mode === s.mode);
    for (const b of this.toolbar.querySelectorAll<HTMLButtonElement>('[data-style]')) b.classList.toggle('on', b.dataset.style === s.style);
    const fb = this.toolbar.querySelector<HTMLButtonElement>('[data-role=flow]');
    if (fb) {
      fb.textContent = '⚡ ' + t(s.flow === 'all' ? 'flowAll' : s.flow === 'focus' ? 'flowFocus' : 'flowOff');
      fb.classList.toggle('on', s.flow !== 'off');
    }
    const chip = this.toolbar.querySelector<HTMLElement>('[data-role=focus]');
    if (chip) {
      const fnode = s.focus ? this.tree?.nodes.get(s.focus.id) : undefined;
      chip.hidden = !fnode;
      if (fnode) {
        chip.innerHTML = `${esc(t('focusOn', { name: fnode.label }))} <button title="${esc(t('clearFocus'))}">✕</button>`;
        chip.querySelector('button')!.onclick = () => this.setFocus(null);
      }
    }
  }

  private toggleWirePopover(anchor: HTMLElement): void {
    const existing = document.querySelector('.pop.wires');
    if (existing) {
      existing.remove();
      return;
    }
    const pop = h('div', { class: 'pop wires ui' });
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${r.left}px`;
    pop.style.top = `${r.bottom + 4}px`;
    for (const k of ALL_KINDS) {
      const lab = h('label');
      const cb = h('input', { type: 'checkbox' });
      cb.checked = this.state.kinds.includes(k);
      cb.onchange = () => {
        this.state.kinds = cb.checked ? [...new Set([...this.state.kinds, k])] : this.state.kinds.filter((x) => x !== k);
        this.save();
        void this.refresh();
      };
      lab.append(cb, h('span', { class: 'sw', style: `background:var(--cc-${k})` }), document.createTextNode(`${KIND_ICON[k]} ${t(k)}`));
      pop.append(lab);
    }
    const g = h('label');
    const cb = h('input', { type: 'checkbox' });
    cb.checked = this.state.minConf === 'guess';
    cb.onchange = () => {
      this.state.minConf = cb.checked ? 'guess' : 'likely';
      this.save();
      void this.refresh();
    };
    g.append(cb, document.createTextNode(t('guesses')));
    pop.append(h('hr', { style: 'border:0;border-top:1px solid var(--cc-border);margin:6px 0' }), g);
    document.body.append(pop);
    setTimeout(() => {
      const close = (e: MouseEvent) => {
        if (!pop.contains(e.target as Node)) {
          pop.remove();
          document.removeEventListener('mousedown', close);
        }
      };
      document.addEventListener('mousedown', close);
    });
  }

  private buildLegend(): void {
    const item = (k: string, label: string, dashed = false) =>
      `<div><span class="sw" style="background:${dashed ? `repeating-linear-gradient(90deg,var(--cc-${k}) 0 5px,transparent 5px 8px)` : `var(--cc-${k})`}"></span>${esc(label)}</div>`;
    this.legend.innerHTML =
      item('call', `${KIND_ICON.call} ${t('call')}`) +
      item('ret', t('returnFlow')) +
      item('spawn', `${KIND_ICON.spawn} ${t('spawn')}`, true) +
      item('instantiate', `${KIND_ICON.instantiate} ${t('instantiate')}`) +
      item('inherit', `${KIND_ICON.inherit} ${t('inherit')}`) +
      item('include', `${t('include')} / ${t('import')}`, true);
  }

  // -------------------------------------------------------------------------
  // view changes
  // -------------------------------------------------------------------------

  private setLevel(l: ViewKind): void {
    this.state.level = l;
    this.state.levelChosen = true;
    this.state.expand = [];
    this.state.collapse = [];
    this.fitPending = true;
    this.save();
    void this.refresh();
  }

  private setMode(m: GroupMode): void {
    if (this.state.mode === m) return;
    this.state.mode = m;
    this.state.expand = [];
    this.state.collapse = [];
    this.state.selected = null;
    this.state.focus = null;
    this.rebuildTree();
    if (!this.state.levelChosen && this.tree) this.state.level = pickLevel(this.tree, this.blockBudget());
    this.fitPending = true;
    this.save();
    void this.refresh();
  }

  private setFocus(f: { id: string; hops: number } | null): void {
    this.state.focus = f;
    this.fitPending = true;
    this.save();
    void this.refresh();
  }

  private anchorOf(id: string): { id: string; sx: number; sy: number } | undefined {
    const b = this.layout?.boxes.get(id);
    return b ? { id, sx: b.x * this.vp.k + this.vp.x, sy: b.y * this.vp.k + this.vp.y } : undefined;
  }

  /** Expand a collapsed block / collapse a container. */
  toggle(id: string): void {
    const n = this.proj?.nodes.get(id);
    if (!n || !n.t.children.length) return;
    const expand = new Set(this.state.expand);
    const collapse = new Set(this.state.collapse);
    if (n.container) {
      expand.delete(id);
      collapse.add(id);
    } else {
      collapse.delete(id);
      expand.add(id);
    }
    this.state.expand = [...expand];
    this.state.collapse = [...collapse];
    this.save();
    void this.refresh(this.anchorOf(id));
  }

  /** Make a tree node visible (expand its ancestors), select and center it. */
  async reveal(id: string, keepFocus = false): Promise<void> {
    if (!this.tree) return;
    const expand = new Set(this.state.expand);
    const collapse = new Set(this.state.collapse);
    for (const a of ancestorsOf(this.tree, id)) {
      collapse.delete(a);
      expand.add(a);
    }
    this.state.expand = [...expand];
    this.state.collapse = [...collapse];
    if (this.state.focus && !keepFocus) this.state.focus = null;
    this.state.selected = id;
    this.save();
    await this.refresh();
    this.select(id);
    const b = this.layout?.boxes.get(id);
    if (b) this.vp.centerOn(b.x + b.w / 2, b.y + b.h / 2, Math.max(this.vp.k, 0.9));
  }

  private revealEntity(entityId: string): void {
    const id = this.tree?.entityNode.get(entityId);
    if (id) void this.reveal(id);
  }

  private focusFile(file: string): void {
    const id = this.tree?.fileNode.get('f:' + file);
    if (!id) return;
    this.state.focus = { id, hops: 1 };
    this.state.selected = id;
    this.fitPending = true;
    void this.reveal(id, true);
  }

  private onCursor(file: string, line: number): void {
    if (!this.tree || !this.proj) return;
    let best: TNode | undefined;
    let bestSpan = Infinity;
    for (const n of this.tree.nodes.values()) {
      const l = n.loc;
      if (!l || l.file !== file || n.kind === 'file' || n.kind === 'dir') continue;
      if (line < l.line || line > l.endLine) continue;
      const span = l.endLine - l.line;
      if (span < bestSpan) {
        best = n;
        bestSpan = span;
      }
    }
    const target = best?.id ?? this.tree.fileNode.get('f:' + file);
    if (!target) return;
    let vis: string | undefined = target;
    while (vis && !this.proj.nodes.has(vis)) vis = this.tree.nodes.get(vis)?.parent ?? undefined;
    this.renderer.pulseNode(vis ?? null);
  }

  private searchNodes(q: string): TNode[] {
    const query = q.trim().toLowerCase();
    if (!query || !this.tree) return [];
    const scored: { n: TNode; s: number }[] = [];
    for (const n of this.tree.nodes.values()) {
      if (n.fragment) continue;
      const label = n.label.toLowerCase();
      const qn = (n.entity?.qname ?? n.file?.path ?? '').toLowerCase();
      let s = 0;
      if (label === query) s = 4;
      else if (label.startsWith(query)) s = 3;
      else if (label.includes(query)) s = 2;
      else if (qn.includes(query)) s = 1;
      if (s) scored.push({ n, s: s * 10 - n.depth * 0.1 + (n.kind === 'function' ? 0.5 : 0) });
    }
    return scored
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.n);
  }

  // -------------------------------------------------------------------------
  // selection & details
  // -------------------------------------------------------------------------

  private onTap(target: Element | null): void {
    document.querySelector('.pop.wires')?.remove();
    if (target?.closest('[data-act=collapse]')) {
      const z = target.closest('[data-id]');
      if (z) this.toggle(z.getAttribute('data-id')!);
      return;
    }
    const el = target?.closest('[data-id]');
    if (!el) {
      this.select(null);
      return;
    }
    const id = el.getAttribute('data-id')!;
    if (el.hasAttribute('data-edge')) this.selectEdge(id);
    else this.select(this.state.selected === id && !this.details.hidden ? id : id);
  }

  private onDoubleTap(target: Element | null): void {
    const el = target?.closest('[data-id]');
    if (!el || el.hasAttribute('data-edge')) return;
    const id = el.getAttribute('data-id')!;
    const n = this.proj?.nodes.get(id);
    if (!n) return;
    if (n.t.children.length) this.toggle(id);
    else if (n.t.loc) this.openLoc(n.t.loc.file, n.t.loc.line);
  }

  select(id: string | null, showPanel = true): void {
    this.selectedEdge = null;
    this.state.selected = id;
    this.save();
    const p = this.proj;
    if (!id || !p?.nodes.has(id)) {
      this.renderer.highlight(null);
      this.flow.setFocus(null);
      this.details.hidden = true;
      return;
    }
    const inside = (nid: string) => {
      for (let c: string | null = nid; c; c = p.nodes.get(c)?.parent ?? null) if (c === id) return true;
      return false;
    };
    const nodes = new Set<string>([id]);
    const edges = new Set<string>();
    const touching: PEdge[] = [];
    for (const e of p.edges) {
      if (inside(e.src) || inside(e.dst)) {
        edges.add(e.id);
        nodes.add(e.src);
        nodes.add(e.dst);
        touching.push(e);
      }
    }
    for (const n of [...nodes]) for (let c = p.nodes.get(n)?.parent ?? null; c; c = p.nodes.get(c)?.parent ?? null) nodes.add(c);
    // children of a selected container stay lit
    const stack = [id];
    while (stack.length) {
      const c = p.nodes.get(stack.pop()!)!;
      for (const ch of c.children) {
        nodes.add(ch);
        stack.push(ch);
      }
    }
    this.renderer.highlight({ node: id, nodes, edges });
    this.renderer.dataLabels(
      touching.map((e) => ({ edge: e, text: this.wireText(e) })),
      this.measure,
    );
    this.flow.setFocus(edges);
    if (showPanel) this.renderNodeDetails(p.nodes.get(id)!, touching);
  }

  private selectEdge(id: string): void {
    const p = this.proj;
    const e = p?.edges.find((x) => x.id === id);
    if (!p || !e) return;
    this.selectedEdge = id;
    this.renderer.highlight({ nodes: new Set([e.src, e.dst, ...this.ancestorsVisible(e.src), ...this.ancestorsVisible(e.dst)]), edges: new Set([id]) });
    this.renderer.dataLabels([{ edge: e, text: this.wireText(e) }], this.measure);
    this.flow.setFocus(new Set([id]));
    this.renderEdgeDetails(e);
  }

  private ancestorsVisible(id: string): string[] {
    const out: string[] = [];
    for (let c = this.proj?.nodes.get(id)?.parent ?? null; c; c = this.proj?.nodes.get(c)?.parent ?? null) out.push(c);
    return out;
  }

  private sigTypes(e: Entity | undefined): string {
    if (!e || e.kind !== 'function') return '';
    return `(${(e.params ?? []).map((p) => p.type ?? p.name ?? '?').join(', ')})`;
  }

  /** What travels on a wire, compactly. */
  private wireText(e: PEdge): string {
    if (e.kind === 'spawn') return `⚡ ${e.rels[0]?.via ?? 'thread'}`;
    if (e.kind === 'inherit') return t('extends');
    if (e.kind === 'include') return '#include';
    if (e.kind === 'import') return 'import';
    if (e.rels.length === 1) {
      const r = e.rels[0];
      const callee = this.entities.get(r.to);
      const args = r.sites?.[0]?.args;
      const a = args ? `(${args.join(', ')})` : this.sigTypes(callee);
      const ret = callee?.returns && !/^(void|None)$/.test(callee.returns) ? ` ⟲ ${callee.returns}` : '';
      const text = (e.kind === 'instantiate' ? 'new ' : '') + a + ret + (r.count > 1 ? ` ×${r.count}` : '');
      return text.length > 46 ? text.slice(0, 45) + '…' : text;
    }
    // aggregated wire: name what is reached through it
    const names = [...new Set(e.rels.map((r) => this.entities.get(e.kind === 'inherit' ? r.from : r.to)?.name ?? '?'))];
    const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
    return `${shown} ×${e.count}`;
  }

  private nameOf(id: string): string {
    if (id.startsWith('f:')) return id.slice(2);
    return this.entities.get(id)?.qname ?? id;
  }

  private locLink(file: string, line: number): string {
    return `<a data-open="${esc(file)}" data-line="${line}">${esc(file)}:${line}</a>`;
  }

  private renderNodeDetails(n: PNode, touching: PEdge[]): void {
    const tn = n.t;
    const e = tn.entity;
    const d = this.details;
    const k = `--k:var(--cc-${tn.kind})`;
    let html = `<h2><span class="pill" style="${k}">${esc(tn.tag)}</span>${esc(tn.label)}<button class="close" title="Esc">✕</button></h2>`;
    html += `<div class="qn">${esc(e?.qname ?? tn.file?.path ?? tn.label)}</div>`;
    const flags = (e?.flags ?? []).filter((f) => f !== 'threadEntry');
    html += '<div class="row">';
    if (e?.flags?.includes('threadEntry')) html += `<span class="flag thread">⚡ ${esc(t('threadEntry'))}</span>`;
    for (const f of flags) html += `<span class="flag">${esc(f === 'decl' ? t('decl') : f)}</span>`;
    if (tn.fragment) html += `<span class="flag">${esc(t('fragmentNote'))}</span>`;
    html += '</div>';
    const locs: string[] = [];
    if (e?.def) locs.push(this.locLink(e.def.file, e.def.line));
    if (e?.decl && (e.decl.file !== e.def?.file || e.decl.line !== e.def?.line)) locs.push(this.locLink(e.decl.file, e.decl.line));
    if (!e && tn.loc) locs.push(this.locLink(tn.loc.file, tn.loc.line));
    if (locs.length) html += `<div class="row">${locs.join(' · ')}</div>`;
    if (e?.kind === 'function') {
      const ps = (e.params ?? []).map((p) => `${p.type ?? ''}${p.name ? ' ' + p.name : ''}`.trim()).join(',\n  ');
      html += `<h3>${esc(t('params'))} → ${esc(t('returns'))}</h3><div class="sig">${esc(`${e.name}(${ps ? '\n  ' + ps + '\n' : ''})${e.returns ? ' → ' + e.returns : ''}`)}</div>`;
    }
    html += '<div class="row">';
    if (tn.loc) html += `<button class="btn" data-act="open">${esc(t('openSource'))}</button>`;
    html += `<button class="btn" data-act="focus">${esc(t('focus'))}</button>`;
    if (tn.children.length) html += `<button class="btn" data-act="toggle">${esc(n.container ? t('collapse') : t('expand'))}</button>`;
    html += '</div>';

    if (e && !n.container && !tn.children.length && (e.kind === 'function' || e.kind === 'class')) {
      const inc = this.graph!.relations.filter((r) => r.to === e.id);
      const out = this.graph!.relations.filter((r) => r.from === e.id);
      html += this.relList(t('incoming'), inc, 'from');
      html += this.relList(t('outgoing'), out, 'to');
    } else {
      const inc = touching.filter((x) => !this.isInside(x.src, n.id));
      const out = touching.filter((x) => this.isInside(x.src, n.id) && !this.isInside(x.dst, n.id));
      html += this.edgeList(t('incoming'), inc, 'src');
      html += this.edgeList(t('outgoing'), out, 'dst');
    }
    if (tn.children.length) {
      const byKind = new Map<string, number>();
      const walk = (id: string) => {
        const c = this.tree!.nodes.get(id)!;
        byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
        c.children.forEach(walk);
      };
      tn.children.forEach(walk);
      html += `<h3>${esc(t('contains'))}</h3><div class="row">${[...byKind]
        .map(([kk, c]) => `<span class="pill" style="--k:var(--cc-${kk})">${esc(t(kk as ViewKind))} ${c}</span>`)
        .join(' ')}</div>`;
    }
    d.innerHTML = html;
    d.hidden = false;
    this.wireDetails(n.id, tn);
  }

  private isInside(nid: string, container: string): boolean {
    for (let c: string | null = nid; c; c = this.proj?.nodes.get(c)?.parent ?? null) if (c === container) return true;
    return false;
  }

  private relList(title: string, rels: Relation[], end: 'from' | 'to'): string {
    if (!rels.length) return '';
    const sorted = [...rels].sort((a, b) => b.count - a.count).slice(0, 60);
    const items = sorted
      .map((r) => {
        const other = r[end];
        const args = r.sites?.[0]?.args;
        const site = r.sites?.[0];
        return (
          `<li class="conf-${r.conf}"><span class="dot" style="background:var(--cc-${r.kind})" title="${esc(t(r.kind))}"></span>` +
          `<a data-entity="${esc(other)}">${esc(KIND_ICON[r.kind])} ${esc(this.nameOf(other))}</a><span class="cnt">${r.count > 1 ? '×' + r.count : ''} ${esc(t(r.conf))}</span>` +
          (args || site ? `<span class="args">${args ? esc('(' + args.join(', ') + ')') + ' ' : ''}${site ? this.locLink(site.file, site.line) : ''}</span>` : '') +
          `</li>`
        );
      })
      .join('');
    return `<h3>${esc(title)} (${rels.length})</h3><ul class="lst">${items}</ul>`;
  }

  private edgeList(title: string, edges: PEdge[], end: 'src' | 'dst'): string {
    if (!edges.length) return '';
    const items = edges
      .sort((a, b) => b.count - a.count)
      .slice(0, 60)
      .map((e) => {
        const other = this.proj!.nodes.get(e[end])!;
        return (
          `<li><span class="dot" style="background:var(--cc-${e.kind})"></span><a data-node="${esc(other.id)}">${esc(KIND_ICON[e.kind])} ${esc(other.t.label)}</a>` +
          `<span class="cnt">×${e.count}</span><span class="args">${esc(this.wireText(e))}</span></li>`
        );
      })
      .join('');
    return `<h3>${esc(title)} (${edges.length})</h3><ul class="lst">${items}</ul>`;
  }

  private renderEdgeDetails(e: PEdge): void {
    const a = this.proj!.nodes.get(e.src)!.t;
    const b = this.proj!.nodes.get(e.dst)!.t;
    let html = `<h2><span class="pill" style="--k:var(--cc-${e.kind})">${esc(KIND_ICON[e.kind])} ${esc(t(e.kind))}</span>×${e.count}<button class="close">✕</button></h2>`;
    html += `<div class="row"><a data-node="${esc(e.src)}">${esc(a.label)}</a> → <a data-node="${esc(e.dst)}">${esc(b.label)}</a></div>`;
    html += `<div class="row"><span class="flag">${esc(t('confidence'))}: ${esc(t(e.conf))}</span>${e.returns ? `<span class="flag">${esc(t('returnFlow'))}</span>` : ''}</div>`;
    const items = e.rels
      .slice(0, 80)
      .map((r) => {
        const sites = (r.sites ?? [])
          .slice(0, 4)
          .map((s) => `${this.locLink(s.file, s.line)}${s.args ? ' <span class="q">' + esc('(' + s.args.join(', ') + ')') + '</span>' : ''}`)
          .join('<br>');
        const callee = this.entities.get(r.to);
        const sig = callee?.kind === 'function' ? signature({ t: { entity: callee } } as unknown as PNode) ?? '' : '';
        return (
          `<li class="conf-${r.conf}"><span class="dot" style="background:var(--cc-${r.kind})"></span>` +
          `<span><a data-entity="${esc(r.from)}">${esc(this.nameOf(r.from))}</a> → <a data-entity="${esc(r.to)}">${esc(this.nameOf(r.to))}</a></span>` +
          `<span class="cnt">${r.count > 1 ? '×' + r.count : ''}${r.via ? ' ' + esc(r.via) : ''}</span>` +
          `<span class="args">${sig ? esc(sig) + '<br>' : ''}${sites}</span></li>`
        );
      })
      .join('');
    html += `<h3>${esc(t('sites'))} (${e.rels.length})</h3><ul class="lst">${items}</ul>`;
    this.details.innerHTML = html;
    this.details.hidden = false;
    this.wireDetails(null);
  }

  private wireDetails(nodeId: string | null, tn?: TNode): void {
    const d = this.details;
    d.querySelector('.close')?.addEventListener('click', () => this.select(null));
    for (const a of d.querySelectorAll<HTMLElement>('[data-open]')) a.onclick = () => this.openLoc(a.dataset.open!, Number(a.dataset.line));
    for (const a of d.querySelectorAll<HTMLElement>('[data-entity]')) {
      a.onclick = () => {
        const id = a.dataset.entity!;
        if (id.startsWith('f:')) {
          const nid = this.tree?.fileNode.get(id);
          if (nid) void this.reveal(nid);
        } else this.revealEntity(id);
      };
    }
    for (const a of d.querySelectorAll<HTMLElement>('[data-node]')) a.onclick = () => this.select(a.dataset.node!);
    if (nodeId && tn) {
      d.querySelector<HTMLElement>('[data-act=open]')?.addEventListener('click', () => tn.loc && this.openLoc(tn.loc.file, tn.loc.line));
      d.querySelector<HTMLElement>('[data-act=focus]')?.addEventListener('click', () => this.setFocus({ id: nodeId, hops: 1 }));
      d.querySelector<HTMLElement>('[data-act=toggle]')?.addEventListener('click', () => this.toggle(nodeId));
    }
  }

  private openLoc(file: string, line: number): void {
    if (this.settings?.host === false) {
      this.showNotice(`${file}:${line}`, 2500);
      return;
    }
    api.postMessage({ type: 'open', file, line });
  }

  // -------------------------------------------------------------------------
  // hover & keys
  // -------------------------------------------------------------------------

  private onHover(ev: PointerEvent): void {
    if (ev.buttons) return;
    const el = (ev.target as Element)?.closest?.('[data-id]');
    if (!el || !this.proj) {
      this.tooltip.hidden = true;
      return;
    }
    const id = el.getAttribute('data-id')!;
    let html = '';
    if (el.hasAttribute('data-edge')) {
      const e = this.proj.edges.find((x) => x.id === id);
      if (!e) return;
      const a = this.proj.nodes.get(e.src)!.t.label;
      const b = this.proj.nodes.get(e.dst)!.t.label;
      html = `<b>${esc(KIND_ICON[e.kind])} ${esc(a)} → ${esc(b)}</b> <span class="mono">×${e.count} · ${esc(t(e.conf))}</span><div class="mono">${esc(this.wireText(e))}</div>`;
    } else {
      const n = this.proj.nodes.get(id);
      if (!n) return;
      const e = n.t.entity;
      const sig = signature(n);
      html = `<b>${esc(e?.qname ?? n.t.file?.path ?? n.t.label)}</b>${sig ? `<div class="mono">${esc(sig)}</div>` : ''}`;
      if (n.t.loc) html += `<div class="mono">${esc(n.t.loc.file)}:${n.t.loc.line}</div>`;
    }
    const r = this.stage.getBoundingClientRect();
    this.tooltip.innerHTML = html;
    this.tooltip.hidden = false;
    const x = Math.min(ev.clientX - r.left + 14, r.width - this.tooltip.offsetWidth - 8);
    const y = Math.min(ev.clientY - r.top + 16, r.height - this.tooltip.offsetHeight - 8);
    this.tooltip.style.left = `${Math.max(4, x)}px`;
    this.tooltip.style.top = `${Math.max(4, y)}px`;
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as Element)?.tagName === 'INPUT') return;
    if (e.key === '/') {
      e.preventDefault();
      this.toolbar.querySelector<HTMLInputElement>('.search input')?.focus();
    } else if (e.key === 'Escape') {
      if (this.state.selected || this.selectedEdge) this.select(null);
      else if (this.state.focus) this.setFocus(null);
    } else if (e.key === 'f' || e.key === 'F') this.fit();
    else if (/^[1-5]$/.test(e.key)) this.setLevel(LEVELS[Number(e.key) - 1]);
    else if (e.key === 'Enter' && this.state.selected) {
      const loc = this.proj?.nodes.get(this.state.selected)?.t.loc;
      if (loc) this.openLoc(loc.file, loc.line);
    }
  }
}

const app = new App();
(window as unknown as { codeCurrent: App }).codeCurrent = app;
if (window.__CODE_CURRENT_DEMO__) {
  const d = window.__CODE_CURRENT_DEMO__;
  setTimeout(() => app.onHost({ type: 'graph', graph: d.graph, settings: d.settings, reason: 'initial' }), 0);
}
