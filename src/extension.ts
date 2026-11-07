/**
 * CodeCurrent — VS Code extension entry point.
 */
import * as fs from 'fs';
import * as vscode from 'vscode';
import { CircuitPanel, VIEW_TYPE, verifyMode, viewSettings } from './host/panel';
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
    vscode.commands.registerCommand('codeCurrent.open', () => CircuitPanel.show(ctx, svc)),
    vscode.commands.registerCommand('codeCurrent.showFile', (uri?: vscode.Uri) => CircuitPanel.show(ctx, svc, activeRel(uri))),
    vscode.commands.registerCommand('codeCurrent.reanalyze', async () => {
      const p = CircuitPanel.show(ctx, svc);
      await p.refresh('update', true);
    }),
    vscode.commands.registerCommand('codeCurrent.verify', async () => {
      const p = CircuitPanel.show(ctx, svc);
      await p.verify();
    }),
    vscode.commands.registerCommand('codeCurrent.exportGraph', async () => {
      const g = svc.graph ?? (await svc.analyze());
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const target = await vscode.window.showSaveDialog({
        defaultUri: folder ? vscode.Uri.joinPath(folder, 'code-current.graph.json') : undefined,
        filters: { JSON: ['json'] },
      });
      if (!target) return;
      await fs.promises.writeFile(target.fsPath, JSON.stringify(g, null, 2));
      void vscode.window.showInformationMessage(vscode.l10n.t('CodeCurrent: graph exported to {0}', target.fsPath));
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
      if (!e.affectsConfiguration('codeCurrent') || !CircuitPanel.current) return;
      if (e.affectsConfiguration('codeCurrent.exclude') || e.affectsConfiguration('codeCurrent.maxFiles') || e.affectsConfiguration('codeCurrent.cpp')) {
        void CircuitPanel.current.refresh('update', true);
      } else if (e.affectsConfiguration('codeCurrent.verify.editorDiagnostics')) {
        CircuitPanel.current.postEditorDiagnostics();
      } else if (e.affectsConfiguration('codeCurrent.verify')) {
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
      if (!CircuitPanel.current || vscode.workspace.getConfiguration('codeCurrent.verify').get<string>('editorDiagnostics', 'off') !== 'errors') return;
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
      if (!p?.visible || !vscode.workspace.getConfiguration('codeCurrent').get<boolean>('followCursor', true)) return;
      const rel = activeRel(e.textEditor.document.uri);
      if (!rel) return;
      clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => p.post({ type: 'cursor', file: rel, line: e.selections[0].active.line + 1 }), 150);
    }),
  );

  // status bar shortcut for C/C++/Python editors
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  item.text = '$(circuit-board) CodeCurrent';
  item.tooltip = vscode.l10n.t('Show this file in the CodeCurrent circuit view');
  item.command = 'codeCurrent.showFile';
  const sync = () => {
    const lang = vscode.window.activeTextEditor?.document.languageId;
    if (lang === 'c' || lang === 'cpp' || lang === 'python') item.show();
    else item.hide();
  };
  sync();
  ctx.subscriptions.push(item, vscode.window.onDidChangeActiveTextEditor(sync));
}

export function deactivate(): void {
  service?.dispose();
  service = undefined;
}
