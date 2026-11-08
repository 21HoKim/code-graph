/**
 * Run & Trace inside VS Code: pick an entry point, compile-check, build (C/C++),
 * run with the tracer, and hand the trace + any build/runtime failures to the circuit.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { targetsFor, type BuildTarget } from '../core/buildinfo';
import { findComposeFile, runComposeTrace } from '../core/compose';
import { loadParsers } from '../core/extract';
import type { Diagnostic } from '../core/model';
import { findEntries, runAndTrace, type EntryPoint } from '../core/runner';
import { parseTrace, traceDiagnostics, type RunTrace } from '../core/trace';
import { loadCompileCommands } from '../core/verify';
import { CircuitPanel } from './panel';
import type { AnalysisService } from './service';

let running: AbortController | undefined;
let output: vscode.OutputChannel | undefined;

export function lastRunOutput(): vscode.OutputChannel {
  output ??= vscode.window.createOutputChannel('CodeGraph Run');
  return output;
}

async function pickEntry(ctx: vscode.ExtensionContext, svc: AnalysisService, entries: EntryPoint[]): Promise<EntryPoint | undefined> {
  const cfg = vscode.workspace.getConfiguration('codeGraph.run');
  const want = cfg.get<string>('entry', '').trim();
  if (want) {
    const hit = entries.find((e) => e.file === want || e.label === want || e.module === want || e.file.endsWith('/' + want));
    if (hit) return hit;
    void vscode.window.showWarningMessage(vscode.l10n.t('codeGraph.run.entry "{0}" is not an entry point; pick one.', want));
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  const rel = active && svc.isSupported(active) ? svc.rel(active) : undefined;
  const mine = rel ? entries.find((e) => e.file === rel) : undefined;
  if (mine) return mine;
  if (entries.length === 1) return entries[0];
  const last = ctx.workspaceState.get<string>('codeGraph.lastEntry');
  const items = entries.map((e) => ({ label: e.label, description: e.kind === 'python' ? 'Python' : 'C/C++', entry: e }));
  items.sort((a, b) => (a.entry.label === last ? -1 : b.entry.label === last ? 1 : 0));
  const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('CodeGraph: what should run?'), placeHolder: vscode.l10n.t('Entry point') });
  if (pick) await ctx.workspaceState.update('codeGraph.lastEntry', pick.entry.label);
  return pick?.entry;
}

/**
 * The program as the project builds it (make / CMake) when the entry file goes into one; several
 * (e.g. node-a and node-b from one main.cpp with different -D) → ask. null = cancelled.
 */
async function pickTarget(ctx: vscode.ExtensionContext, svc: AnalysisService, entry: EntryPoint): Promise<BuildTarget | undefined | null> {
  const cfg = vscode.workspace.getConfiguration('codeGraph.run');
  if (entry.kind !== 'native' || !cfg.get<boolean>('useBuildSystem', true)) return undefined;
  const { targets } = await svc.buildTargets();
  const mine = targetsFor(targets, path.join(svc.root, ...entry.file.split('/')));
  if (!mine.length) return undefined;
  const want = cfg.get<string>('target', '').trim();
  if (want) {
    const hit = mine.find((t) => t.name === want);
    if (hit) return hit;
    void vscode.window.showWarningMessage(vscode.l10n.t('codeGraph.run.target "{0}" is not built from {1}; pick one.', want, entry.file));
  }
  if (mine.length === 1) return mine[0];
  const last = ctx.workspaceState.get<string>('codeGraph.lastTarget');
  const rel = (d: string) => path.relative(svc.root, d).split(path.sep).join('/') || '.';
  const items = mine.map((t) => {
    const defines = [...new Set(t.units.flatMap((u) => u.args.filter((a) => /^-D/.test(a))))];
    return {
      label: t.name,
      description: `${t.from} · ${rel(t.dir)}`,
      detail: [...defines, ...t.linkFlags.filter((f) => /^-l/.test(f))].join(' ') || undefined,
      target: t,
    };
  });
  items.sort((a, b) => (a.label === last ? -1 : b.label === last ? 1 : 0));
  const pick = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('CodeGraph: which program?'),
    placeHolder: vscode.l10n.t('{0} is built into {1} programs', entry.file, mine.length),
  });
  if (!pick) return null;
  await ctx.workspaceState.update('codeGraph.lastTarget', pick.label);
  return pick.target;
}

/** Shows a finished run: build/runtime problems in red, the trace on the circuit, a one-line summary. */
function showRun(
  svc: AnalysisService,
  panel: CircuitPanel,
  label: string,
  r: { trace?: RunTrace; notes: string[]; output: string; buildDiagnostics: Diagnostic[]; runtimeDiagnostics: Diagnostic[] },
  task: (state: 'start' | 'progress' | 'done' | 'error', message?: string, done?: number, total?: number, kind?: 'build' | 'run') => void,
  showOutput: boolean,
): void {
  const out = lastRunOutput();
  if (r.output && showOutput) {
    out.appendLine('--- program output ---');
    out.append(r.output);
  }
  for (const n of r.notes) out.appendLine('note: ' + n);
  panel.post({ type: 'diagnostics', set: 'build', diagnostics: r.buildDiagnostics });
  panel.post({ type: 'diagnostics', set: 'runtime', diagnostics: r.runtimeDiagnostics });
  if (!r.trace) {
    const n = r.buildDiagnostics.filter((d) => d.severity === 'error').length;
    const msg = n ? vscode.l10n.t('Build failed: {0} error(s), shown in red.', n) : (r.notes[r.notes.length - 1] ?? vscode.l10n.t('Run failed.'));
    task('error', msg, undefined, undefined, 'build');
    out.show(true);
    return;
  }
  svc.lastTrace = { trace: r.trace, notes: r.notes };
  panel.post({ type: 'trace', trace: r.trace, notes: r.notes });
  task('done');
  const tr = r.trace;
  const failed = r.runtimeDiagnostics.length;
  const summary = tr.procs && tr.procs.length > 1
    ? vscode.l10n.t('{0}: {1} processes, {2} threads, {3} calls traced', label, tr.procs.length, tr.threads.length, tr.spans.t.length)
    : vscode.l10n.t('{0}: {1} threads, {2} calls traced', label, tr.threads.length, tr.spans.t.length);
  if (failed) void vscode.window.showWarningMessage(`${summary} — ${vscode.l10n.t('{0} runtime failure(s), shown in red.', failed)}`);
  else void vscode.window.setStatusBarMessage(`$(pulse) ${summary}`, 6000);
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
      vscode.l10n.t('The compile check found {0} error(s), shown in red on the circuit. Run anyway?', errs.length),
      runAnyway,
      show,
    );
    if (choice === show) panel.post({ type: 'showProblems' });
    if (choice !== runAnyway) return;
  }

  const target = await pickTarget(ctx, svc, entry);
  if (target === null) return;
  const label = target ? `${entry.label} · ${target.name}` : entry.label;

  running?.abort();
  const ctl = (running = new AbortController());
  const cfg = vscode.workspace.getConfiguration('codeGraph');
  const out = lastRunOutput();
  out.clear();
  const workDir = path.join((ctx.storageUri ?? ctx.globalStorageUri).fsPath, 'run');
  const wasm = vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'wasm').fsPath;
  const task = (state: 'start' | 'progress' | 'done' | 'error', message?: string, done?: number, total?: number, kind: 'build' | 'run' = 'run') =>
    panel.post({ type: 'task', task: kind, state, message, done, total });
  task('start', label, undefined, undefined, entry.kind === 'native' ? 'build' : 'run');
  try {
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'CodeGraph', cancellable: false },
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
          target,
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
    showRun(svc, panel, label, r, task, true);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    out.appendLine('run failed: ' + ((e as Error)?.stack ?? msg));
    task('error', msg);
  } finally {
    if (running === ctl) running = undefined;
  }
}

/**
 * Run & Trace with Docker Compose: the workspace's compose project, its services' own builds traced
 * inside their containers, every container on one timeline.
 */
export async function runComposeCommand(ctx: vscode.ExtensionContext, svc: AnalysisService): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage(vscode.l10n.t('Run & Trace is disabled in untrusted workspaces.'));
    return;
  }
  const cfg = vscode.workspace.getConfiguration('codeGraph');
  const file = findComposeFile(svc.root, cfg.get<string>('run.compose.file', '') || undefined);
  if (!file) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No compose file in the workspace (compose.yaml, docker-compose.yml): set codeGraph.run.compose.file.'));
    return;
  }
  const panel = CircuitPanel.show(ctx, svc);
  const graph = svc.graph ?? (await svc.analyze());
  running?.abort();
  const ctl = (running = new AbortController());
  const out = lastRunOutput();
  out.clear();
  out.show(true); // image builds and in-container builds take a while: show what happens
  const label = path.relative(svc.root, file) || path.basename(file);
  const wasm = vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'wasm').fsPath;
  const task = (state: 'start' | 'progress' | 'done' | 'error', message?: string, done?: number, total?: number, kind: 'build' | 'run' = 'run') =>
    panel.post({ type: 'task', task: kind, state, message, done, total });
  task('start', label, undefined, undefined, 'build');
  try {
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CodeGraph · Docker Compose', cancellable: true },
      (progress, token) => {
        token.onCancellationRequested(() => ctl.abort());
        return runComposeTrace({
          root: svc.root,
          graph,
          files: svc.sourceFiles(),
          composeFile: file,
          services: cfg.get<string[]>('run.compose.services', []),
          docker: cfg.get<string>('run.compose.docker', 'docker') || 'docker',
          runtimeDir: vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'runtime').fsPath,
          workDir: path.join((ctx.storageUri ?? ctx.globalStorageUri).fsPath, 'compose'),
          parsers: () => loadParsers(wasm),
          timeoutMs: Math.max(1, cfg.get<number>('run.timeoutSeconds', 20)) * 1000,
          startTimeoutMs: Math.max(10, cfg.get<number>('run.compose.startTimeoutSeconds', 600)) * 1000,
          maxEvents: Math.max(1000, cfg.get<number>('run.maxEvents', 200000)),
          values: cfg.get<boolean>('run.captureValues', true),
          signal: ctl.signal,
          confirmRecreate: async (up) => {
            const go = vscode.l10n.t('Restart with tracing');
            const pick = await vscode.window.showWarningMessage(
              vscode.l10n.t('{0} of this Compose project are running. CodeGraph recreates them with tracing and takes the project down when the trace is done.', up.join(', ')),
              { modal: true },
              go,
            );
            return pick === go;
          },
          log: (l) => out.appendLine(l),
          onStage: (stage, message) => {
            progress.report({ message: message ?? stage });
            task('progress', message, undefined, undefined, stage === 'build' ? 'build' : 'run');
          },
        });
      },
    );
    if (ctl.signal.aborted) {
      task('error', vscode.l10n.t('Cancelled.'));
      return;
    }
    showRun(svc, panel, label, r, task, false);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    out.appendLine('run failed: ' + ((e as Error)?.stack ?? msg));
    task('error', msg);
  } finally {
    if (running === ctl) running = undefined;
  }
}

/** Open a trace written by the tracers (.jsonl) or by `code-graph trace` (.json). */
export async function loadTraceCommand(ctx: vscode.ExtensionContext, svc: AnalysisService): Promise<void> {
  const pick = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { [vscode.l10n.t('Trace')]: ['jsonl', 'json'] },
    title: vscode.l10n.t('Open a CodeGraph trace'),
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
    void vscode.window.showErrorMessage(vscode.l10n.t('Not a CodeGraph trace: {0}', String((e as Error)?.message ?? e)));
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
