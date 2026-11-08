/** The "circuit" webview panel. */
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { peekLines, type Peek } from '../core/peek';
import { processTrace } from '../core/trace';
import type { HostMessage, LevelSetting, ViewSettings, WebviewMessage } from '../shared/protocol';
import type { AnalysisService } from './service';
import { currentTheme } from './theme';

export const VIEW_TYPE = 'codeGraph.circuit';
/** Views of one process (container) of a trace: not restored after a reload (no serializer). */
const SCOPED_VIEW_TYPE = 'codeGraph.circuitOfProcess';

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** What the editor has for a file (unsaved edits included), else what is on disk; nothing for huge files. */
async function sourceText(abs: string): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === abs);
  if (open) return open.getText();
  try {
    const st = await fs.promises.stat(abs);
    if (st.size > 4 * 1024 * 1024) return undefined;
    return await fs.promises.readFile(abs, 'utf8');
  } catch {
    return undefined;
  }
}

/** Syntax colours in the editor's theme; the preview stays plain when the theme or the grammar is not at hand. */
async function colour(peek: Peek, file: string): Promise<void> {
  try {
    // loaded on the first preview: the grammars are big and most sessions never hover
    const { highlightLines, langOf } = await import('../core/highlight');
    const lang = langOf(file);
    const theme = lang && currentTheme();
    if (lang && theme) peek.html = (await highlightLines(peek.lines, lang, theme)) ?? undefined;
  } catch {
    // plain text it is
  }
}

export function viewSettings(): ViewSettings {
  const c = vscode.workspace.getConfiguration('codeGraph');
  return {
    defaultLevel: c.get<LevelSetting>('defaultLevel', 'auto'),
    layout: c.get<'circuit' | 'network'>('layout', 'circuit'),
    flow: c.get<'all' | 'focus' | 'off'>('flow.mode', 'all'),
    maxParticles: c.get<number>('flow.maxParticles', 2500),
    showGuesses: c.get<boolean>('showGuessedLinks', true),
    lang: vscode.env.language,
    host: true,
    trusted: vscode.workspace.isTrusted,
  };
}

export type VerifyMode = 'onOpenAndSave' | 'onOpen' | 'manual';
export const verifyMode = (): VerifyMode => vscode.workspace.getConfiguration('codeGraph.verify').get<VerifyMode>('mode', 'onOpenAndSave');

export class CircuitPanel implements vscode.Disposable {
  static current?: CircuitPanel;
  /** One view per process (container) of the current trace, by process name. */
  static scoped = new Map<string, CircuitPanel>();
  /** Set for a view of one process: the trace it shows is that process's part of the current one. */
  private scope?: string;
  private disposables: vscode.Disposable[] = [];
  private ready = false;
  private queue: HostMessage[] = [];
  private pendingFocus?: string;
  private saved = new Set<string>();
  private verifyAbort?: AbortController;

  static show(ctx: vscode.ExtensionContext, service: AnalysisService, focusFile?: string): CircuitPanel {
    if (CircuitPanel.current) {
      CircuitPanel.current.panel.reveal(undefined, true);
    } else {
      const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'CodeGraph', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, CircuitPanel.options(ctx));
      CircuitPanel.current = new CircuitPanel(panel, ctx, service);
    }
    const p = CircuitPanel.current;
    if (focusFile) p.focusFile(focusFile);
    return p;
  }

  /** A view of one process (container) of the current trace, in `column`. */
  static showScoped(ctx: vscode.ExtensionContext, service: AnalysisService, name: string, column: vscode.ViewColumn): CircuitPanel {
    const open = CircuitPanel.scoped.get(name);
    if (open) {
      open.panel.reveal(column, true);
      return open;
    }
    const panel = vscode.window.createWebviewPanel(SCOPED_VIEW_TYPE, `CodeGraph · ${name}`, { viewColumn: column, preserveFocus: true }, CircuitPanel.options(ctx));
    const p = new CircuitPanel(panel, ctx, service, name);
    CircuitPanel.scoped.set(name, p);
    return p;
  }

  /** The current trace changed: the main view shows it, each process view its part (or closes). */
  static publishTrace(service: AnalysisService): void {
    const last = service.lastTrace;
    CircuitPanel.current?.post({ type: 'trace', trace: last?.trace ?? null, notes: last?.notes });
    for (const p of [...CircuitPanel.scoped.values()]) p.postScopedTrace();
  }

  private postScopedTrace(): void {
    const last = this.service.lastTrace;
    const part = last && this.service.graph ? processTrace(last.trace, this.scope!, this.service.graph) : undefined;
    if (!part) {
      this.panel.dispose();
      return;
    }
    this.post({ type: 'trace', trace: part, notes: last!.notes, scope: this.scope });
  }

  static revive(panel: vscode.WebviewPanel, ctx: vscode.ExtensionContext, service: AnalysisService): void {
    panel.webview.options = CircuitPanel.options(ctx);
    CircuitPanel.current = new CircuitPanel(panel, ctx, service);
  }

  private static options(ctx: vscode.ExtensionContext): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'webview')],
    };
  }

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private ctx: vscode.ExtensionContext,
    private service: AnalysisService,
    scope?: string,
  ) {
    this.scope = scope;
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.png');
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m)),
    );
  }

  dispose(): void {
    this.verifyAbort?.abort();
    if (CircuitPanel.current === this) CircuitPanel.current = undefined;
    if (this.scope && CircuitPanel.scoped.get(this.scope) === this) CircuitPanel.scoped.delete(this.scope);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  post(m: HostMessage): void {
    if (!this.ready) {
      // keep only the latest message of each kind while the webview boots
      const key = (x: HostMessage) =>
        x.type === 'diagnostics' ? 'diagnostics:' + x.set : x.type === 'task' ? 'task:' + x.task : x.type === 'live' ? 'live:' + x.state : x.type;
      this.queue = this.queue.filter((q) => key(q) !== key(m) || m.type === 'error');
      this.queue.push(m);
      return;
    }
    void this.panel.webview.postMessage(m);
  }

  /** Remember a saved file so the next refresh re-checks only the units it affects. */
  noteSaved(rel: string): void {
    this.saved.add(rel);
  }

  /** Compile-check everything (or `units`) and push the result to the webview. */
  async verify(units?: string[]): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      this.post({ type: 'task', task: 'verify', state: 'error', message: vscode.l10n.t('Compile checks are disabled in untrusted workspaces.') });
      return;
    }
    if (!this.service.graph) await this.service.analyze();
    this.verifyAbort?.abort();
    const ctl = (this.verifyAbort = new AbortController());
    this.post({ type: 'task', task: 'verify', state: 'start' });
    try {
      const r = await this.service.verify({
        units,
        signal: ctl.signal,
        onProgress: (done, total) => this.post({ type: 'task', task: 'verify', state: 'progress', done, total }),
      });
      if (ctl.signal.aborted) return;
      this.post({ type: 'diagnostics', set: 'compile', diagnostics: r.diagnostics, info: r.info });
      const errors = r.diagnostics.filter((d) => d.severity === 'error').length;
      this.post({ type: 'task', task: 'verify', state: 'done', message: String(errors) });
    } catch (e) {
      if (ctl.signal.aborted) return;
      const msg = String((e as Error)?.message ?? e);
      this.service.log.appendLine('verify failed: ' + ((e as Error)?.stack ?? msg));
      this.post({ type: 'task', task: 'verify', state: 'error', message: msg });
    } finally {
      if (this.verifyAbort === ctl) this.verifyAbort = undefined;
    }
  }

  postEditorDiagnostics(): void {
    const on = vscode.workspace.getConfiguration('codeGraph.verify').get<string>('editorDiagnostics', 'off') === 'errors';
    this.post({ type: 'diagnostics', set: 'editor', diagnostics: on ? this.service.editorDiagnostics() : [] });
  }

  private afterGraph(reason: 'initial' | 'update'): void {
    const mode = verifyMode();
    if (mode === 'manual' || !vscode.workspace.isTrusted) {
      this.saved.clear();
      return;
    }
    if (reason === 'initial' || !this.service.verified) void this.verify();
    else if (mode === 'onOpenAndSave' && this.saved.size) {
      const units = this.service.unitsAffectedBy([...this.saved]);
      if (units.length) void this.verify(units);
    }
    this.saved.clear();
  }

  focusFile(rel: string): void {
    if (this.service.graph) this.post({ type: 'focusFile', file: rel });
    else this.pendingFocus = rel;
  }

  async refresh(reason: 'initial' | 'update', invalidate = false): Promise<void> {
    if (invalidate) this.service.invalidate();
    try {
      const g = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'CodeGraph' },
        (progress) =>
          this.service.analyze({
            onProgress: (done, total) => {
              progress.report({ message: `${done}/${total}` });
              this.post({ type: 'progress', done, total });
            },
          }),
      );
      this.post({ type: 'graph', graph: g, settings: viewSettings(), reason });
      if (this.pendingFocus) {
        this.post({ type: 'focusFile', file: this.pendingFocus });
        this.pendingFocus = undefined;
      }
      this.afterGraph(reason);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      this.service.log.appendLine('analysis failed: ' + ((e as Error)?.stack ?? msg));
      this.post({ type: 'error', message: msg });
    }
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case 'ready': {
        this.ready = true;
        const q = this.queue;
        this.queue = [];
        for (const msg of q) void this.panel.webview.postMessage(msg);
        if (this.service.graph) {
          this.post({ type: 'graph', graph: this.service.graph, settings: viewSettings(), reason: 'initial' });
          if (this.pendingFocus) {
            this.post({ type: 'focusFile', file: this.pendingFocus });
            this.pendingFocus = undefined;
          }
          const v = this.service.verified;
          if (v) this.post({ type: 'diagnostics', set: 'compile', diagnostics: v.diagnostics, info: v.info });
          else if (!this.scope) this.afterGraph('initial');
          const tr = this.service.lastTrace;
          if (this.scope) this.postScopedTrace();
          else if (tr) this.post({ type: 'trace', trace: tr.trace, notes: tr.notes });
        } else await this.refresh('initial');
        this.postEditorDiagnostics();
        break;
      }
      case 'verify':
        await this.verify();
        break;
      case 'runTrace':
        await vscode.commands.executeCommand(m.compose ? 'codeGraph.runCompose' : 'codeGraph.runTrace');
        break;
      case 'loadTrace':
        await vscode.commands.executeCommand('codeGraph.loadTrace');
        break;
      case 'clearTrace':
        // closing the trace of one process's view closes that view
        if (this.scope) this.panel.dispose();
        else await vscode.commands.executeCommand('codeGraph.clearTrace');
        break;
      case 'splitTrace':
        await vscode.commands.executeCommand('codeGraph.splitTrace', m.proc);
        break;
      case 'stopRun':
        await vscode.commands.executeCommand('codeGraph.stopRun');
        break;
      case 'replay':
        // views of one run play together: the containers' calls line up across them
        for (const p of [CircuitPanel.current, ...CircuitPanel.scoped.values()]) if (p && p !== this) p.post({ type: 'replay', t: m.t, playing: m.playing, speed: m.speed });
        break;
      case 'peek': {
        // only files of the analyzed graph: the view cannot ask for anything else on disk
        const abs = this.service.abs(m.file);
        const text = abs ? await sourceText(abs) : undefined;
        const peek = text === undefined ? null : peekLines(text, m.line, { endLine: m.endLine, count: m.count, lead: m.count === 1 ? 0 : 4 });
        if (peek) await colour(peek, m.file);
        this.post({ type: 'peek', req: m.req, peek });
        break;
      }
      case 'open': {
        const abs = this.service.abs(m.file);
        if (!abs) return;
        const line = Math.max(0, m.line - 1);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
        // keep the circuit visible: use another editor group, or open one beside it
        const other = vscode.window.visibleTextEditors.find((e) => e.viewColumn !== this.panel.viewColumn)?.viewColumn;
        const beside = this.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
        await vscode.window.showTextDocument(doc, {
          viewColumn: other ?? beside,
          selection: new vscode.Range(line, 0, line, 0),
          preserveFocus: false,
        });
        break;
      }
      case 'reanalyze':
        await this.refresh('update', true);
        break;
      case 'exportGraph':
        await vscode.commands.executeCommand('codeGraph.exportGraph');
        break;
    }
  }

  private html(): string {
    const w = this.panel.webview;
    const base = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview');
    const js = w.asWebviewUri(vscode.Uri.joinPath(base, 'main.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(base, 'main.css'));
    const elk = w.asWebviewUri(vscode.Uri.joinPath(base, 'elk-worker.js'));
    const n = nonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${w.cspSource} data:`,
      `style-src ${w.cspSource} 'unsafe-inline'`,
      `font-src ${w.cspSource}`,
      `script-src 'nonce-${n}' ${w.cspSource}`,
      `connect-src ${w.cspSource}`,
      `worker-src blob:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>CodeGraph</title>
</head>
<body data-elk-worker="${elk}" data-lang="${vscode.env.language}">
<div id="app"></div>
<script nonce="${n}" src="${js}"></script>
</body>
</html>`;
  }
}
