/**
 * CodeGraph webview app.
 * State → project() → ELK (worker) → SVG blocks/wires + canvas flow.
 */
import ELK from 'elkjs/lib/elk-api.js';
import './style.css';
import { attachDiagnostics, computeHealth, impactPath, type Health } from '../core/health';
import type { CodeGraph, Confidence, Diagnostic, Entity, Relation, RelationKind } from '../core/model';
import type { CodeAsk, CodeSnip, DiagSet, HostMessage, VerifyInfo, ViewSettings, WebviewMessage } from '../shared/protocol';
import { FlowLayer, makePath, type FlowMode, type FlowPalette } from './flow';
import { setLang, t } from './i18n';
import { runLayout, samplePath, signature, type ElkLike, type FlowDir, type LayoutResult, type LayoutStyle, type Measure } from './layout';
import {
  ALL_KINDS,
  CONF_RANK,
  LEVELS,
  ancestorsOf,
  availableLevels,
  buildTree,
  effectiveLevel,
  hasSymbolsMode,
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
import { buildOverlay, type Overlay } from './overlay';
import { Renderer, esc } from './render';
import { Timeline } from './timeline';
import { LiveLanes } from './livelanes';
import { ProcBar, type ProcCard } from './procbar';
import { RuntimeMap, TraceModel, argsText, augmentGraph, fmtNs, retText, threadColor, valText } from './traceview';
import type { LiveUpdate } from '../core/live';
import type { Peek } from '../core/peek';
import type { RunTrace } from '../core/trace';
import { MemberIndex } from './members';
import { TypeIndex, typeUsages } from './usage';
import { Viewport } from './viewport';

/** A place in the details panel waiting for code from the host. */
interface CodeSlot {
  slot: string;
  ask: CodeAsk;
}

/** A function's signature as its language writes it, one parameter per line: what the panel colours. */
function declText(e: Entity): string {
  const ps = e.params ?? [];
  if (e.lang === 'python') {
    const list = ps.map((p) => `${p.name ?? ''}${p.type ? ': ' + p.type : ''}`);
    return `def ${e.name}(${list.length ? '\n    ' + list.join(',\n    ') + ',\n' : ''})${e.returns ? ' -> ' + e.returns : ''}`;
  }
  const list = ps.map((p) => `${p.type ?? ''}${p.name ? ' ' + p.name : ''}`.trim());
  return `${e.returns ? e.returns + ' ' : ''}${e.name}(${list.length ? '\n    ' + list.join(',\n    ') + '\n' : ''})`;
}


interface VsApi {
  postMessage(m: WebviewMessage): void;
  getState(): unknown;
  setState(s: unknown): void;
}
declare function acquireVsCodeApi(): VsApi;
declare global {
  interface Window {
    __CODE_GRAPH_DEMO__?: { graph: CodeGraph; settings: ViewSettings; trace?: RunTrace };
  }
}

const api: VsApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : {
        postMessage: () => undefined,
        getState: () => {
          try {
            return JSON.parse(localStorage.getItem('code-graph-state') ?? 'null');
          } catch {
            return undefined;
          }
        },
        setState: (s) => {
          try {
            localStorage.setItem('code-graph-state', JSON.stringify(s));
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
  /** Show the problems overlay (red / orange / grey). */
  health: boolean;
  /** The legend is folded to its title. */
  legendFolded?: boolean;
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
  health: true,
};

/** Threads listed in the legend; the rest are counted ("+3 more"). */
const LEGEND_THREADS = 8;

const KIND_ICON: Record<RelationKind, string> = { call: '→', spawn: '⚡', instantiate: '✚', inherit: '△', include: '#', import: '⇣' };

/** Thread of every recorded call. */
function s_th(tr: RunTrace): number[] {
  return tr.spans.th;
}

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

/** Hosted demo page: ELK comes from a CDN (the page itself only carries CodeGraph's code). */
async function createElkFromCdn(base: string): Promise<ElkLike> {
  try {
    const boot = `importScripts(${JSON.stringify(base + 'elk-worker.min.js')});`;
    const blobUrl = URL.createObjectURL(new Blob([boot], { type: 'application/javascript' }));
    const elk = new (ELK as unknown as ElkCtor)({ workerFactory: () => new Worker(blobUrl) });
    await withTimeout(elk.knownLayoutAlgorithms(), 15000);
    return elk;
  } catch (err) {
    console.warn('[CodeGraph] CDN worker unavailable, laying out on the main thread', err);
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
    console.warn('[CodeGraph] ELK web worker unavailable, laying out on the main thread', err);
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
    broken: v('--cc-broken', '#ff4d5e'),
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
  private diagSets = new Map<DiagSet, { diags: Diagnostic[]; info?: VerifyInfo }>();
  private health?: Health;
  private overlay?: Overlay;
  private task?: { task: string; state: string; message?: string; done?: number; total?: number };
  /** Graph as analysed; `graph` adds the calls only a run revealed. */
  private staticGraph?: CodeGraph;
  private trace?: TraceModel;
  private rtmap?: RuntimeMap;
  private timeline?: Timeline;
  private traceNotes: string[] = [];
  /** This view shows one process (container) of a trace of several. */
  private traceScope?: string;
  /** Applying another view's replay state: do not send it back. */
  private syncing = false;
  /** A run in progress, followed live: its bar (threads, time, Stop) and wire lookup. */
  private liveBar?: HTMLElement;
  private liveThreads = '';
  private liveEnds?: { proj: Projection; map: Map<string, string> };
  private replay = { t: 0, playing: false, speed: 1, raf: 0, wall: 0 };
  private live: { node: string; text: string; color: string; born: number; up?: boolean }[] = [];
  private follow: string | null = null;
  private soloThread: number | null = null;
  /** Containers chosen in the container cards (empty: all), kept from the live view into its replay. */
  private procSel = new Set<string>();
  /** Threads of the chosen containers in what is shown now (null: every thread). */
  private procThreads: Set<number> | null = null;
  private procBar?: ProcBar;
  /** Live: swimlanes, the thread followed in the circuit, and what it went through since. */
  private liveLanes?: LiveLanes;
  private liveSolo: number | null = null;
  private liveSoloPath = new Set<string>();
  private lastLive?: LiveUpdate;
  private liveSpark = new Map<string, number[]>();
  /** Live, with a container or thread chosen: what it lit so far, kept lit while the rest is dimmed. */
  private liveLit = { nodes: new Set<string>(), edges: new Set<string>() };
  /** Hover previews of source lines from the host, by `file:line:count`; the one the tooltip waits for. */
  private peeks = new Map<string, Peek | null>();
  private peekAsked = new Map<number, string>();
  private peekReq = 0;
  private peekTimer = 0;
  private peekWant = '';
  /** The preview in the tooltip now: plain lines get replaced when their colours arrive. */
  private peekShown = '';
  /** Code the details panel asked the host for: which node it was for and which slots to fill. */
  private codeReq = 0;
  /** The next details panel opens at its "calls inside" list (the ↻ badge was clicked). */
  private showInternal = false;
  /** Class names as code may write them, for "where its objects live"; rebuilt with each graph. */
  private typeIndex?: TypeIndex;
  /** Where each member of each class is read and written; rebuilt with each graph. */
  private memberIndex?: MemberIndex;
  private codeAsked = new Map<number, { node: string; slots: { slot: string; file: string }[] }>();
  private lastHover?: PointerEvent;
  /** What the tooltip shows and where it was put: it stays there while the pointer stays on that element. */
  private tip = { id: '', html: '', x: 0, y: 0 };

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
  /** The legend lists every thread (after "+N more"), not only the first ones. */
  private legendAllThreads = false;
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
      onTap: (target, ev) => this.onTap(target, ev),
      onDoubleTap: (target, ev) => {
        if (!ev.ctrlKey && !ev.metaKey) this.onDoubleTap(target);
      },
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
      case 'diagnostics':
        this.diagSets.set(m.set, { diags: m.diagnostics, info: m.info });
        this.recomputeHealth();
        this.redraw();
        this.updateToolbarState();
        break;
      case 'task':
        this.task = m.state === 'done' || m.state === 'error' ? undefined : m;
        if (m.state === 'error' && m.message) this.showNotice(m.message, 8000);
        else if (m.state === 'progress' && m.message && m.task !== 'verify') this.status.dataset.task = m.message;
        this.updateToolbarState();
        break;
      case 'trace':
        this.traceScope = m.trace ? m.scope : undefined;
        this.setTrace(m.trace, m.notes ?? []);
        break;
      case 'showProblems':
        this.showProblems();
        break;
      case 'replay':
        this.followReplay(m.t, m.playing, m.speed);
        break;
      case 'live':
        if (m.state === 'end') this.endLive();
        else if (m.update) this.applyLive(m.update);
        break;
      case 'peek':
        this.gotPeek(m.req, m.peek, m.final !== false);
        break;
      case 'code':
        this.gotCode(m.req, m.items);
        break;
      case 'peekReset':
        this.peeks.clear();
        this.peekWant = '';
        break;
      case 'error':
        this.showNotice(m.message, 8000);
        break;
    }
  }

  /** Standalone demo: swap the whole dataset and reset the view. */
  loadDemo(g: CodeGraph, settings: ViewSettings, trace?: RunTrace): void {
    this.state = { ...DEFAULT_STATE, style: this.state.style, flow: this.state.flow };
    this.graph = undefined;
    this.staticGraph = undefined;
    this.diagSets.clear();
    this.fitPending = true;
    this.clearTraceState();
    this.setGraph(g, settings, 'initial');
    if (trace) {
      // CLI runs carry their build / runtime problems and notes along
      const extra = trace as RunTrace & { diagnostics?: Diagnostic[]; notes?: string[] };
      if (extra.diagnostics?.length) this.diagSets.set('runtime', { diags: extra.diagnostics });
      this.recomputeHealth();
      this.setTrace(trace, extra.notes ?? []);
    }
  }

  private setGraph(g: CodeGraph, settings: ViewSettings, reason: 'initial' | 'update'): void {
    const first = !this.graph;
    this.staticGraph = g;
    this.graph = this.trace ? augmentGraph(g, this.trace.tr) : g;
    this.typeIndex = undefined;
    this.memberIndex = undefined;
    this.settings = settings;
    setLang(settings.lang);
    this.flow.maxParticles = settings.maxParticles;
    this.entities = new Map(g.entities.map((e) => [e.id, e]));
    if (g.compile && !this.diagSets.has('compile')) this.diagSets.set('compile', { diags: g.compile.diagnostics, info: g.compile.info });
    this.empty.hidden = g.files.length > 0;
    if (!g.files.length) this.empty.innerHTML = `<div>${esc(t('empty'))}</div>`;
    if (first && !(api.getState() as UIState | undefined)) {
      this.state.style = settings.layout;
      this.state.flow = settings.flow;
      this.state.minConf = settings.showGuesses ? 'guess' : 'likely';
      this.flow.setMode(this.state.flow);
    }
    this.rebuildTree();
    this.recomputeHealth();
    if (!this.state.levelChosen && (first || reason === 'initial')) {
      this.state.level = settings.defaultLevel === 'auto' ? pickLevel(this.tree!, this.blockBudget()) : settings.defaultLevel;
    }
    this.fitPending = this.fitPending || reason === 'initial';
    this.buildToolbar();
    void this.refresh();
  }

  private rebuildTree(): void {
    if (!this.graph) return;
    if (this.state.mode === 'symbols' && !hasSymbolsMode(this.graph)) this.state.mode = 'files';
    this.tree = buildTree(this.graph, this.state.mode, { pairSources: this.settings?.headerWrapsSource !== false });
    this.fileCounts.clear();
  }

  /** Abstraction levels that exist for the languages in this graph (Namespace only for C++, …). */
  private levels(): ViewKind[] {
    return this.tree && this.graph ? availableLevels(this.tree, this.graph) : LEVELS;
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

  async refresh(anchor?: { id: string; sx: number; sy: number }, animate = true): Promise<void> {
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
      const routing = (window as unknown as { CODE_GRAPH_ROUTING?: 'auto' | 'full' | 'fast' }).CODE_GRAPH_ROUTING ?? 'auto';
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
    // the same picture, rearranged (open / close, level, focus): blocks slide to their new places
    const before = this.proj && this.layout && this.proj.nodes.size && animate ? { x: this.vp.x, y: this.vp.y, k: this.vp.k } : undefined;
    this.proj = proj;
    this.layout = layout;
    this.dir = dir;
    if (anchor) {
      // the block that was clicked keeps its place on screen
      const b = layout.boxes.get(anchor.id);
      if (b) this.vp.set(anchor.sx - b.x * this.vp.k, anchor.sy - b.y * this.vp.k, this.vp.k);
    } else if (this.fitPending) {
      this.fitPending = false;
      this.fit(false);
    }
    if (before) {
      const s1 = before.k / this.vp.k;
      const r = this.stage.getBoundingClientRect();
      this.renderer.transitionFrom({ sx: s1, sy: s1, tx: (before.x - this.vp.x) / this.vp.k, ty: (before.y - this.vp.y) / this.vp.k }, (0.8 * Math.hypot(r.width, r.height)) / this.vp.k);
    }
    this.paint();
    if (this.renderer.transitionMs) this.flow.fadeIn(this.renderer.transitionMs);
    this.renderer.setTransform(this.vp.x, this.vp.y, this.vp.k);
    if (this.selectedEdge && proj.edges.some((e) => e.id === this.selectedEdge)) this.selectEdge(this.selectedEdge);
    else this.select(s.selected && proj.nodes.has(s.selected) ? s.selected : null, !this.details.hidden);
    if (layout.fast && proj.leaves > 300) this.showNotice(t('fastLayout', { n: proj.leaves, w: proj.edges.length }), 7000);
    else if (layout.fallback) this.showNotice(t('fallback'), 5000);
    this.updateStatus();
    this.updateToolbarState();
  }

  /** Merge problem sets: the compiler / interpreter verdict replaces tree-sitter's coarse parse errors. */
  private mergedDiagnostics(): Diagnostic[] {
    const info = this.diagSets.get('compile')?.info;
    const out: Diagnostic[] = [];
    for (const d of this.graph?.diagnostics ?? []) {
      if (d.source === 'syntax' && (/\.pyi?$/.test(d.file) ? info?.pyChecked : info?.cChecked)) continue;
      out.push(d);
    }
    for (const set of this.diagSets.values()) out.push(...set.diags);
    const seen = new Set<string>();
    return out.filter((d) => {
      const k = `${d.file}:${d.line}:${d.severity}:${d.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  private recomputeHealth(): void {
    if (!this.graph) return;
    this.health = computeHealth(this.graph, attachDiagnostics(this.graph, this.mergedDiagnostics()));
  }

  /** Draw the current layout (no ELK run): blocks, wires, overlay, flow. */
  private paint(): void {
    const proj = this.proj;
    const layout = this.layout;
    if (!proj || !layout || !this.graph) return;
    const s = this.state;
    const had = !!this.overlay;
    this.overlay = s.health && this.health && (this.health.broken.size || this.health.affected.size) ? buildOverlay(proj, this.graph, this.health) : undefined;
    if (had !== !!this.overlay) this.buildLegend();
    this.rtmap = this.trace ? new RuntimeMap(this.trace, proj) : undefined;
    const rt = this.rtmap?.overlay;
    this.renderer.draw(proj, layout, s.style, this.dir, this.measure, this.counts, this.overlay, (e) => this.wireClass(e), rt);
    this.flow.setPaths(
      proj.edges
        .map((e) => {
          const pts = layout.routes.get(e.id);
          if (!pts || pts.length < 2) return undefined;
          const structural = e.kind === 'include' || e.kind === 'import' || e.kind === 'inherit';
          let st: 'ok' | 'cut' | 'dead' = this.overlay?.wires.get(e.id) ?? 'ok';
          // with a trace, current only flows where the program actually went
          const ran = rt?.wires.get(e.id);
          if (rt && !ran && st === 'ok') st = 'dead';
          return makePath(e.id, e.kind, samplePath(pts, s.style === 'network'), ran ? ran.n : e.count, e.returns, structural || e.conf === 'guess', st);
        })
        .filter((p): p is NonNullable<typeof p> => !!p),
    );
    // a soloed thread or chosen containers stay lit on the new picture
    if (this.trace && (this.soloThread !== null || this.procThreads)) this.setSolo(this.soloThread, false);
    else if (this.trace) this.applyReplay();
  }

  /** Extra classes for a wire (hooks for runtime-observed wires). */
  private wireClass(_e: PEdge): string {
    return '';
  }

  /** Re-render without a new layout (diagnostics changed). */
  private redraw(): void {
    if (!this.proj || !this.layout) return;
    this.paint();
    this.renderer.setTransform(this.vp.x, this.vp.y, this.vp.k);
    if (this.selectedEdge && this.proj.edges.some((e) => e.id === this.selectedEdge)) this.selectEdge(this.selectedEdge);
    else this.select(this.state.selected && this.proj.nodes.has(this.state.selected) ? this.state.selected : null, !this.details.hidden);
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
    tb.append(h('span', { class: 'brand' }, `${LOGO}<span>CodeGraph</span>`));

    const levels = h('div', { class: 'seg', role: 'group', 'data-role': 'levels' });
    const avail = this.levels();
    avail.forEach((l, i) => {
      const b = h('button', { 'data-level': l, title: `${t(l)} (${i + 1})` }, esc(t(this.levelLabel(l))));
      b.onclick = () => this.setLevel(l);
      levels.append(b);
    });
    const modes = h('div', { class: 'seg', 'data-role': 'modes' });
    if (!this.graph || hasSymbolsMode(this.graph)) {
      for (const m of ['files', 'symbols'] as GroupMode[]) {
        const b = h('button', { 'data-mode': m }, esc(t(m)));
        b.onclick = () => this.setMode(m);
        modes.append(b);
      }
    } else modes.hidden = true;
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
    const healthBtn = h('button', { class: 'btn health', 'data-role': 'health', hidden: '' });
    healthBtn.onclick = () => this.showProblems();
    tb.append(healthBtn);
    tb.append(h('span', { class: 'spacer' }));
    if (this.trace) {
      const tr = this.trace.tr;
      const label = this.traceScope ? t('traceChipScope', { name: this.traceScope, n: tr.threads.length }) : t('traceChip', { n: tr.threads.length });
      const chip = h('button', { class: 'btn trace-chip', title: t('traceHint') }, `◉ ${esc(label)}`);
      chip.onclick = () => this.showTraceSummary();
      tb.append(chip);
      if (this.settings?.host !== false && tr.procs && tr.procs.length > 1) {
        const split = h('button', { class: 'btn', 'data-role': 'split', title: t('splitHint') }, `⧉ ${esc(t('split'))}`);
        split.onclick = () => api.postMessage({ type: 'splitTrace' });
        tb.append(split);
      }
    }
    if (this.settings?.host !== false) {
      const verify = h('button', { class: 'btn', 'data-role': 'verify', title: t('verifyHint') }, `✓ ${esc(t('verify'))}`);
      verify.onclick = () => api.postMessage({ type: 'verify' });
      const run = h('button', { class: 'btn run', 'data-role': 'run', title: t('runHint') }, `▶ ${esc(t('run'))}`);
      run.onclick = () => api.postMessage({ type: 'runTrace' });
      tb.append(verify, run);
    }
    if (this.settings?.host !== false) {
      const re = h('button', { class: 'btn', title: t('reanalyze') }, '↻');
      re.onclick = () => api.postMessage({ type: 'reanalyze' });
      tb.append(re);
    }
    this.updateToolbarState();
  }

  /** Python-only code bases call folders and files packages and modules. */
  private levelLabel(l: ViewKind): ViewKind | 'package' | 'module' {
    const py = !!this.graph && this.graph.files.length > 0 && this.graph.files.every((f) => f.lang === 'python');
    if (py && l === 'dir') return 'package';
    if (py && l === 'file') return 'module';
    return l;
  }

  private updateToolbarState(): void {
    const s = this.state;
    const eff = this.tree ? effectiveLevel(this.tree, s.level) : s.level;
    for (const b of this.toolbar.querySelectorAll<HTMLButtonElement>('[data-level]')) {
      b.classList.toggle('on', b.dataset.level === eff);
    }
    for (const b of this.toolbar.querySelectorAll<HTMLButtonElement>('[data-mode]')) b.classList.toggle('on', b.dataset.mode === s.mode);
    for (const b of this.toolbar.querySelectorAll<HTMLButtonElement>('[data-style]')) b.classList.toggle('on', b.dataset.style === s.style);
    const fb = this.toolbar.querySelector<HTMLButtonElement>('[data-role=flow]');
    if (fb) {
      fb.textContent = '⚡ ' + t(s.flow === 'all' ? 'flowAll' : s.flow === 'focus' ? 'flowFocus' : 'flowOff');
      fb.classList.toggle('on', s.flow !== 'off');
    }
    const hb = this.toolbar.querySelector<HTMLButtonElement>('[data-role=health]');
    if (hb) {
      const hl = this.health;
      const ran = this.diagSets.has('compile') || this.diagSets.has('build');
      hb.classList.remove('bad', 'good', 'busy');
      if (this.task) {
        hb.hidden = false;
        hb.classList.add('busy');
        const prog = this.task.total ? ` ${this.task.done ?? 0}/${this.task.total}` : '';
        hb.innerHTML = `<span class="spin"></span>${esc(t(this.task.task === 'run' ? 'running' : this.task.task === 'build' ? 'building' : 'verifying'))}${prog}`;
      } else if (hl && hl.errors) {
        hb.hidden = false;
        hb.classList.add('bad');
        hb.textContent = `✕ ${hl.errors}` + (hl.affected.size ? `  ⚠ ${hl.affected.size}` : '') + (hl.unpowered.size ? `  ○ ${hl.unpowered.size}` : '');
        hb.title = t('problemsHint');
      } else if (ran) {
        hb.hidden = false;
        hb.classList.add('good');
        hb.textContent = '✓ ' + t('noErrors');
      } else hb.hidden = true;
      const vb = this.toolbar.querySelector<HTMLButtonElement>('[data-role=verify]');
      if (vb) vb.disabled = !!this.task || this.settings?.trusted === false;
      const rb = this.toolbar.querySelector<HTMLButtonElement>('[data-role=run]');
      if (rb) rb.disabled = !!this.task || this.settings?.trusted === false;
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
    const hl = h('label');
    const hcb = h('input', { type: 'checkbox' });
    hcb.checked = this.state.health;
    hcb.onchange = () => {
      this.state.health = hcb.checked;
      this.save();
      this.redraw();
    };
    hl.append(hcb, document.createTextNode(t('showProblems')));
    pop.append(h('hr', { style: 'border:0;border-top:1px solid var(--cc-border);margin:6px 0' }), g, hl);
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
    const threads = this.trace?.tr.threads ?? [];
    const more = threads.length - LEGEND_THREADS;
    const folded = !!this.state.legendFolded;
    const body =
      item('call', `${KIND_ICON.call} ${t('call')}`) +
      item('ret', t('returnFlow')) +
      item('spawn', `${KIND_ICON.spawn} ${t('spawn')}`, true) +
      item('instantiate', `${KIND_ICON.instantiate} ${t('instantiate')}`) +
      item('inherit', `${KIND_ICON.inherit} ${t('inherit')}`) +
      item('include', `${t('include')} / ${t('import')}`, true) +
      (this.trace
        ? // every thread once "+N more" is clicked, in a list of its own that the wheel scrolls
          `<div class="lg-threads${this.legendAllThreads ? ' all' : ''}">` +
          threads
            .slice(0, this.legendAllThreads ? threads.length : LEGEND_THREADS)
            .map((th) => `<div class="lg-x"><span class="sw" style="background:${threadColor(th.id)}"></span>${esc(th.name)}</div>`)
            .join('') +
          '</div>' +
          (more > 0
            ? `<button class="lg-more" data-act="threads">${esc(this.legendAllThreads ? t('legendFewer') : t('legendMore', { n: more }))}</button>`
            : '') +
          `<div class="lg-x"><span class="sw" style="background:var(--cc-muted);opacity:.35"></span>${esc(t('coldCode'))}</div>`
        : '') +
      (this.overlay
        ? `<div class="lg-x"><span class="sw-b bad"></span>✕ ${esc(t('legendBroken'))}</div>` +
          `<div class="lg-x"><span class="sw-b warn"></span>⚠ ${esc(t('legendAffected'))}</div>` +
          `<div class="lg-x"><span class="sw-b off"></span>○ ${esc(t('legendUnpowered'))}</div>`
        : '');
    this.legend.classList.toggle('folded', folded);
    this.legend.innerHTML =
      `<button class="lg-head" aria-expanded="${!folded}" title="${esc(t(folded ? 'legendUnfold' : 'legendFold'))}"><span class="lg-caret">▾</span>${esc(t('legend'))}</button>` +
      `<div class="lg-body"><div class="lg-grid">${body}</div></div>`;
    this.legend.querySelector<HTMLElement>('.lg-head')!.onclick = () => {
      this.state.legendFolded = !this.state.legendFolded;
      this.save();
      this.buildLegend();
    };
    const moreBtn = this.legend.querySelector<HTMLElement>('[data-act=threads]');
    if (moreBtn) {
      moreBtn.onclick = () => {
        this.legendAllThreads = !this.legendAllThreads;
        this.buildLegend();
      };
    }
  }

  // -------------------------------------------------------------------------
  // view changes
  // -------------------------------------------------------------------------

  private setLevel(l: ViewKind): void {
    if (!this.levels().includes(l)) return;
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
    this.buildToolbar();
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

  private onTap(target: Element | null, ev?: PointerEvent): void {
    document.querySelector('.pop.wires')?.remove();
    // Ctrl+click (⌘+click on macOS), as in the editor: straight to the code
    if (ev && (ev.ctrlKey || ev.metaKey)) {
      const el = target?.closest('[data-id]');
      const src = el ? this.sourceOf(el.getAttribute('data-id')!, el.hasAttribute('data-edge')) : undefined;
      if (src) {
        this.openLoc(src.file, src.line);
        return;
      }
    }
    if (target?.closest('[data-act=collapse]') || target?.closest('[data-act=expand]')) {
      const z = target.closest('[data-id]');
      if (z) this.toggle(z.getAttribute('data-id')!);
      return;
    }
    if (target?.closest('[data-act=internal]')) {
      const z = target.closest('[data-id]');
      if (z) {
        this.showInternal = true;
        this.select(z.getAttribute('data-id')!);
      }
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
      this.timeline?.setHighlight(new Set());
      if (this.follow) this.setFollow(null);
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
    this.timeline?.setHighlight(this.fnsOfNode(id));
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

  /** What travels on a wire, compactly (`max`: longest text for one link; the tooltip asks for more). */
  private wireText(e: PEdge, max = 46): string {
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
      return text.length > max ? text.slice(0, max - 1) + '…' : text;
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

  private diagItem(d: Diagnostic): string {
    return (
      `<li class="diag sev-${d.severity}"><span class="dot"></span><span><span class="pill src">${esc(t(d.source))}</span> ${esc(d.message)}</span>` +
      `<span class="args">${this.locLink(d.file, d.line)}</span></li>`
    );
  }

  /** Problems section for a block: its errors, or the path to the break that affects it. */
  private problemsSection(n: PNode): string {
    const st = this.overlay?.blocks.get(n.id);
    const h = this.health;
    if (!st || !h || !this.graph) return '';
    if (st.state === 'broken') {
      const ids = this.idsUnder(n.id);
      const dependents = [...h.affected.values()].filter((a) => ids.has(a.cause)).length;
      return (
        `<h3 class="bad">✕ ${esc(t('brokenHere'))} (${st.errors})</h3><ul class="lst">${st.diags.slice(0, 30).map((d) => this.diagItem(d)).join('')}</ul>` +
        (dependents ? `<div class="row"><span class="flag bad">${esc(t('impactText', { n: dependents }))}</span></div>` : '')
      );
    }
    if (st.state === 'affected') {
      const id = [...this.idsUnder(n.id)].find((x) => h.affected.get(x)?.dist === st.dist);
      if (!id) return '';
      const path = impactPath(h, this.graph, id);
      const chain = path
        .map((p, i) => {
          const name = this.nameOf(p.node);
          const last = i === path.length - 1;
          return `<a data-entity="${esc(p.node)}" class="${last ? 'bad' : ''}">${esc(name)}</a>` + (p.rel ? ` <span class="q">${esc(KIND_ICON[p.rel.kind])}</span> ` : '');
        })
        .join('');
      return `<h3 class="warn">⚠ ${esc(t('dependsOn'))}</h3><div class="sig">${chain}</div>`;
    }
    return `<h3>○ ${esc(t('legendUnpowered'))}</h3><div class="row q">${esc(t('unpoweredText'))}</div>`;
  }

  /** Entity / file ids represented by a visible node (itself and everything collapsed into it). */
  private idsUnder(nodeId: string): Set<string> {
    const out = new Set<string>();
    if (!this.tree) return out;
    const walk = (id: string) => {
      const tn = this.tree!.nodes.get(id);
      if (!tn) return;
      if (tn.entity) out.add(tn.entity.id);
      if (tn.file) out.add(tn.file.id);
      tn.children.forEach(walk);
    };
    walk(nodeId);
    return out;
  }

  showProblems(): void {
    const h = this.health;
    if (!h || !this.graph) return;
    const info = this.diagSets.get('compile')?.info ?? this.diagSets.get('build')?.info;
    let html = `<h2><span class="pill bad">✕</span>${esc(t('problems'))}<button class="close">✕</button></h2>`;
    html += `<div class="row"><span class="flag bad">${esc(t('errorsN', { n: h.errors }))}</span><span class="flag warn">${esc(t('affectedN', { n: h.affected.size }))}</span>`;
    html += `<span class="flag">${esc(t('unpoweredN', { n: h.unpowered.size }))}</span>${h.warningCount ? `<span class="flag">${esc(t('warningsN', { n: h.warningCount }))}</span>` : ''}</div>`;
    html += `<div class="row q">${esc(info ? t('checkedWith', { c: info.checkedC, p: info.checkedPython, ms: info.ms }) : t('notVerified'))}</div>`;
    if (this.settings?.trusted === false) html += `<div class="row q">${esc(t('untrusted'))}</div>`;
    if (this.settings?.host !== false) html += `<div class="row"><button class="btn" data-act="verify">✓ ${esc(t('verifyAgain'))}</button></div>`;
    const impactOf = new Map<string, number>();
    for (const a of h.affected.values()) impactOf.set(a.cause, (impactOf.get(a.cause) ?? 0) + 1);
    for (const [target, diags] of h.broken) {
      if (target.startsWith('py:mod:') && h.broken.get('f:' + target.slice(7)) === diags) continue;
      const n = impactOf.get(target) ?? 0;
      html +=
        `<h3><a data-entity="${esc(target)}" class="bad">✕ ${esc(this.nameOf(target))}</a>${n ? ` <span class="nocase warn">→ ${esc(t('affectedN', { n }))}</span>` : ''}</h3>` +
        `<ul class="lst">${diags.slice(0, 12).map((d) => this.diagItem(d)).join('')}</ul>`;
    }
    const aff = [...h.affected.entries()].filter(([id]) => this.entities.get(id)?.kind === 'function').sort((a, b) => a[1].dist - b[1].dist);
    if (aff.length) {
      html += `<h3 class="warn">⚠ ${esc(t('impact'))}</h3><ul class="lst">`;
      for (const [id, a] of aff.slice(0, 30))
        html += `<li><span class="dot" style="background:var(--cc-affected)"></span><a data-entity="${esc(id)}">${esc(this.nameOf(id))}</a><span class="args">+${a.dist} · ${esc(this.nameOf(a.cause))}</span></li>`;
      html += '</ul>';
    }
    const warn = [...h.warnings.values()].flat();
    if (warn.length) html += `<h3>${esc(t('warningsN', { n: warn.length }))}</h3><ul class="lst">${warn.slice(0, 40).map((d) => this.diagItem(d)).join('')}</ul>`;
    if (info?.notes.length) html += `<h3>${esc(t('notes'))}</h3>${info.notes.map((x) => `<div class="row q">${esc(x)}</div>`).join('')}`;
    this.details.innerHTML = html;
    this.details.hidden = false;
    this.details.querySelector<HTMLElement>('[data-act=verify]')?.addEventListener('click', () => api.postMessage({ type: 'verify' }));
    this.wireDetails(null);
  }

  private renderNodeDetails(n: PNode, touching: PEdge[]): void {
    const tn = n.t;
    const e = tn.entity;
    const d = this.details;
    const asks: CodeSlot[] = [];
    const host = this.settings?.host !== false;
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
      const sig = declText(e);
      html += `<h3>${esc(t('params'))} → ${esc(t('returns'))}</h3><div class="sig code-slot" data-slot="sig">${esc(sig)}</div>`;
      if (host) asks.push({ slot: 'sig', ask: { file: '', line: 0, what: 'text', text: sig, lang: e.lang } });
      // every `return`, as written: what it gives back and when
      html += `<h3>${esc(t('retStatements'))}</h3>`;
      if (!e.def) html += `<div class="row q">${esc(t('noBody'))}</div>`;
      else if (host) {
        html += `<div class="code-slot" data-slot="ret"><span class="q">…</span></div>`;
        asks.push({ slot: 'ret', ask: { file: e.def.file, line: e.def.line, endLine: e.def.endLine, what: 'returns', lines: e.rets ?? [] } });
      }
    }
    if (e?.kind === 'class') html += this.classSection(e, host ? asks : undefined);
    html += this.problemsSection(n);
    html += this.runtimeSection(n);
    if (n.internal) html += this.internalSection(n, host ? asks : undefined);
    html += '<div class="row">';
    if (tn.loc) html += `<button class="btn" data-act="open">${esc(t('openSource'))}</button>`;
    html += `<button class="btn" data-act="focus">${esc(t('focus'))}</button>`;
    if (tn.children.length) html += `<button class="btn" data-act="toggle">${esc(n.container ? t('collapse') : t('expand'))}</button>`;
    html += '</div>';

    if (e && !n.container && !tn.children.length && e.kind === 'function') {
      const inc = this.graph!.relations.filter((r) => r.to === e.id);
      const out = this.graph!.relations.filter((r) => r.from === e.id);
      html += this.relList(t('incoming'), inc, 'from', host ? asks : undefined);
      html += this.relList(t('outgoing'), out, 'to', host ? asks : undefined);
    } else if (!(e?.kind === 'class' && !n.container && !tn.children.length)) {
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
    if (e?.kind === 'class') this.wireMemberUses(n.id, e);
    if (asks.length) this.askCode(n.id, asks);
    if (this.showInternal) d.querySelector('.internal-calls')?.scrollIntoView({ block: 'start' });
    this.showInternal = false;
  }

  /** ↻: the calls that start and end inside this block, so they draw no wire out of it. */
  private internalSection(n: PNode, asks?: CodeSlot[]): string {
    const tree = this.tree!;
    const inside = (id: string) => {
      for (let c = id.startsWith('f:') ? tree.fileNode.get(id) : tree.entityNode.get(id); c; c = tree.nodes.get(c)?.parent ?? undefined) if (c === n.id) return true;
      return false;
    };
    const kinds = new Set(this.state.kinds);
    const minRank = CONF_RANK[this.state.minConf];
    const rels = this.graph!.relations
      .filter((r) => kinds.has(r.kind) && CONF_RANK[r.conf] >= minRank && inside(r.from) && inside(r.to))
      .sort((a, b) => b.count - a.count);
    if (!rels.length) return '';
    const items = rels.slice(0, 60).map((r, k) => {
      const site = r.sites?.[0];
      let code = '';
      if (asks && site && k < 15) {
        const slot = 's' + asks.length;
        asks.push({ slot, ask: { file: site.file, line: site.line, what: 'stmt' } });
        code = `<div class="code-slot" data-slot="${slot}"></div>`;
      }
      return (
        `<li class="conf-${r.conf}"><span class="dot" style="background:var(--cc-${r.kind})"></span>` +
        `<span><a data-entity="${esc(r.from)}">${esc(this.nameOf(r.from))}</a> ${esc(KIND_ICON[r.kind])} <a data-entity="${esc(r.to)}">${esc(this.nameOf(r.to))}</a></span>` +
        `<span class="cnt">${r.count > 1 ? '×' + r.count : ''}</span>` +
        (site ? `<span class="args">${site.args ? esc('(' + site.args.join(', ') + ')') + ' ' : ''}${this.locLink(site.file, site.line)}</span>` : '') +
        code +
        `</li>`
      );
    });
    const total = rels.reduce((s, r) => s + r.count, 0);
    return `<h3 class="internal-calls">↻ ${esc(t('internalCalls'))} (${total})</h3><div class="row q">${esc(t('internalHint'))}</div><ul class="lst">${items.join('')}</ul>`;
  }

  /** Class: its members, family, where its objects are made, and where they live. */
  private classSection(e: Entity, asks?: CodeSlot[]): string {
    const rels = this.graph!.relations;
    let html = '';
    if (e.fields?.length) {
      const text = e.fields.map((f) => (e.lang === 'python' ? `${f.name}${f.type ? ': ' + f.type : ''}` : `${f.type ?? ''} ${f.name ?? ''};`.trim())).join('\n');
      html += `<h3>${esc(t('members'))} (${e.fields.length})</h3><div class="sig code-slot" data-slot="mem">${esc(text)}</div>`;
      asks?.push({ slot: 'mem', ask: { file: '', line: 0, what: 'text', text, lang: e.lang } });
      html += this.memberUsesSection(e);
    }
    const link = (id: string, extra = '') =>
      `<li><span class="dot" style="background:var(--cc-inherit)"></span><a data-entity="${esc(id)}">${esc(this.nameOf(id))}</a>${extra ? `<span class="args">${extra}</span>` : ''}</li>`;
    const bases = rels.filter((r) => r.kind === 'inherit' && r.from === e.id);
    const derived = rels.filter((r) => r.kind === 'inherit' && r.to === e.id);
    if (bases.length) html += `<h3>${esc(t('bases'))} (${bases.length})</h3><ul class="lst">${bases.map((r) => link(r.to)).join('')}</ul>`;
    if (derived.length) html += `<h3>${esc(t('derived'))} (${derived.length})</h3><ul class="lst">${derived.map((r) => link(r.from)).join('')}</ul>`;
    html += this.relList(t('createdAt'), rels.filter((r) => r.kind === 'instantiate' && r.to === e.id), 'from', asks);
    // where objects of it live: members of other classes, parameters, return values (types looked up by scope)
    this.typeIndex ??= new TypeIndex(this.graph!);
    const use = typeUsages(this.graph!, e, this.typeIndex);
    // one step further up: where each holder itself goes (click it to keep climbing)
    const onward = (id: string): string => {
      const h = this.graph!.entities.find((x) => x.id === id);
      if (!h) return '';
      const up = typeUsages(this.graph!, h, this.typeIndex);
      const names = [...up.holders.map((u) => `${u.id}|${this.nameOf(u.id)}.${u.name}`), ...up.takers.map((u) => `${u.id}|${this.nameOf(u.id)}(${u.name ?? ''})`)];
      if (!names.length) return '';
      const shown = names.slice(0, 4).map((s) => {
        const [i, label] = [s.slice(0, s.indexOf('|')), s.slice(s.indexOf('|') + 1)];
        return `<a data-entity="${esc(i)}">${esc(label)}</a>`;
      });
      return `<div class="onward">↳ ${esc(t('goesOn', { name: h.name }))} ${shown.join(', ')}${names.length > 4 ? ` +${names.length - 4}` : ''}</div>`;
    };
    const holders = use.holders.map((u) => link(u.id, esc(`${u.name}: ${u.type}`)).replace(/<\/li>$/, `${onward(u.id)}</li>`));
    const takers = use.takers.map((u) => link(u.id, esc(`${u.name ?? ''}: ${u.type}`)));
    const givers = use.givers.map((u) => link(u.id, esc(`→ ${u.type}`)));
    const list = (title: string, items: string[]) => (items.length ? `<h3>${esc(title)} (${items.length})</h3><ul class="lst">${items.slice(0, 40).join('')}</ul>` : '');
    html += list(t('heldBy'), holders) + list(t('passedTo'), takers) + list(t('returnedBy'), givers);
    return html;
  }

  /** Each member with how many functions read and write it; opening one lists them (filled by `wireMemberUses`). */
  private memberUsesSection(e: Entity): string {
    this.typeIndex ??= new TypeIndex(this.graph!);
    this.memberIndex ??= new MemberIndex(this.graph!, this.typeIndex);
    const used = this.memberIndex.of(e.id);
    const rows = (e.fields ?? [])
      .filter((f) => f.name && used.has(f.name))
      .map((f) => {
        const sites = used.get(f.name!)!;
        const r = sites.filter((x) => !x.write).length;
        const w = sites.filter((x) => x.write).length;
        return `<li class="mu" data-mem="${esc(f.name!)}"><button class="mu-h"><code>${esc(f.name!)}</code><span class="args">${esc(t('readsWrites', { r, w }))}</span></button><div class="mu-list" hidden></div></li>`;
      });
    if (!rows.length) return '';
    return `<h3>${esc(t('memberUses'))}</h3><div class="row q">${esc(t('memberUsesHint'))}</div><ul class="lst mu-lst">${rows.join('')}</ul>`;
  }

  /** Opening a member lists the functions using it, with the line of code, and lights them up on the circuit. */
  private wireMemberUses(node: string, cls: Entity): void {
    const used = this.memberIndex?.of(cls.id);
    if (!used) return;
    const items = [...this.details.querySelectorAll<HTMLElement>('.mu')];
    for (const li of items) {
      li.querySelector<HTMLElement>('.mu-h')!.onclick = () => {
        const open = !li.classList.contains('open');
        for (const o of items) {
          o.classList.remove('open');
          o.querySelector<HTMLElement>('.mu-list')!.hidden = true;
        }
        if (!open) {
          this.select(node, false);
          return;
        }
        li.classList.add('open');
        const list = li.querySelector<HTMLElement>('.mu-list')!;
        list.hidden = false;
        const sites = [...(used.get(li.dataset.mem!) ?? [])].sort((a, b) => Number(b.write) - Number(a.write));
        const asks: CodeSlot[] = [];
        let html = '';
        for (const [k, site] of sites.slice(0, 16).entries()) {
          const fn = this.entities.get(site.fn);
          const file = fn?.def?.file ?? fn?.decl?.file;
          html += `<div class="mu-site"><span class="flag ${site.write ? 'mu-w' : 'mu-r'}">${esc(t(site.write ? 'writes' : 'reads'))}</span> <a data-entity="${esc(site.fn)}">${esc(this.nameOf(site.fn))}</a>`;
          if (file && this.settings?.host !== false) {
            html += `<div class="code-slot" data-slot="mu${k}"><span class="q">…</span></div>`;
            asks.push({ slot: `mu${k}`, ask: { file, line: site.lines[0], what: 'stmt' } });
          } else if (file) html += ` ${this.locLink(file, site.lines[0])}`;
          if (site.lines.length > 1) html += `<div class="row q">${site.lines.slice(1).map((l) => (file ? this.locLink(file, l) : String(l))).join(' · ')}</div>`;
          html += '</div>';
        }
        if (sites.length > 16) html += `<div class="row q">${esc(t('moreSites', { n: sites.length - 16 }))}</div>`;
        list.innerHTML = html;
        for (const a of list.querySelectorAll<HTMLElement>('[data-entity]')) a.onclick = () => this.revealEntity(a.dataset.entity!);
        for (const a of list.querySelectorAll<HTMLElement>('[data-open]')) a.onclick = () => this.openLoc(a.dataset.open!, Number(a.dataset.line));
        if (asks.length) this.askCode(node, asks, false);
        // light the blocks that read (blue) and write (orange) it
        const reads = new Set<string>();
        const writes = new Set<string>();
        for (const site of sites) {
          const b = this.proj?.repOf(site.fn);
          if (b && b !== node) (site.write ? writes : reads).add(b);
        }
        for (const b of writes) reads.delete(b);
        const nodes = new Set<string>([node, ...this.ancestorsVisible(node)]);
        for (const b of [...reads, ...writes]) for (const a of this.ancestorsVisible(b)) nodes.add(a);
        this.renderer.highlight({ node, nodes, edges: new Set(), reads, writes });
        this.flow.setFocus(new Set());
      };
    }
  }

  /** Ask the host for the code of these slots; the answer fills them if the panel still shows `node`. */
  private askCode(node: string, asks: CodeSlot[], fresh = true): void {
    const req = ++this.codeReq;
    if (fresh) this.codeAsked.clear(); // a new panel: earlier answers have nowhere to go
    this.codeAsked.set(req, { node, slots: asks.map((a) => ({ slot: a.slot, file: a.ask.file })) });
    api.postMessage({ type: 'code', req, items: asks.map((a) => a.ask) });
  }

  private gotCode(req: number, items: (CodeSnip[] | null)[]): void {
    const asked = this.codeAsked.get(req);
    this.codeAsked.delete(req);
    if (!asked || this.details.hidden) return;
    asked.slots.forEach(({ slot, file }, i) => {
      const el = this.details.querySelector<HTMLElement>(`.code-slot[data-slot="${slot}"]`);
      if (!el) return;
      const snips = items[i];
      if (slot === 'sig' || slot === 'mem') {
        // coloured in place, no line numbers
        if (snips?.[0]?.html) el.innerHTML = snips[0].html.map((h, k) => h || esc(snips[0].lines[k])).join('\n');
        return;
      }
      if (!snips) el.innerHTML = '';
      else if (!snips.length) el.innerHTML = slot === 'ret' ? `<div class="row q">${esc(t('noReturn'))}</div>` : '';
      else el.innerHTML = snips.map((s) => this.snipHtml(file, s)).join('');
      for (const a of el.querySelectorAll<HTMLElement>('[data-open]')) a.onclick = () => this.openLoc(a.dataset.open!, Number(a.dataset.line));
    });
  }

  /** A snippet as code with line numbers, in the editor's colours; clicking it opens it. */
  private snipHtml(file: string, s: CodeSnip): string {
    const rows = s.lines.map((l, i) => `<span class="ln">${s.first + i}</span>${s.html?.[i] || esc(l) || ' '}`);
    return `<pre class="snip" data-open="${esc(file)}" data-line="${s.first}">${rows.join('\n')}</pre>`;
  }

  private isInside(nid: string, container: string): boolean {
    for (let c: string | null = nid; c; c = this.proj?.nodes.get(c)?.parent ?? null) if (c === container) return true;
    return false;
  }

  /** `asks`: also show the whole statement of each first call site (filled in when the host answers). */
  private relList(title: string, rels: Relation[], end: 'from' | 'to', asks?: CodeSlot[]): string {
    if (!rels.length) return '';
    const sorted = [...rels].sort((a, b) => b.count - a.count).slice(0, 60);
    const items = sorted
      .map((r, k) => {
        const other = r[end];
        const args = r.sites?.[0]?.args;
        const site = r.sites?.[0];
        let code = '';
        if (asks && site && k < 15) {
          const slot = 's' + asks.length;
          asks.push({ slot, ask: { file: site.file, line: site.line, what: 'stmt' } });
          code = `<div class="code-slot" data-slot="${slot}"></div>`;
        }
        return (
          `<li class="conf-${r.conf}"><span class="dot" style="background:var(--cc-${r.kind})" title="${esc(t(r.kind))}"></span>` +
          `<a data-entity="${esc(other)}">${esc(KIND_ICON[r.kind])} ${esc(this.nameOf(other))}</a><span class="cnt">${r.count > 1 ? '×' + r.count : ''} ${esc(t(r.conf))}</span>` +
          (args || site ? `<span class="args">${args ? esc('(' + args.join(', ') + ')') + ' ' : ''}${site ? this.locLink(site.file, site.line) : ''}</span>` : '') +
          code +
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
    for (const a of d.querySelectorAll<HTMLElement>('[data-follow]')) a.onclick = () => this.setFollow(a.dataset.follow!);
    for (const a of d.querySelectorAll<HTMLElement>('[data-span]')) a.onclick = () => this.seek(this.trace!.tr.spans.t[Number(a.dataset.span)]);
    for (const a of d.querySelectorAll<HTMLElement>('[data-th]')) a.onclick = () => this.setSolo(Number(a.dataset.th) === this.soloThread ? null : Number(a.dataset.th));
    if (nodeId && tn) {
      d.querySelector<HTMLElement>('[data-act=open]')?.addEventListener('click', () => tn.loc && this.openLoc(tn.loc.file, tn.loc.line));
      d.querySelector<HTMLElement>('[data-act=focus]')?.addEventListener('click', () => this.setFocus({ id: nodeId, hops: 1 }));
      d.querySelector<HTMLElement>('[data-act=toggle]')?.addEventListener('click', () => this.toggle(nodeId));
    }
  }

  // -------------------------------------------------------------------------
  // runtime trace: replay, threads, data tracking
  // -------------------------------------------------------------------------

  private clearTraceState(): void {
    this.stopPlay();
    this.timeline?.el.remove();
    this.timeline = undefined;
    this.trace = undefined;
    this.rtmap = undefined;
    this.follow = null;
    this.soloThread = null;
    this.procThreads = null;
    this.live = [];
    this.replay.t = 0;
  }

  private setTrace(tr: RunTrace | null, notes: string[]): void {
    if (tr) this.endLive();
    this.clearTraceState();
    this.traceNotes = notes;
    if (tr) {
      this.trace = new TraceModel(tr);
      this.timeline = new Timeline(this.trace, {
        seek: (x) => this.seek(x),
        togglePlay: () => this.togglePlay(),
        step: (d) => this.step(d),
        setSpeed: (x) => {
          this.replay.speed = x;
          this.timeline?.setSpeed(x);
          this.shareReplay();
        },
        selectSpan: (sp) => this.selectSpan(sp),
        soloThread: (th) => this.setSolo(th, false),
        close: () => {
          this.setTrace(null, []);
          if (this.settings?.host !== false) api.postMessage({ type: 'clearTrace' });
        },
        fnName: (f) => this.fnName(f),
        t: (k, v) => t(k as never, v),
      });
      this.root.insertBefore(this.timeline.el, this.status);
      this.timeline.setTime(0);
    }
    if (tr?.procs && tr.procs.length > 1) {
      this.ensureProcBar().update(traceCards(tr, this.trace!));
      this.procBar!.select(this.procSel);
      this.procThreads = this.procSel.size ? new Set(tr.procs.filter((p) => this.procSel.has(p.name)).flatMap((p) => p.threads)) : null;
      this.timeline?.setLanes(this.procThreads);
    } else if (!this.liveBar) this.dropProcBar();
    if (this.staticGraph) this.graph = tr ? augmentGraph(this.staticGraph, tr) : this.staticGraph;
    this.typeIndex = undefined;
    this.memberIndex = undefined;
    this.buildToolbar();
    this.buildLegend();
    // the dock takes room from the stage: fit the circuit again
    this.fitPending = true;
    void this.refresh();
  }

  private fnName(f: number): string {
    const fn = this.trace?.tr.fns[f];
    if (!fn) return '?';
    return (fn.id && this.entities.get(fn.id)?.qname) || fn.name;
  }

  /** Trace functions shown by a visible block. */
  private fnsOfNode(id: string): Set<number> {
    const out = new Set<number>();
    this.rtmap?.fnNode.forEach((n, f) => {
      if (n === id) out.add(f);
    });
    return out;
  }

  private togglePlay(): void {
    if (this.replay.playing) this.stopPlay();
    else this.startPlay();
  }

  private startPlay(): void {
    if (!this.trace) return;
    if (this.replay.t >= this.trace.duration) this.replay.t = 0;
    this.replay.playing = true;
    this.replay.wall = performance.now();
    this.flow.setMode('off');
    this.timeline?.setPlaying(true);
    this.replay.raf = requestAnimationFrame(this.tick);
    this.shareReplay();
  }

  private stopPlay(): void {
    cancelAnimationFrame(this.replay.raf);
    if (!this.replay.playing) return;
    this.replay.playing = false;
    this.timeline?.setPlaying(false);
    this.flow.setMode(this.state.flow);
    this.shareReplay();
  }

  /**
   * A run in progress: each thread's blocks light up in its colour (where it is right now), calls since
   * the last update pulse along their wires, busy functions show how many calls they just took.
   */
  private applyLive(u: LiveUpdate): void {
    if (!this.liveBar) {
      if (this.trace) this.setTrace(null, []);
      this.stopPlay();
      this.flow.setMode('off');
      // built once (updates only change its text: a click on Stop must not land on a replaced button);
      // Stop first, since notifications cover the right end of the panel
      this.liveBar = h('div', { class: 'timeline ui live-bar', title: t('liveHint') });
      this.liveBar.innerHTML =
        `<div class="tl-head"><span class="live-dot"></span><b>${esc(t('live'))}</b>` +
        (this.settings?.host !== false ? `<button class="btn stop" title="${esc(t('stopHint'))}">■ ${esc(t('stopRun'))}</button>` : '') +
        `<span class="tl-time mono"></span><span class="flag live-calls"></span><span class="tl-threads"></span></div>`;
      this.liveBar.querySelector<HTMLElement>('.stop')?.addEventListener('click', () => api.postMessage({ type: 'stopRun' }));
      // a thread chip follows that thread in the circuit (again: all)
      this.liveBar.querySelector<HTMLElement>('.tl-threads')!.addEventListener('click', (e) => {
        const chip = (e.target as Element).closest<HTMLElement>('[data-th]');
        if (chip) this.setLiveSolo(Number(chip.dataset.th) === this.liveSolo ? null : Number(chip.dataset.th));
      });
      this.liveLanes = new LiveLanes({
        nameOf: (id) => this.graph?.entities.find((e) => e.id === id)?.qname ?? id,
        soloThread: (th) => this.setLiveSolo(th),
        t: (k, v) => t(k as never, v),
      });
      this.liveBar.querySelector('.tl-head')!.append(this.liveLanes.nowButton);
      this.liveBar.append(this.liveLanes.el);
      this.liveThreads = '';
      this.root.insertBefore(this.liveBar, this.status);
    }
    const prev = this.lastLive;
    this.lastLive = u;
    if (u.procs && u.procs.length > 1) {
      this.ensureProcBar().update(this.liveCards(u, prev));
      this.procBar!.select(this.procSel);
    }
    this.procThreads = this.procSel.size ? new Set(u.threads.filter((x) => x.proc && this.procSel.has(x.proc)).map((x) => x.id)) : null;
    this.liveLanes?.setFilter(this.procThreads);
    this.liveLanes?.push(u);
    this.liveBar.querySelector<HTMLElement>('.tl-time')!.textContent = `${(u.elapsedMs / 1000).toFixed(1)} s`;
    this.liveBar.querySelector<HTMLElement>('.live-calls')!.textContent = t('liveCalls', { n: u.calls.toLocaleString() });
    this.applyLiveHead(u);
    this.paintLive(u, true);
  }

  /**
   * What a live update shows on the circuit: where the shown threads are, and (`fresh`) the calls since the last
   * update along their wires and on the busiest blocks. With a container or a thread chosen, only theirs; what they
   * lit stays lit and the rest is dimmed.
   */
  private paintLive(u: LiveUpdate, fresh: boolean): void {
    const proj = this.proj;
    if (!proj) return;
    const shows = (th: number) => (this.liveSolo === null || th === this.liveSolo) && (!this.procThreads || this.procThreads.has(th));
    const procOk = (p?: string) => !this.procSel.size || !p || this.procSel.has(p);
    const solo = this.liveSolo;
    if (solo !== null) for (const st of u.stacks) if (st.th === solo) for (const f of st.fns) this.liveSoloPath.add(f);
    const onPath = (a: string, b: string) => solo === null || this.liveSoloPath.has(a) || this.liveSoloPath.has(b);
    const focused = solo !== null || this.procSel.size > 0;
    // where every thread is: its stack, innermost first
    const active = new Map<string, { color: string; top: boolean }>();
    const owner = new Map<string, number>();
    for (const st of u.stacks) {
      if (!shows(st.th)) continue;
      const color = threadColor(st.th);
      let top = true;
      for (let i = st.fns.length - 1; i >= 0; i--) {
        const node = proj.repOf(st.fns[i]);
        if (!node) continue;
        if (top) owner.set(st.fns[i], st.th);
        if (!active.has(node)) active.set(node, { color, top });
        top = false;
      }
    }
    this.renderer.setActive(active);
    if (focused) for (const n of active.keys()) this.liveLit.nodes.add(n);
    if (!fresh) {
      this.paintLiveFocus(focused);
      return;
    }
    // calls since the last update, along their wires
    if (this.liveEnds?.proj !== proj) {
      const map = new Map<string, string>();
      for (const e of proj.edges) if (!map.has(e.src + '\u0001' + e.dst) || e.kind === 'call') map.set(e.src + '\u0001' + e.dst, e.id);
      this.liveEnds = { proj, map };
    }
    const pal = readPalette();
    let fired = 0;
    for (const [a, b, , p] of u.edges) {
      if (fired >= 40 || !a || !procOk(p) || !onPath(a, b)) continue;
      const na = proj.repOf(a);
      const nb = proj.repOf(b);
      const edge = na && nb && na !== nb ? this.liveEnds.map.get(na + '\u0001' + nb) : undefined;
      if (!edge) continue;
      if (focused) this.liveLit.edges.add(edge);
      const th = owner.get(b) ?? owner.get(a);
      this.flow.pulse(edge, th !== undefined ? threadColor(th) : pal.call, false, 600);
      fired++;
    }
    // the busiest functions of the last moment
    const now = performance.now();
    const labelled = new Set(this.live.filter((x) => now - x.born < 900).map((x) => x.node));
    for (const [e, n] of u.hot.filter(([e, , p]) => procOk(p) && (solo === null || this.liveSoloPath.has(e))).slice(0, 5)) {
      const node = proj.repOf(e);
      if (!node || labelled.has(node)) continue;
      labelled.add(node);
      const th = owner.get(e);
      this.live.push({ node, text: `+${n.toLocaleString()}`, color: th !== undefined ? threadColor(th) : pal.call, born: now, up: true });
    }
    const life = 1500;
    this.live = this.live.filter((x) => now - x.born < life).slice(-30);
    this.renderer.liveLabels(
      this.live.map((x) => ({ node: x.node, text: x.text, color: x.color, age: (now - x.born) / life, up: x.up })),
      this.measure,
    );
    this.paintLiveFocus(focused);
  }

  private paintLiveFocus(focused: boolean): void {
    if (!focused) {
      this.renderer.highlight(null);
      return;
    }
    const nodes = new Set(this.liveLit.nodes);
    for (const n of [...nodes]) for (const a of this.ancestorsVisible(n)) nodes.add(a);
    this.renderer.highlight({ nodes, edges: this.liveLit.edges });
  }

  /** Live: follow one thread in the circuit (null: all of them). */
  private setLiveSolo(th: number | null): void {
    this.liveSolo = th;
    this.liveSoloPath = new Set();
    this.liveLit = { nodes: new Set(), edges: new Set() };
    this.liveLanes?.setSolo(th);
    if (!this.lastLive) return;
    this.applyLiveHead(this.lastLive); // chips show the new choice
    this.paintLive(this.lastLive, false);
  }

  /** The container cards, on the right of the circuit (made once, kept between live and replay). */
  private ensureProcBar(): ProcBar {
    if (!this.procBar) {
      this.procBar = new ProcBar({
        onSelect: (sel) => this.onProcSelect(sel),
        onOpen: this.settings?.host !== false ? (name) => api.postMessage({ type: 'splitTrace', proc: name }) : undefined,
        t: (k, v) => t(k as never, v),
      });
      this.stage.append(this.procBar.el);
    }
    return this.procBar;
  }

  private dropProcBar(): void {
    this.procBar?.el.remove();
    this.procBar = undefined;
  }

  /** Containers chosen: the circuit, the swimlanes and the replay show only theirs. */
  private onProcSelect(sel: ReadonlySet<string>): void {
    this.procSel = new Set(sel);
    this.liveLit = { nodes: new Set(), edges: new Set() };
    if (this.liveBar && this.lastLive) {
      const u = this.lastLive;
      this.procThreads = sel.size ? new Set(u.threads.filter((x) => x.proc && sel.has(x.proc)).map((x) => x.id)) : null;
      if (this.liveSolo !== null && this.procThreads && !this.procThreads.has(this.liveSolo)) this.setLiveSolo(null);
      this.liveLanes?.setFilter(this.procThreads);
      this.liveThreads = '';
      this.applyLiveHead(u);
      this.paintLive(u, false);
      return;
    }
    const tr = this.trace?.tr;
    if (!tr?.procs) return;
    this.procThreads = sel.size ? new Set(tr.procs.filter((p) => sel.has(p.name)).flatMap((p) => p.threads)) : null;
    if (this.soloThread !== null && this.procThreads && !this.procThreads.has(this.soloThread)) this.soloThread = null;
    this.timeline?.setLanes(this.procThreads);
    this.setSolo(this.soloThread, false);
  }

  /** The live bar's thread chips for the current choice. */
  private applyLiveHead(u: LiveUpdate): void {
    const procs = new Set(u.threads.map((x) => x.proc).filter(Boolean));
    const name = (x: LiveUpdate['threads'][number]) => (procs.size > 1 && x.proc ? `${x.proc} · ${x.name}` : x.name);
    const chips = u.threads
      .filter((x) => !this.procThreads || this.procThreads.has(x.id))
      .map(
        (x) =>
          `<button class="chip th${this.liveSolo === x.id ? ' on' : ''}" data-th="${x.id}" title="${esc(name(x))} — ${esc(t('liveThreadHint'))}"><i style="background:${threadColor(x.id)}"></i>${esc(name(x))}</button>`,
      )
      .join('');
    if (this.liveBar && chips !== this.liveThreads) {
      this.liveThreads = chips;
      this.liveBar.querySelector<HTMLElement>('.tl-threads')!.innerHTML = chips;
    }
  }

  /** Live container cards: calls per second from the calls since the previous update, and their recent history. */
  private liveCards(u: LiveUpdate, prev: LiveUpdate | undefined): ProcCard[] {
    const dt = prev ? Math.max(0.05, (u.elapsedMs - prev.elapsedMs) / 1000) : 0.25;
    return (u.procs ?? []).map((p) => {
      const spark = this.liveSpark.get(p.name) ?? [];
      spark.push(p.recent);
      if (spark.length > 40) spark.shift();
      this.liveSpark.set(p.name, spark);
      return {
        name: p.name,
        state: p.ended ? 'ok' : 'run',
        status: t(p.ended ? 'procEnded' : 'procRunning'),
        pid: p.pid,
        threads: p.threads,
        calls: p.calls,
        rate: p.ended ? 0 : p.recent / dt,
        spark,
        colors: u.threads.filter((x) => x.proc === p.name).map((x) => threadColor(x.id)),
      };
    });
  }

  private endLive(): void {
    if (!this.liveBar) return;
    this.liveBar.remove();
    this.liveBar = undefined;
    this.liveLanes = undefined;
    this.liveSolo = null;
    this.liveSoloPath = new Set();
    this.liveLit = { nodes: new Set(), edges: new Set() };
    this.lastLive = undefined;
    this.liveSpark.clear();
    this.procThreads = null;
    this.dropProcBar();
    this.live = [];
    this.renderer.setActive(new Map());
    this.renderer.highlight(null);
    this.renderer.liveLabels([], this.measure);
    this.flow.setMode(this.state.flow);
  }

  /** Views of one run (one per container) play together: tell the others where this one is. */
  private shareReplay(): void {
    if (this.syncing || !this.trace || this.settings?.host === false) return;
    api.postMessage({ type: 'replay', t: this.replay.t, playing: this.replay.playing, speed: this.replay.speed });
  }

  private followReplay(t: number, playing: boolean, speed: number): void {
    if (!this.trace) return;
    this.syncing = true;
    try {
      if (speed !== this.replay.speed) {
        this.replay.speed = speed;
        this.timeline?.setSpeed(speed);
      }
      this.seek(t);
      if (playing && !this.replay.playing) this.startPlay();
      else if (!playing && this.replay.playing) this.stopPlay();
    } finally {
      this.syncing = false;
    }
  }

  /** ns of program time per ms of replay: the whole run takes ~15 s at 1×. */
  private rate(): number {
    return ((this.trace?.duration ?? 1) / 15000) * this.replay.speed;
  }

  private tick = (now: number): void => {
    if (!this.replay.playing || !this.trace) return;
    const dt = Math.min(100, now - this.replay.wall);
    this.replay.wall = now;
    const t0 = this.replay.t;
    const t1 = Math.min(this.trace.duration, t0 + dt * this.rate());
    this.replay.t = t1;
    this.fire(t0, t1);
    this.applyReplay();
    this.timeline?.setTime(t1);
    if (t1 >= this.trace.duration) {
      this.stopPlay();
      return;
    }
    this.replay.raf = requestAnimationFrame(this.tick);
  };

  /** Calls / returns / exceptions in (t0, t1]: pulses on wires, values on blocks. */
  private fire(t0: number, t1: number): void {
    const m = this.trace;
    const rt = this.rtmap;
    if (!m || !rt) return;
    const tr = m.tr;
    const s = tr.spans;
    const now = performance.now();
    const starts = m.startedIn(t0, t1, 600).filter((i) => this.showsThread(s.th[i]));
    const readable = starts.length <= 6;
    const seen = new Set<string>();
    for (const i of starts) {
      const f = s.fn[i];
      const p = s.parent[i];
      let edge: string | undefined;
      if (p >= 0) edge = rt.edgeOf(s.fn[p], f);
      else {
        const th = tr.threads.find((x) => x.id === s.th[i]);
        if (th?.parent !== undefined) edge = rt.spawnEdge(th.parent, f, s.t[i]);
      }
      const color = threadColor(s.th[i]);
      if (edge && !seen.has(edge) && seen.size < 40) {
        seen.add(edge);
        this.flow.pulse(edge, color, false, readable ? 700 : 450);
      }
      if (readable) {
        const node = rt.fnNode[f];
        const txt = argsText(tr.args[i], tr.lang);
        if (node && txt) this.live.push({ node, text: txt, color, born: now });
      }
    }
    const ends = m.endedIn(t0, t1, 600).filter((i) => this.showsThread(s.th[i]));
    if (ends.length <= 6) {
      const ret = readPalette().ret;
      for (const i of ends) {
        const v = retText(tr.rets[i], tr.lang);
        if (!v) continue;
        const p = s.parent[i];
        const edge = p >= 0 ? rt.edgeOf(s.fn[p], s.fn[i]) : undefined;
        if (edge) this.flow.pulse(edge, ret, true, 650);
        const node = rt.fnNode[s.fn[i]];
        if (node) this.live.push({ node, text: '⟲ ' + v, color: ret, born: now, up: true });
      }
    }
    for (const x of tr.exceptions) {
      if (x.t <= t0 || x.t > t1 || x.fn < 0) continue;
      const node = rt.fnNode[x.fn];
      if (node) this.live.push({ node, text: `✕ ${x.type}`, color: '#ff4d5e', born: now });
    }
  }

  /** Blocks on the call stacks at the replay time glow in their thread's colour. */
  private applyReplay(): void {
    const m = this.trace;
    const rt = this.rtmap;
    if (!m || !rt) return;
    const s = m.tr.spans;
    const active = new Map<string, { color: string; top: boolean }>();
    const showStacks = this.replay.playing || this.replay.t > 0;
    if (showStacks) {
      for (const [th, span] of m.activeAt(this.replay.t)) {
        if (!this.showsThread(th)) continue;
        const color = threadColor(th);
        let top = true;
        for (let i = span; i >= 0; i = s.parent[i]) {
          const node = rt.fnNode[s.fn[i]];
          if (node && !active.has(node)) active.set(node, { color, top });
          top = false;
        }
      }
    }
    this.renderer.setActive(active);
    const now = performance.now();
    const life = 1500;
    this.live = this.live.filter((x) => now - x.born < life).slice(-30);
    this.renderer.liveLabels(
      this.live.map((x) => ({ node: x.node, text: x.text, color: x.color, age: (now - x.born) / life, up: x.up })),
      this.measure,
    );
  }

  private seek(t: number): void {
    if (!this.trace) return;
    this.replay.t = Math.max(0, Math.min(this.trace.duration, t));
    this.live = [];
    this.applyReplay();
    this.timeline?.setTime(this.replay.t);
    this.shareReplay();
  }

  /** Jump to the next / previous call (of the soloed thread) and show it. */
  private step(dir: 1 | -1): void {
    const m = this.trace;
    if (!m) return;
    this.stopPlay();
    const s = m.tr.spans;
    const ok = (i: number) => this.showsThread(s.th[i]);
    let target = -1;
    if (dir > 0) target = m.startedIn(this.replay.t, Infinity, 5000).find(ok) ?? -1;
    else {
      const list = m.startedIn(-1, this.replay.t - 1, Number.MAX_SAFE_INTEGER);
      for (let k = list.length - 1; k >= 0; k--)
        if (ok(list[k])) {
          target = list[k];
          break;
        }
    }
    if (target < 0) return;
    const tt = s.t[target];
    this.seek(tt);
    this.fire(tt - 1, tt);
    this.applyReplay();
    const node = this.rtmap?.fnNode[s.fn[target]];
    if (node) this.renderer.pulseNode(node);
    this.status.dataset.task = '';
    this.showNotice(`${this.fnName(s.fn[target])}${argsText(m.tr.args[target], m.tr.lang, 3) ? ' (' + argsText(m.tr.args[target], m.tr.lang, 3) + ')' : ''}`, 2500);
  }

  private selectSpan(span: number): void {
    const m = this.trace;
    if (!m) return;
    const f = m.tr.spans.fn[span];
    this.seek(m.tr.spans.t[span]);
    const id = m.tr.fns[f]?.id;
    if (id) this.revealEntity(id);
  }

  /** The replay shows this thread: the soloed one, or one of the chosen containers'. */
  private showsThread(th: number): boolean {
    return (this.soloThread === null || th === this.soloThread) && (this.procThreads === null || this.procThreads.has(th));
  }

  /** Show only one thread's work (or the chosen containers'): its blocks and wires lit, the others dimmed. */
  private setSolo(th: number | null, fromPanel = true): void {
    this.soloThread = th;
    const rt = this.rtmap;
    const ths = th !== null ? new Set([th]) : this.procThreads;
    if (!ths || !rt) {
      this.renderer.highlight(null);
      this.flow.setFocus(null);
    } else {
      const nodes = new Set<string>();
      const edges = new Set<string>();
      for (const [id, b] of rt.overlay.blocks) if (b.threads.some((x) => ths.has(x))) nodes.add(id);
      for (const [id, w] of rt.overlay.wires) if (w.threads.some((x) => ths.has(x))) edges.add(id);
      for (const n of [...nodes]) for (const a of this.ancestorsVisible(n)) nodes.add(a);
      this.renderer.highlight({ nodes, edges });
      this.flow.setFocus(edges);
    }
    this.applyReplay();
    if (fromPanel) this.showTraceSummary();
  }

  /** Data tracking: light up every block an object passed through, in order. */
  private setFollow(id: string | null): void {
    this.follow = id;
    const m = this.trace;
    const rt = this.rtmap;
    if (!id || !m || !rt) {
      this.timeline?.setMarks([]);
      this.renderer.highlight(null);
      this.flow.setFocus(null);
      return;
    }
    const s = m.tr.spans;
    const sights = m.sightings(id);
    const nodes = new Set<string>();
    const edges = new Set<string>();
    let prev = -1;
    for (const x of sights) {
      const f = s.fn[x.span];
      const node = rt.fnNode[f];
      if (node) nodes.add(node);
      if (prev >= 0) {
        const e = rt.edgeOf(prev, f) ?? rt.edgeOf(f, prev);
        if (e) edges.add(e);
      }
      prev = f;
    }
    for (const n of [...nodes]) for (const a of this.ancestorsVisible(n)) nodes.add(a);
    this.renderer.highlight({ nodes, edges });
    this.flow.setFocus(edges);
    this.timeline?.setMarks(sights.map((x) => ({ t: s.t[x.span], th: s.th[x.span] })));
    const obj = m.tr.objects.find((o) => o.id === id);
    const threads = [...new Set(sights.map((x) => s.th[x.span]))];
    let html = `<h2><span class="pill" style="--k:var(--cc-ret)">◆</span>${esc(t('dataTrail'))}<button class="close">✕</button></h2>`;
    html += `<div class="qn">${esc(obj?.label ?? '')} ${esc(id)}</div>`;
    html += `<div class="row">${threads.map((th) => this.threadChip(th)).join('')}<span class="flag">${esc(t('sightings', { n: sights.length }))}</span></div>`;
    if (threads.length > 1) html += `<div class="row"><span class="flag warn">⚠ ${esc(t('sharedAcross', { n: threads.length }))}</span></div>`;
    // where it went: per function, with the threads that handled it there
    const byFn = new Map<number, { n: number; th: Set<number>; first: number; roles: Set<string> }>();
    for (const x of sights) {
      const f = s.fn[x.span];
      const e = byFn.get(f) ?? byFn.set(f, { n: 0, th: new Set(), first: x.span, roles: new Set() }).get(f)!;
      e.n++;
      e.th.add(s.th[x.span]);
      e.roles.add(x.role === 'ret' ? t('returned') : x.role === 'self' ? 'self' : x.name ?? 'arg');
    }
    html += `<h3>${esc(t('passedThrough'))} (${byFn.size})</h3><ul class="lst">`;
    for (const [f, e] of [...byFn].sort((a, b) => s.t[a[1].first] - s.t[b[1].first])) {
      html +=
        `<li><span class="dot" style="background:${threadColor(s.th[e.first])}"></span><a data-entity="${esc(m.tr.fns[f]?.id ?? '')}">${esc(this.fnName(f))}</a>` +
        `<span class="cnt">×${e.n} ${[...e.th].map((th) => `<span style="color:${threadColor(th)}">●</span>`).join('')}</span>` +
        `<span class="args">${esc([...e.roles].join(', '))} · <a data-span="${e.first}">${fmtNs(s.t[e.first])}</a></span></li>`;
    }
    html += '</ul>';
    // the first hand-overs, in time order
    html += `<h3>${esc(t('firstSteps'))}</h3><ul class="lst">`;
    const rows: { x: (typeof sights)[number]; n: number }[] = [];
    for (const x of sights) {
      const last = rows[rows.length - 1];
      if (last && s.fn[last.x.span] === s.fn[x.span] && s.th[last.x.span] === s.th[x.span] && last.x.role === x.role) last.n++;
      else rows.push({ x, n: 1 });
    }
    for (const { x, n } of rows.slice(0, 16)) {
      const f = s.fn[x.span];
      const role = x.role === 'ret' ? t('returned') : x.role === 'self' ? 'self' : x.name ?? 'arg';
      html +=
        `<li><span class="dot" style="background:${threadColor(s.th[x.span])}"></span><a data-entity="${esc(m.tr.fns[f]?.id ?? '')}">${esc(this.fnName(f))}</a>` +
        `<span class="cnt">${esc(role)}${n > 1 ? ' ×' + n : ''}</span><span class="args"><a data-span="${x.span}">${fmtNs(s.t[x.span])}</a></span></li>`;
    }
    html += '</ul>';
    this.details.innerHTML = html;
    this.details.hidden = false;
    this.wireDetails(null);
  }

  private threadChip(th: number): string {
    const name = this.trace?.tr.threads.find((x) => x.id === th)?.name ?? `thread ${th}`;
    return `<a class="chip th${this.soloThread === th ? ' on' : ''}" data-th="${th}"><i style="background:${threadColor(th)}"></i>${esc(name)}</a>`;
  }

  /** Details panel: what this block did at runtime. */
  private runtimeSection(n: PNode): string {
    const m = this.trace;
    if (!m || !this.rtmap) return '';
    const fns = [...this.fnsOfNode(n.id)];
    const inside = n.container || n.t.children.length > 0;
    if (!fns.length) return inside ? '' : `<h3>◉ ${esc(t('runTitle'))}</h3><div class="row q">○ ${esc(t('notExecuted'))}</div>`;
    const tr = m.tr;
    const s = tr.spans;
    let calls = 0;
    let ns = 0;
    const threads = new Set<number>();
    for (const f of fns) {
      calls += m.stats[f].n;
      ns += m.stats[f].ns;
      for (const th of m.stats[f].threads) threads.add(th);
    }
    let html = `<h3>◉ ${esc(t('runTitle'))}</h3>`;
    html += `<div class="row"><span class="flag">×${calls}</span><span class="flag">${fmtNs(ns)}</span>${[...threads].map((th) => this.threadChip(th)).join('')}</div>`;
    if (threads.size > 1) html += `<div class="row"><span class="flag thread">⚡ ${esc(t('ranOnThreads', { n: threads.size }))}</span></div>`;
    const main = fns.sort((a, b) => m.stats[b].n - m.stats[a].n)[0];
    const recent = m.recentCalls(main, 8);
    if (recent.length) {
      html += `<h3>${esc(t('recentCalls'))}</h3><ul class="lst">`;
      for (const i of recent) {
        const args = (tr.args[i] ?? []).filter((a) => a[0] !== 'self');
        const argHtml = args
          .slice(0, 4)
          .map((a) => {
            const v = esc(valText(a[1], a[2], tr.lang, 28));
            return `${esc(a[0])}=${a[3] && (a[1] === 'o' || a[1] === 'c') ? `<a data-follow="${esc(a[3])}">${v}</a>` : v}`;
          })
          .join(', ');
        const rv = tr.rets[i];
        const ret = rv && rv[0] !== 'n' ? ` → ${rv[2] && (rv[0] === 'o' || rv[0] === 'c') ? `<a data-follow="${esc(rv[2])}">${esc(valText(rv[0], rv[1], tr.lang, 28))}</a>` : esc(valText(rv[0], rv[1], tr.lang, 28))}` : '';
        const self = tr.selfs[i];
        html +=
          `<li><span class="dot" style="background:${threadColor(s.th[i])}"></span><span class="mono">(${argHtml || ''})${ret}</span>` +
          `<span class="cnt"><a data-span="${i}">${fmtNs(s.t[i])}</a></span>` +
          (self ? `<span class="args">self <a data-follow="${esc(self)}">@${esc(self.slice(-6))}</a> · ${fmtNs(s.end[i] - s.t[i])}</span>` : `<span class="args">${fmtNs(s.end[i] - s.t[i])}</span>`) +
          `</li>`;
      }
      html += '</ul>';
    }
    const exc = tr.exceptions.filter((x) => fns.includes(x.fn));
    if (exc.length) {
      html += `<h3 class="bad">✕ ${esc(t('exceptions'))}</h3><ul class="lst">`;
      for (const x of exc.slice(0, 8))
        html += `<li><span class="dot" style="background:var(--cc-broken)"></span><span>${esc(x.type)}: ${esc(x.msg)}</span><span class="cnt">${fmtNs(x.t)}</span></li>`;
      html += '</ul>';
    }
    return html;
  }

  /** Run summary: exit, threads (who started whom), failures, data shared between threads. */
  showTraceSummary(): void {
    const m = this.trace;
    if (!m) return;
    const tr = m.tr;
    const ex = tr.exit;
    let html = `<h2><span class="pill" style="--k:var(--cc-call)">◉</span>${esc(t('runTitle'))}<button class="close">✕</button></h2>`;
    html += `<div class="qn">${esc(tr.command)}</div><div class="row">`;
    if (ex.crash && ex.crash !== 'SIGTERM') html += `<span class="flag bad">✕ ${esc(ex.crash)}</span>`;
    else if (ex.stopped) html += `<span class="flag warn">■ ${esc(t('stoppedByYou'))}</span>`;
    else if (ex.timedOut) html += `<span class="flag warn">⏱ ${esc(t('stopped'))}</span>`;
    else html += `<span class="flag ${ex.code ? 'bad' : ''}">${esc(ex.code ? t('exitCode', { n: ex.code }) : t('exitOk'))}</span>`;
    html += `<span class="flag">${fmtNs(tr.durationNs)}</span><span class="flag">${esc(t('callsN', { n: tr.spans.t.length }))}</span></div>`;
    if (this.settings?.host !== false) {
      const split = tr.procs && tr.procs.length > 1 ? `<button class="btn" data-act="split" title="${esc(t('splitHint'))}">⧉ ${esc(t('split'))}</button>` : '';
      html += `<div class="row"><button class="btn" data-act="rerun">▶ ${esc(t('runAgain'))}</button>${split}</div>`;
    }
    // processes (containers of a Compose run): how each ended, which threads are theirs
    if (tr.procs && tr.procs.length > 1) {
      html += `<h3>▣ ${esc(t('processes'))} (${tr.procs.length})</h3><ul class="lst">`;
      for (const p of tr.procs) {
        const x = p.exit;
        // a stop (time limit, Stop) ends a container with SIGTERM: 143, or -15 for a plain process
        const stopped = (x.timedOut || x.stopped) && (x.code === null || [143, 130, -15, -2].includes(x.code));
        const flag =
          x.crash && x.crash !== 'SIGTERM'
            ? `<span class="flag bad">✕ ${esc(x.crash)}</span>`
            : stopped
              ? `<span class="flag warn">${x.stopped ? `■ ${esc(t('stoppedByYou'))}` : `⏱ ${esc(t('stopped'))}`}</span>`
              : x.code === null
                ? ''
                : `<span class="flag ${x.code ? 'bad' : ''}">${esc(x.code ? t('exitCode', { n: x.code }) : t('exitOk'))}</span>`;
        const name = this.settings?.host !== false ? `<a data-proc="${esc(p.name)}" title="${esc(t('splitOne'))}">${esc(p.name)}</a>` : esc(p.name);
        html +=
          `<li><span class="dot" style="background:var(--cc-call)"></span><b>${name}</b>${flag}` +
          `<span class="cnt">${p.threads.map((id) => `<span style="color:${threadColor(id)}">●</span>`).join('')}</span>` +
          (p.pid !== undefined ? `<span class="args">pid ${p.pid}</span>` : '') +
          `</li>`;
      }
      html += '</ul>';
    }
    // thread tree
    html += `<h3>⚡ ${esc(t('threads'))} (${tr.threads.length})</h3><ul class="lst">`;
    const kids = new Map<number, number[]>();
    for (const th of tr.threads) if (th.parent !== undefined) (kids.get(th.parent) ?? kids.set(th.parent, []).get(th.parent)!).push(th.id);
    const roots = tr.threads.filter((th) => th.parent === undefined || !tr.threads.some((x) => x.id === th.parent));
    const callsOf = new Map<number, number>();
    for (const th of s_th(tr)) callsOf.set(th, (callsOf.get(th) ?? 0) + 1);
    const row = (id: number, depth: number): string => {
      const th = tr.threads.find((x) => x.id === id)!;
      const entry = th.entry !== undefined ? this.fnName(th.entry) : '';
      let r =
        `<li><span class="dot" style="background:${threadColor(id)}"></span><span style="padding-left:${depth * 12}px">${depth ? '↳ ' : ''}${this.threadChip(id)}</span>` +
        `<span class="cnt">×${callsOf.get(id) ?? 0}</span>` +
        (entry ? `<span class="args">${esc(t('startsIn'))} <a data-entity="${esc(tr.fns[th.entry!]?.id ?? '')}">${esc(entry)}</a> · ${fmtNs((th.end ?? tr.durationNs) - th.start)}</span>` : '') +
        `</li>`;
      for (const k of kids.get(id) ?? []) r += row(k, depth + 1);
      return r;
    };
    html += roots.map((r) => row(r.id, 0)).join('') + '</ul>';
    // failures
    const fails = tr.exceptions.filter((x) => x.uncaught || tr.lang !== 'python');
    if (fails.length) {
      html += `<h3 class="bad">✕ ${esc(t('exceptions'))}</h3><ul class="lst">`;
      for (const x of fails.slice(0, 12)) {
        const where = x.fn >= 0 ? `<a data-entity="${esc(tr.fns[x.fn]?.id ?? '')}">${esc(this.fnName(x.fn))}</a>` : esc(x.file ?? '');
        const path = (x.frames ?? []).map(([f]) => this.fnName(f).split(/::|\./).pop()).join(' → ');
        html +=
          `<li><span class="dot" style="background:var(--cc-broken)"></span><span><b>${esc(x.type)}</b>: ${esc(x.msg)}</span><span class="cnt"><a data-span-t="${x.t}">${fmtNs(x.t)}</a></span>` +
          `<span class="args">${where}${path ? ' · ' + esc(path) : ''}</span></li>`;
      }
      html += '</ul>';
    }
    // shared data
    const shared = tr.objects.filter((o) => o.threads.length > 1);
    const travel = tr.objects.filter((o) => o.threads.length <= 1);
    const objList = (list: typeof tr.objects) =>
      list
        .slice(0, 16)
        .map(
          (o) =>
            `<li><span class="dot" style="background:var(--cc-ret)"></span><a data-follow="${esc(o.id)}">◆ ${esc(o.label.length > 30 ? o.label.slice(0, 29) + '…' : o.label)}</a>` +
            `<span class="cnt">${o.threads.map((th) => `<span style="color:${threadColor(th)}">●</span>`).join('')}</span>` +
            `<span class="args">${esc(o.fns.slice(0, 4).map((f) => this.fnName(f).split(/::|\./).pop()).join(' → '))}${o.fns.length > 4 ? ' …' : ''} · ×${o.n}</span></li>`,
        )
        .join('');
    if (shared.length) html += `<h3>◆ ${esc(t('sharedData'))} (${shared.length})</h3><div class="row q">${esc(t('sharedHint'))}</div><ul class="lst">${objList(shared)}</ul>`;
    if (travel.length) html += `<h3>◆ ${esc(t('dataFlow'))} (${travel.length})</h3><ul class="lst">${objList(travel)}</ul>`;
    const notes = [...this.traceNotes, ...(tr.truncated ? [t('traceCapped', { n: tr.events })] : [])];
    if (notes.length) html += `<h3>${esc(t('notes'))}</h3>${notes.map((x) => `<div class="row q">${esc(x)}</div>`).join('')}`;
    if (tr.output.trim()) html += `<h3>${esc(t('output'))}</h3><pre class="sig out">${esc(tr.output.slice(-3000))}</pre>`;
    this.details.innerHTML = html;
    this.details.hidden = false;
    this.wireDetails(null);
    this.details.querySelector<HTMLElement>('[data-act=rerun]')?.addEventListener('click', () => api.postMessage({ type: 'runTrace', compose: !!tr.procs || !!this.traceScope }));
    this.details.querySelector<HTMLElement>('[data-act=split]')?.addEventListener('click', () => api.postMessage({ type: 'splitTrace' }));
    for (const a of this.details.querySelectorAll<HTMLElement>('[data-proc]')) a.onclick = () => api.postMessage({ type: 'splitTrace', proc: a.dataset.proc });
    for (const a of this.details.querySelectorAll<HTMLElement>('[data-span-t]')) a.onclick = () => this.seek(Number(a.dataset.spanT));
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
    this.lastHover = ev;
    const target = ev.target as Element;
    // buttons and badges explain themselves; an open block's body is background
    const quiet = !!target?.closest?.('[data-act]') || target?.classList?.contains('zb');
    const el = quiet ? null : target?.closest?.('[data-id]');
    if (!el || !this.proj) {
      this.tooltip.hidden = true;
      this.wantPeek(null);
      this.peekShown = '';
      this.tip.id = '';
      return;
    }
    const id = el.getAttribute('data-id')!;
    const src = this.sourceOf(id, el.hasAttribute('data-edge'));
    let html = '';
    if (el.hasAttribute('data-edge')) {
      const e = this.proj.edges.find((x) => x.id === id);
      if (!e) return;
      const a = this.proj.nodes.get(e.src)!.t.label;
      const b = this.proj.nodes.get(e.dst)!.t.label;
      html = `<b>${esc(KIND_ICON[e.kind])} ${esc(a)} → ${esc(b)}</b> <span class="mono">×${e.count} · ${esc(t(e.conf))}</span><div class="mono">${esc(this.wireText(e, 200))}</div>`;
    } else {
      const n = this.proj.nodes.get(id);
      if (!n) return;
      const e = n.t.entity;
      const sig = signature(n);
      html = `<b>${esc(e?.qname ?? n.t.file?.path ?? n.t.label)}</b>${sig ? `<div class="mono">${esc(sig)}</div>` : ''}`;
      if (n.t.loc) html += `<div class="mono">${esc(n.t.loc.file)}:${n.t.loc.line}</div>`;
      const rb = this.rtmap?.overlay.blocks.get(id);
      if (rb) html += `<div class="mono">◉ ×${rb.n} · ${rb.threads.map((th) => `<span style="color:${threadColor(th)}">●</span>`).join('')}</div>`;
      else if (this.trace && !n.container) html += `<div class="mono q">○ ${esc(t('notExecuted'))}</div>`;
      const st = this.overlay?.blocks.get(id);
      if (st?.state === 'broken' && st.diags[0]) html += `<div class="tip-bad">✕ ${esc(st.diags[0].message)}</div>`;
      else if (st?.state === 'affected') html += `<div class="tip-warn">⚠ ${esc(t('dependsOn'))} +${st.dist}</div>`;
      else if (st?.state === 'unpowered') html += `<div class="mono">○ ${esc(t('legendUnpowered'))}</div>`;
    }
    const peek = this.peekHtml(src);
    html += peek;
    const r = this.stage.getBoundingClientRect();
    // same element: the tooltip stays where it appeared; it only changes when its content does (colours arriving)
    const same = id === this.tip.id && !this.tooltip.hidden;
    if (same && html === this.tip.html) return;
    if (!same) this.tip = { id, html, x: ev.clientX - r.left, y: ev.clientY - r.top };
    this.tip.html = html;
    this.tooltip.classList.toggle('wide', !!peek);
    this.tooltip.innerHTML = html;
    this.tooltip.hidden = false;
    // measure at the top-left corner, where nothing squeezes it: its width no longer depends on where it was
    this.tooltip.style.left = '0px';
    this.tooltip.style.top = '0px';
    const w = this.tooltip.offsetWidth;
    const h = this.tooltip.offsetHeight;
    const { x: px, y: py } = this.tip;
    // right of and below the pointer; left of / above it when there is no room
    let x = px + 14;
    if (x + w > r.width - 8) x = px - w - 14 >= 4 ? px - w - 14 : r.width - w - 8;
    let y = py + 16;
    if (y + h > r.height - 8) y = py - h - 12 >= 4 ? py - h - 12 : r.height - h - 8;
    this.tooltip.style.left = `${Math.max(4, x)}px`;
    this.tooltip.style.top = `${Math.max(4, y)}px`;
  }

  /** Where Ctrl/Cmd+click and F12 go: a block's definition, or the line of a wire's (first) call. */
  private sourceOf(id: string, edge: boolean): { file: string; line: number; endLine?: number; site: boolean } | undefined {
    if (edge) {
      const e = this.proj?.edges.find((x) => x.id === id);
      const site = e?.rels.find((r) => r.sites?.length)?.sites?.[0];
      return site ? { file: site.file, line: site.line, site: true } : undefined;
    }
    const loc = this.proj?.nodes.get(id)?.t.loc;
    return loc ? { file: loc.file, line: loc.line, endLine: loc.endLine, site: false } : undefined;
  }

  /** The source lines for the tooltip if the host already sent them; otherwise asked for after a short rest. */
  private peekHtml(src: ReturnType<App['sourceOf']>): string {
    this.peekShown = '';
    if (!src || this.settings?.host === false) {
      this.wantPeek(null);
      return '';
    }
    const count = src.site ? 1 : 6;
    const key = `${src.file}:${src.line}:${count}`;
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
    const hint = `<div class="mono peek-hint">${esc(t(src.site ? 'peekSite' : 'peekOpen', { key: mod }))}</div>`;
    if (!this.peeks.has(key)) {
      this.wantPeek(key, () => api.postMessage({ type: 'peek', req: this.askPeek(key), file: src.file, line: src.line, endLine: src.endLine, count }));
      return hint;
    }
    this.wantPeek(null);
    const p = this.peeks.get(key);
    if (!p?.lines.length) return hint;
    this.peekShown = key;
    const rows = p.lines.map((l, i) => {
      const n = p.first + i;
      // html: the host's syntax colours, already escaped
      const row = `<span class="ln">${n}</span>${p.html?.[i] || esc(l) || ' '}`;
      return n === src.line ? `<span class="hd">${row}</span>` : row;
    });
    if (p.more && !src.site) rows.push('<span class="ln"> </span>…');
    return `<pre class="peek">${rows.join('\n')}</pre>${hint}`;
  }

  /** Ask the host for `key` once the pointer rests on it; null cancels. */
  private wantPeek(key: string | null, ask?: () => void): void {
    if (key === this.peekWant) return;
    clearTimeout(this.peekTimer);
    this.peekWant = key ?? '';
    if (key && ask) this.peekTimer = window.setTimeout(ask, 220);
  }

  private askPeek(key: string): number {
    const req = ++this.peekReq;
    this.peekAsked.set(req, key);
    return req;
  }

  /** `final`: the last answer to `req` (the host may first send plain lines, then the coloured ones). */
  private gotPeek(req: number, peek: Peek | null, final = true): void {
    const key = this.peekAsked.get(req);
    if (final) this.peekAsked.delete(req);
    if (key === undefined) return;
    if (this.peeks.size > 300) this.peeks.delete(this.peeks.keys().next().value!);
    this.peeks.set(key, peek);
    // still hovering what asked for it, or showing its plain lines: show it now
    if ((key === this.peekWant || key === this.peekShown) && !this.tooltip.hidden && this.lastHover) {
      this.peekWant = '';
      this.onHover(this.lastHover);
    }
  }

  private onKey(e: KeyboardEvent): void {
    const tag = (e.target as Element)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    if (this.trace && (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      if (e.key === ' ') this.togglePlay();
      else this.step(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (e.key === '/') {
      e.preventDefault();
      this.toolbar.querySelector<HTMLInputElement>('.search input')?.focus();
    } else if (e.key === 'Escape') {
      if (this.state.selected || this.selectedEdge) this.select(null);
      else if (this.state.focus) this.setFocus(null);
    } else if (e.key === 'f' || e.key === 'F') this.fit();
    else if (/^[1-9]$/.test(e.key)) {
      const l = this.levels()[Number(e.key) - 1];
      if (l) this.setLevel(l);
    }
    else if ((e.key === 'Enter' || e.key === 'F12') && (this.state.selected || this.selectedEdge)) {
      const src = this.selectedEdge ? this.sourceOf(this.selectedEdge, true) : this.sourceOf(this.state.selected!, false);
      if (src) {
        e.preventDefault();
        this.openLoc(src.file, src.line);
      }
    }
  }
}

const app = new App();
(window as unknown as { codeGraph: App }).codeGraph = app;
if (window.__CODE_GRAPH_DEMO__) {
  const d = window.__CODE_GRAPH_DEMO__;
  setTimeout(() => app.loadDemo(d.graph, d.settings, d.trace), 0);
}

/** The container cards of a replay: how each process ended, its threads and calls, and its calls over the run. */
function traceCards(tr: RunTrace, m: TraceModel): ProcCard[] {
  const BUCKETS = 40;
  const procOf = new Map<number, number>();
  tr.procs!.forEach((p, i) => p.threads.forEach((th) => procOf.set(th, i)));
  const calls = tr.procs!.map(() => 0);
  const spark = tr.procs!.map(() => new Array<number>(BUCKETS).fill(0));
  const dur = Math.max(1, m.duration);
  const s = tr.spans;
  for (let i = 0; i < s.t.length; i++) {
    const p = procOf.get(s.th[i]);
    if (p === undefined) continue;
    calls[p]++;
    spark[p][Math.min(BUCKETS - 1, Math.floor((s.t[i] / dur) * BUCKETS))]++;
  }
  return tr.procs!.map((p, i) => {
    const e = p.exit;
    const crash = e.crash && e.crash !== 'SIGTERM' && e.crash !== 'SIGINT' ? e.crash : undefined;
    const [state, status]: [ProcCard['state'], string] = crash
      ? ['bad', `✕ ${crash}`]
      : e.code
        ? ['bad', t('exitCode', { n: e.code })]
        : e.stopped
          ? ['stop', t('stoppedByYou')]
          : e.timedOut || e.signal
            ? ['stop', t('stopped')]
            : ['ok', t('exitOk')];
    return { name: p.name, state, status, pid: p.pid, threads: p.threads.length, calls: calls[i], spark: spark[i], colors: p.threads.map((th) => threadColor(th)) };
  });
}
