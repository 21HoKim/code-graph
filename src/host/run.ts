/**
 * Run & Trace inside VS Code: pick an entry point, compile-check, build (C/C++),
 * run with the tracer, and hand the trace + any build/runtime failures to the circuit.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { loadParsers } from '../core/extract';
import { findEntries, runAndTrace, type EntryPoint } from '../core/runner';
import { parseTrace, traceDiagnostics, type RunTrace } from '../core/trace';
import { loadCompileCommands } from '../core/verify';
import { CircuitPanel } from './panel';
import type { AnalysisService } from './service';

let running: AbortController | undefined;
let output: vscode.OutputChannel | undefined;

export function lastRunOutput(): vscode.OutputChannel {
  output ??= vscode.window.createOutputChannel('CodeCurrent Run');
  return output;
}

async function pickEntry(ctx: vscode.ExtensionContext, svc: AnalysisService, entries: EntryPoint[]): Promise<EntryPoint | undefined> {
  const cfg = vscode.workspace.getConfiguration('codeCurrent.run');
  const want = cfg.get<string>('entry', '').trim();
  if (want) {
    const hit = entries.find((e) => e.file === want || e.label === want || e.module === want || e.file.endsWith('/' + want));
    if (hit) return hit;
    void vscode.window.showWarningMessage(vscode.l10n.t('codeCurrent.run.entry "{0}" is not an entry point; pick one.', want));
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  const rel = active && svc.isSupported(active) ? svc.rel(active) : undefined;
  const mine = rel ? entries.find((e) => e.file === rel) : undefined;
  if (mine) return mine;
  if (entries.length === 1) return entries[0];
  const last = ctx.workspaceState.get<string>('codeCurrent.lastEntry');
  const items = entries.map((e) => ({ label: e.label, description: e.kind === 'python' ? 'Python' : 'C/C++', entry: e }));
  items.sort((a, b) => (a.entry.label === last ? -1 : b.entry.label === last ? 1 : 0));
  const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('CodeCurrent: what should run?'), placeHolder: vscode.l10n.t('Entry point') });
  if (pick) await ctx.workspaceState.update('codeCurrent.lastEntry', pick.entry.label);
  return pick?.entry;
}

export async function runTraceCommand(ctx: vscode.ExtensionContext, svc: AnalysisService): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage(vscode.l10n.t('Run & Trace is disabled in untrusted workspaces.'));
    return;
  }
  const panel = CircuitPanel.show(ctx, svc);
  const graph = svc.graph ?? (await svc.analyze());
  const entries = findEntries(graph);
  if (!entries.length) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No entry point found: a C/C++ main() or a Python file with if __name__ == "__main__".'));
    return;
  }
  const entry = await pickEntry(ctx, svc, entries);
  if (!entry) return;

  // 1. compile check first: a program that does not compile cannot run
  await panel.verify();
  const errs = (svc.verified?.diagnostics ?? []).filter((d) => d.severity === 'error');
  if (errs.length) {
    const runAnyway = vscode.l10n.t('Run anyway');
    const show = vscode.l10n.t('Show problems');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('{0} compile errors (shown in red on the circuit). Run anyway?', errs.length),
      runAnyway,
      show,
    );
    if (choice === show) panel.post({ type: 'showProblems' });
    if (choice !== runAnyway) return;
  }

  running?.abort();
  const ctl = (running = new AbortController());
  const cfg = vscode.workspace.getConfiguration('codeCurrent');
  const out = lastRunOutput();
  out.clear();
  const workDir = path.join((ctx.storageUri ?? ctx.globalStorageUri).fsPath, 'run');
  const wasm = vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'wasm').fsPath;
  const task = (state: 'start' | 'progress' | 'done' | 'error', message?: string, done?: number, total?: number, kind: 'build' | 'run' = 'run') =>
    panel.post({ type: 'task', task: kind, state, message, done, total });
  task('start', entry.label, undefined, undefined, entry.kind === 'native' ? 'build' : 'run');
  try {
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'CodeCurrent', cancellable: false },
      (progress) =>
        runAndTrace({
          root: svc.root,
          graph,
          files: svc.sourceFiles(),
          entry,
          args: cfg.get<string[]>('run.args', []),
          cwd: cfg.get<string>('run.cwd', '') || undefined,
          env: cfg.get<Record<string, string>>('run.env', {}),
          toolchain: svc.toolchainFor(),
          includePaths: svc.includePaths,
          compileCommands: cfg.get<boolean>('verify.useCompileCommands', true) ? loadCompileCommands(svc.root) : undefined,
          buildFlags: cfg.get<string[]>('run.buildFlags', []),
          linkFlags: cfg.get<string[]>('run.linkFlags', []),
          runtimeDir: vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'runtime').fsPath,
          workDir,
          parsers: () => loadParsers(wasm),
          timeoutMs: Math.max(1, cfg.get<number>('run.timeoutSeconds', 20)) * 1000,
          maxEvents: Math.max(1000, cfg.get<number>('run.maxEvents', 200000)),
          values: cfg.get<boolean>('run.captureValues', true),
          signal: ctl.signal,
          log: (l) => out.appendLine(l),
          onStage: (stage, message, done, total) => {
            progress.report({ message: `${stage}${message ? ': ' + message : ''}${total ? ` ${done}/${total}` : ''}` });
            task('progress', message, done, total, stage === 'build' ? 'build' : 'run');
          },
        }),
    );
    if (ctl.signal.aborted) return;
    if (r.output) {
      out.appendLine('--- program output ---');
      out.append(r.output);
    }
    for (const n of r.notes) out.appendLine('note: ' + n);
    panel.post({ type: 'diagnostics', set: 'build', diagnostics: r.buildDiagnostics });
    panel.post({ type: 'diagnostics', set: 'runtime', diagnostics: r.runtimeDiagnostics });
    if (!r.trace) {
      const n = r.buildDiagnostics.filter((d) => d.severity === 'error').length;
      const msg = n ? vscode.l10n.t('Build failed: {0} errors (shown in red).', n) : r.notes[r.notes.length - 1] ?? vscode.l10n.t('Run failed.');
      task('error', msg, undefined, undefined, 'build');
      out.show(true);
      return;
    }
    svc.lastTrace = { trace: r.trace, notes: r.notes };
    panel.post({ type: 'trace', trace: r.trace, notes: r.notes });
    task('done');
    const tr = r.trace;
    const failed = r.runtimeDiagnostics.length;
    const summary = vscode.l10n.t('{0}: {1} threads, {2} calls traced', entry.label, tr.threads.length, tr.spans.t.length);
    if (failed) void vscode.window.showWarningMessage(`${summary} — ${vscode.l10n.t('{0} runtime failures (shown in red).', failed)}`);
    else void vscode.window.setStatusBarMessage(`$(pulse) ${summary}`, 6000);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    out.appendLine('run failed: ' + ((e as Error)?.stack ?? msg));
    task('error', msg);
  } finally {
    if (running === ctl) running = undefined;
  }
}

/** Open a trace written by the tracers (.jsonl) or by `code-current trace` (.json). */
export async function loadTraceCommand(ctx: vscode.ExtensionContext, svc: AnalysisService): Promise<void> {
  const pick = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { [vscode.l10n.t('Trace')]: ['jsonl', 'json'] },
    title: vscode.l10n.t('Open a CodeCurrent trace'),
  });
  if (!pick?.[0]) return;
  const panel = CircuitPanel.show(ctx, svc);
  const graph = svc.graph ?? (await svc.analyze());
  const text = await fs.promises.readFile(pick[0].fsPath, 'utf8');
  let trace: RunTrace;
  let diagnostics;
  try {
    const first = text.trimStart();
    if (first.startsWith('{"schema":1') || (first.startsWith('{') && !first.includes('\n') && first.includes('"spans"'))) {
      trace = JSON.parse(text) as RunTrace;
      diagnostics = (trace as RunTrace & { diagnostics?: [] }).diagnostics ?? traceDiagnostics(trace, graph);
    } else {
      trace = parseTrace(text, graph, { command: path.basename(pick[0].fsPath) });
      diagnostics = traceDiagnostics(trace, graph);
    }
  } catch (e) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Not a CodeCurrent trace: {0}', String((e as Error)?.message ?? e)));
    return;
  }
  svc.lastTrace = { trace, notes: [] };
  panel.post({ type: 'diagnostics', set: 'runtime', diagnostics });
  panel.post({ type: 'trace', trace });
}

export function clearTraceCommand(svc: AnalysisService): void {
  svc.lastTrace = undefined;
  const p = CircuitPanel.current;
  if (!p) return;
  p.post({ type: 'trace', trace: null });
  p.post({ type: 'diagnostics', set: 'runtime', diagnostics: [] });
  p.post({ type: 'diagnostics', set: 'build', diagnostics: [] });
}

export function stopRun(): void {
  running?.abort();
}
