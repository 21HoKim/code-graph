/** The "circuit" webview panel. */
import * as vscode from 'vscode';
import type { HostMessage, LevelSetting, ViewSettings, WebviewMessage } from '../shared/protocol';
import type { AnalysisService } from './service';

export const VIEW_TYPE = 'codeCurrent.circuit';

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function viewSettings(): ViewSettings {
  const c = vscode.workspace.getConfiguration('codeCurrent');
  return {
    defaultLevel: c.get<LevelSetting>('defaultLevel', 'auto'),
    layout: c.get<'circuit' | 'network'>('layout', 'circuit'),
    flow: c.get<'all' | 'focus' | 'off'>('flow.mode', 'all'),
    maxParticles: c.get<number>('flow.maxParticles', 2500),
    showGuesses: c.get<boolean>('showGuessedLinks', true),
    lang: vscode.env.language,
    host: true,
  };
}

export class CircuitPanel implements vscode.Disposable {
  static current?: CircuitPanel;
  private disposables: vscode.Disposable[] = [];
  private ready = false;
  private queue: HostMessage[] = [];
  private pendingFocus?: string;

  static show(ctx: vscode.ExtensionContext, service: AnalysisService, focusFile?: string): CircuitPanel {
    if (CircuitPanel.current) {
      CircuitPanel.current.panel.reveal(undefined, true);
    } else {
      const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'CodeCurrent', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, CircuitPanel.options(ctx));
      CircuitPanel.current = new CircuitPanel(panel, ctx, service);
    }
    const p = CircuitPanel.current;
    if (focusFile) p.focusFile(focusFile);
    return p;
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
  ) {
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.png');
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m)),
    );
  }

  dispose(): void {
    if (CircuitPanel.current === this) CircuitPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  post(m: HostMessage): void {
    if (!this.ready) {
      // keep only the latest graph/progress while the webview boots
      this.queue = this.queue.filter((q) => q.type !== m.type || m.type === 'error');
      this.queue.push(m);
      return;
    }
    void this.panel.webview.postMessage(m);
  }

  focusFile(rel: string): void {
    if (this.service.graph) this.post({ type: 'focusFile', file: rel });
    else this.pendingFocus = rel;
  }

  async refresh(reason: 'initial' | 'update', invalidate = false): Promise<void> {
    if (invalidate) this.service.invalidate();
    try {
      const g = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'CodeCurrent' },
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
        } else await this.refresh('initial');
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
        await vscode.commands.executeCommand('codeCurrent.exportGraph');
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
<title>CodeCurrent</title>
</head>
<body data-elk-worker="${elk}" data-lang="${vscode.env.language}">
<div id="app"></div>
<script nonce="${n}" src="${js}"></script>
</body>
</html>`;
  }
}
