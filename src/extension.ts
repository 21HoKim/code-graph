/**
 * CodeGraph — VS Code extension entry point.
 */
import * as fs from 'fs';
import * as vscode from 'vscode';
import { CircuitPanel, VIEW_TYPE, verifyMode, viewSettings } from './host/panel';
import { clearTraceCommand, loadTraceCommand, runTraceCommand, stopRun } from './host/run';
import { AnalysisService } from './host/service';

let service: AnalysisService | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  const svc = (service = new AnalysisService(ctx));
  ctx.subscriptions.push(svc);

  const activeRel = (uri?: vscode.Uri): string | undefined => {
    const u = uri ?? vscode.window.activeTextEditor?.document.uri;
    return u && svc.isSupported(u) ? svc.rel(u) : undefined;
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('codeGraph.open', () => CircuitPanel.show(ctx, svc)),
    vscode.commands.registerCommand('codeGraph.showFile', (uri?: vscode.Uri) => CircuitPanel.show(ctx, svc, activeRel(uri))),
    vscode.commands.registerCommand('codeGraph.reanalyze', async () => {
      const p = CircuitPanel.show(ctx, svc);
      await p.refresh('update', true);
    }),
    vscode.commands.registerCommand('codeGraph.verify', async () => {
      const p = CircuitPanel.show(ctx, svc);
      await p.verify();
    }),
    vscode.commands.registerCommand('codeGraph.runTrace', () => runTraceCommand(ctx, svc)),
    vscode.commands.registerCommand('codeGraph.loadTrace', () => loadTraceCommand(ctx, svc)),
    vscode.commands.registerCommand('codeGraph.clearTrace', () => clearTraceCommand(svc)),
    vscode.commands.registerCommand('codeGraph.exportGraph', async () => {
      const g = svc.graph ?? (await svc.analyze());
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const target = await vscode.window.showSaveDialog({
        defaultUri: folder ? vscode.Uri.joinPath(folder, 'code-graph.graph.json') : undefined,
        filters: { JSON: ['json'] },
      });
      if (!target) return;
      await fs.promises.writeFile(target.fsPath, JSON.stringify(g, null, 2));
      void vscode.window.showInformationMessage(vscode.l10n.t('CodeGraph: graph exported to {0}', target.fsPath));
    }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => CircuitPanel.revive(panel, ctx, svc),
    }),
  );

  // incremental updates: re-link after saves / file creation / deletion
  let timer: NodeJS.Timeout | undefined;
  const schedule = (uri: vscode.Uri) => {
    if (!svc.isSupported(uri) || !CircuitPanel.current) return;
    const rel = svc.rel(uri);
    if (rel) CircuitPanel.current.noteSaved(rel);
    clearTimeout(timer);
    timer = setTimeout(() => void CircuitPanel.current?.refresh('update'), 400);
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{c,h,cc,cpp,cxx,hpp,hh,hxx,py,pyi}');
  ctx.subscriptions.push(
    watcher,
    watcher.onDidCreate(schedule),
    watcher.onDidDelete(schedule),
    vscode.workspace.onDidSaveTextDocument((d) => schedule(d.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('codeGraph') || !CircuitPanel.current) return;
      if (e.affectsConfiguration('codeGraph.exclude') || e.affectsConfiguration('codeGraph.maxFiles') || e.affectsConfiguration('codeGraph.cpp')) {
        void CircuitPanel.current.refresh('update', true);
      } else if (e.affectsConfiguration('codeGraph.verify.editorDiagnostics')) {
        CircuitPanel.current.postEditorDiagnostics();
      } else if (e.affectsConfiguration('codeGraph.verify')) {
        if (verifyMode() !== 'manual') void CircuitPanel.current.verify();
      } else if (svc.graph) {
        CircuitPanel.current.post({ type: 'graph', graph: svc.graph, settings: viewSettings(), reason: 'update' });
      }
    }),
  );

  // language-server errors (opt-in) join the overlay
  let diagTimer: NodeJS.Timeout | undefined;
  ctx.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics(() => {
      if (!CircuitPanel.current || vscode.workspace.getConfiguration('codeGraph.verify').get<string>('editorDiagnostics', 'off') !== 'errors') return;
      clearTimeout(diagTimer);
      diagTimer = setTimeout(() => CircuitPanel.current?.postEditorDiagnostics(), 600);
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      const p = CircuitPanel.current;
      if (!p || !svc.graph) return;
      p.post({ type: 'graph', graph: svc.graph, settings: viewSettings(), reason: 'update' });
      if (verifyMode() !== 'manual') void p.verify();
    }),
  );

  // "you are here": pulse the block under the editor cursor
  let cursorTimer: NodeJS.Timeout | undefined;
  ctx.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      const p = CircuitPanel.current;
      if (!p?.visible || !vscode.workspace.getConfiguration('codeGraph').get<boolean>('followCursor', true)) return;
      const rel = activeRel(e.textEditor.document.uri);
      if (!rel) return;
      clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => p.post({ type: 'cursor', file: rel, line: e.selections[0].active.line + 1 }), 150);
    }),
  );

  // status bar shortcut for C/C++/Python editors
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  item.text = '$(circuit-board) CodeGraph';
  item.tooltip = vscode.l10n.t('Show this file in the CodeGraph circuit view');
  item.command = 'codeGraph.showFile';
  const sync = () => {
    const lang = vscode.window.activeTextEditor?.document.languageId;
    if (lang === 'c' || lang === 'cpp' || lang === 'python') item.show();
    else item.hide();
  };
  sync();
  ctx.subscriptions.push(item, vscode.window.onDidChangeActiveTextEditor(sync));
}

export function deactivate(): void {
  stopRun();
  service?.dispose();
  service = undefined;
}
