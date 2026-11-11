/**
 * Run & Trace inside VS Code: pick an entry point, compile-check, build (C/C++),
 * run with the tracer, and hand the trace + any build/runtime failures to the circuit.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { targetsFor, type BuildTarget } from '../core/buildinfo';
import { runComposeTrace } from '../core/compose';
import { CONFIG_FILE } from '../core/config';
import { loadParsers } from '../core/extract';
import type { Diagnostic } from '../core/model';
import { findEntries, runAndTrace, type EntryPoint } from '../core/runner';
import { mergeTraces, parseTrace, traceDiagnostics, type RunTrace } from '../core/trace';
import { loadCompileCommands } from '../core/verify';
import { CircuitPanel } from './panel';
import { options, type Options } from './project';
import type { AnalysisService } from './service';

let running: AbortController | undefined;
/** Ends the run in progress and keeps its trace (Stop), where `running` cancels it. */
let finishing: AbortController | undefined;
let output: vscode.OutputChannel | undefined;

/** Run in progress: the circuit follows it live, and Stop is offered. */
function begin(): { ctl: AbortController; fin: AbortController } {
  running?.abort();
  const ctl = (running = new AbortController());
  const fin = (finishing = new AbortController());
  void vscode.commands.executeCommand('setContext', 'codeGraph.running', true);
  return { ctl, fin };
}

function done(ctl: AbortController, panel: CircuitPanel): void {
  panel.post({ type: 'live', state: 'end' });
  if (running !== ctl) return;
  running = undefined;
  finishing = undefined;
  void vscode.commands.executeCommand('setContext', 'codeGraph.running', false);
}

/** "Stop": the program (or the Compose project) stops now; what it recorded is shown. */
export function finishRun(): void {
  finishing?.abort();
}

export function lastRunOutput(): vscode.OutputChannel {
  output ??= vscode.window.createOutputChannel('CodeGraph Run');
  return output;
}

/** The current trace: the circuit shows it, process views their part; the palette offers a view per process. */
function setTrace(svc: AnalysisService, trace: RunTrace | undefined, notes: string[] = []): void {
  svc.lastTrace = trace ? { trace, notes } : undefined;
  CircuitPanel.publishTrace(svc);
  void vscode.commands.executeCommand('setContext', 'codeGraph.multiProcess', (trace?.procs?.length ?? 0) > 1);
}

/** After a run CodeGraph could not set up by itself: offer `.codegraph.json` (create or open) and the log. */
async function offerConfig(root: string, message: string, also?: { label: string; command: string }): Promise<void> {
  const exists = fs.existsSync(path.join(root, CONFIG_FILE));
  const act = exists ? vscode.l10n.t('Open {0}', CONFIG_FILE) : vscode.l10n.t('Create {0}', CONFIG_FILE);
  const out = vscode.l10n.t('Show output');
  const pick = await vscode.window.showWarningMessage(message, ...(also ? [also.label] : []), act, out);
  if (pick === act) await vscode.commands.executeCommand('codeGraph.createConfig');
  else if (pick === out) lastRunOutput().show(true);
  else if (also && pick === also.label) await vscode.commands.executeCommand(also.command);
}

async function pickEntry(ctx: vscode.ExtensionContext, svc: AnalysisService, entries: EntryPoint[], want: string): Promise<EntryPoint | undefined> {
  if (want) {
    const hit = entries.find((e) => e.file === want || e.label === want || e.module === want || e.file.endsWith('/' + want));
    if (hit) return hit;
    void vscode.window.showWarningMessage(vscode.l10n.t('run entry "{0}" is not an entry point; pick one.', want));
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
async function pickTarget(ctx: vscode.ExtensionContext, svc: AnalysisService, entry: EntryPoint, o: Options): Promise<BuildTarget | undefined | null> {
  if (entry.kind !== 'native' || !o.useBuildSystem || o.customBuild) return undefined;
  const { targets } = await svc.buildTargets();
  const mine = targetsFor(targets, path.join(svc.root, ...entry.file.split('/')));
  if (!mine.length) return undefined;
  const want = o.target;
  if (want) {
    const hit = mine.find((t) => t.name === want);
    if (hit) return hit;
    void vscode.window.showWarningMessage(vscode.l10n.t('run target "{0}" is not built from {1}; pick one.', want, entry.file));
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
  also?: { label: string; command: string },
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
    void offerConfig(svc.root, `${msg} ${vscode.l10n.t('If your setup is unusual, tell CodeGraph how to build and run it in {0}.', CONFIG_FILE)}`, also);
    return;
  }
  setTrace(svc, r.trace, r.notes);
  task('done');
  const tr = r.trace;
  const failed = r.runtimeDiagnostics.length;
  const multi = !!tr.procs && tr.procs.length > 1;
  const summary = multi
    ? vscode.l10n.t('{0}: {1} processes, {2} threads, {3} calls traced', label, tr.procs!.length, tr.threads.length, tr.spans.t.length)
    : vscode.l10n.t('{0}: {1} threads, {2} calls traced', label, tr.threads.length, tr.spans.t.length);
  const split = vscode.l10n.t('A view per container');
  if (multi) {
    // every container on one timeline; one circuit per container is a click away
    const msg = failed ? `${summary} — ${vscode.l10n.t('{0} runtime failure(s), shown in red.', failed)}` : summary;
    void (failed ? vscode.window.showWarningMessage(msg, split) : vscode.window.showInformationMessage(msg, split)).then((pick) => {
      if (pick === split) void vscode.commands.executeCommand('codeGraph.splitTrace');
    });
  } else if (failed) void vscode.window.showWarningMessage(`${summary} — ${vscode.l10n.t('{0} runtime failure(s), shown in red.', failed)}`);
  else void vscode.window.setStatusBarMessage(`$(pulse) ${summary}`, 6000);
}

/** A program run here that exited badly in a workspace with a compose file: it may need its peers. */
function offerCompose(svc: AnalysisService, label: string, tr: RunTrace): void {
  if (options(svc.root).compose.files.length === 0) return;
  if (!tr.exit.code && !(tr.exit.crash && tr.exit.crash !== 'SIGTERM')) return;
  const go = vscode.l10n.t('Run & Trace with Docker Compose');
  void vscode.window
    .showInformationMessage(vscode.l10n.t('{0} ran on this machine. If it needs its peers or its container, run the Compose project traced: every container on one timeline.', label), go)
    .then((pick) => {
      if (pick === go) void vscode.commands.executeCommand('codeGraph.runCompose');
    });
}

/**
 * A circuit view per process (container) of the current trace, on the same clock: the user picks which from a
 * list (several at once), or `only` opens that one. Never all at once — a project can have many containers.
 */
export async function splitTraceCommand(ctx: vscode.ExtensionContext, svc: AnalysisService, only?: string): Promise<void> {
  const tr = svc.lastTrace?.trace;
  if (!tr?.procs || tr.procs.length < 2) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('The current trace has one process. Run & Trace with Docker Compose, or load several trace files at once, to get one per container.'),
    );
    return;
  }
  let names = only ? [only] : undefined;
  if (!names) {
    const items = processItems(tr);
    const picked = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Open a view per container'),
      placeHolder: vscode.l10n.t('Pick the containers to open: each gets its own circuit, replaying on the same clock'),
      canPickMany: true,
      matchOnDescription: true,
    });
    if (!picked?.length) return;
    names = picked.map((p) => p.name);
  }
  // next to the circuit view, one column each
  const base = CircuitPanel.current?.panel.viewColumn ?? vscode.ViewColumn.One;
  names.forEach((name, i) => CircuitPanel.showScoped(ctx, svc, name, Math.min(vscode.ViewColumn.Nine, base + 1 + i)));
}

/** One line per process of a trace: threads, calls and how it ended; the ones already open come ticked. */
function processItems(tr: RunTrace): (vscode.QuickPickItem & { name: string })[] {
  const callsOf = new Map<number, number>();
  for (const th of tr.spans.th) callsOf.set(th, (callsOf.get(th) ?? 0) + 1);
  return tr.procs!.map((p) => {
    const calls = p.threads.reduce((n, th) => n + (callsOf.get(th) ?? 0), 0);
    const e = p.exit;
    const end = e.crash && e.crash !== 'SIGTERM' && e.crash !== 'SIGINT'
      ? `$(error) ${e.crash}`
      : e.code
        ? `$(warning) ${vscode.l10n.t('exit code {0}', e.code)}`
        : e.stopped || e.timedOut || e.signal
          ? `$(debug-stop) ${vscode.l10n.t('stopped')}`
          : `$(check) ${vscode.l10n.t('ended normally')}`;
    return {
      name: p.name,
      label: p.name,
      description: vscode.l10n.t('{0} threads · {1} calls', p.threads.length, calls),
      detail: end,
      picked: CircuitPanel.isScopedOpen(p.name),
    };
  });
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
  const o = options(svc.root);
  const entry = await pickEntry(ctx, svc, entries, o.entry);
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

  const target = await pickTarget(ctx, svc, entry, o);
  if (target === null) return;
  const label = o.customBuild && entry.kind === 'native' ? `${entry.label} · ${o.customBuild.program}` : target ? `${entry.label} · ${target.name}` : entry.label;

  const { ctl, fin } = begin();
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
          args: o.args,
          cwd: o.cwd,
          env: o.env,
          toolchain: svc.toolchainFor(),
          includePaths: svc.includePaths,
          compileCommands: cfg.get<boolean>('verify.useCompileCommands', true) ? loadCompileCommands(svc.root) : undefined,
          buildFlags: o.buildFlags,
          linkFlags: o.linkFlags,
          target,
          customBuild: o.customBuild,
          runtimeDir: vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'runtime').fsPath,
          workDir,
          parsers: () => loadParsers(wasm),
          timeoutMs: o.timeoutMs,
          maxEvents: o.maxEvents,
          values: o.values,
          signal: ctl.signal,
          finish: fin.signal,
          live: (u) => panel.post({ type: 'live', state: 'tick', update: u }),
          log: (l) => out.appendLine(l),
          onStage: (stage, message, done, total) => {
            progress.report({ message: `${stage}${message ? ': ' + message : ''}${total ? ` ${done}/${total}` : ''}` });
            task('progress', message, done, total, stage === 'build' ? 'build' : 'run');
          },
        }),
    );
    if (ctl.signal.aborted) return;
    // a networked program may only work next to its peers: the Compose run is one click away
    const compose = o.compose.files.length ? { label: vscode.l10n.t('Run & Trace with Docker Compose'), command: 'codeGraph.runCompose' } : undefined;
    panel.post({ type: 'live', state: 'end' });
    showRun(svc, panel, label, r, task, true, compose);
    if (r.trace && !r.trace.exit.stopped) offerCompose(svc, label, r.trace);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    out.appendLine('run failed: ' + ((e as Error)?.stack ?? msg));
    task('error', msg);
  } finally {
    done(ctl, panel);
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
  const o = options(svc.root);
  const file = o.compose.files[0];
  if (!file) {
    void offerConfig(svc.root, vscode.l10n.t('No compose file in the workspace (compose.yaml, docker-compose.yml): name yours in {0}.', CONFIG_FILE));
    return;
  }
  const panel = CircuitPanel.show(ctx, svc);
  const graph = svc.graph ?? (await svc.analyze());
  const { ctl, fin } = begin();
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
          composeFiles: o.compose.files,
          profiles: o.compose.profiles,
          services: o.compose.services,
          config: o.config.compose,
          docker: o.compose.docker,
          runtimeDir: vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'runtime').fsPath,
          workDir: path.join((ctx.storageUri ?? ctx.globalStorageUri).fsPath, 'compose'),
          parsers: () => loadParsers(wasm),
          timeoutMs: o.compose.timeoutMs,
          startTimeoutMs: o.compose.startTimeoutMs,
          maxEvents: o.maxEvents,
          values: o.values,
          signal: ctl.signal,
          finish: fin.signal,
          live: (u) => panel.post({ type: 'live', state: 'tick', update: u }),
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
    panel.post({ type: 'live', state: 'end' });
    showRun(svc, panel, label, r, task, false);
    if (r.trace && r.needsConfig) void offerConfig(svc.root, vscode.l10n.t('Some services were not traced ({0}). Tell CodeGraph about them in {1}.', r.notes[0] ?? '', CONFIG_FILE));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    out.appendLine('run failed: ' + ((e as Error)?.stack ?? msg));
    task('error', msg);
  } finally {
    done(ctl, panel);
  }
}

/**
 * Open a trace written by the tracers (.jsonl) or by `code-graph trace` (.json). Several files (e.g. one
 * per container or machine) are merged onto one timeline, one process each.
 */
export async function loadTraceCommand(ctx: vscode.ExtensionContext, svc: AnalysisService): Promise<void> {
  const pick = await vscode.window.showOpenDialog({
    canSelectMany: true,
    filters: { [vscode.l10n.t('Trace')]: ['jsonl', 'json'] },
    title: vscode.l10n.t('Open CodeGraph traces (several: one timeline, one process each)'),
  });
  if (!pick?.length) return;
  const panel = CircuitPanel.show(ctx, svc);
  const graph = svc.graph ?? (await svc.analyze());
  const parts: { name: string; trace: RunTrace }[] = [];
  for (const uri of pick) {
    const text = await fs.promises.readFile(uri.fsPath, 'utf8');
    const name = path.basename(uri.fsPath).replace(/\.(jsonl|json)$/, '');
    try {
      const first = text.trimStart();
      const trace =
        first.startsWith('{"schema":1') || (first.startsWith('{') && !first.includes('\n') && first.includes('"spans"'))
          ? (JSON.parse(text) as RunTrace)
          : parseTrace(text, graph, { command: path.basename(uri.fsPath) });
      parts.push({ name, trace });
    } catch (e) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Not a CodeGraph trace: {0}', `${path.basename(uri.fsPath)}: ${String((e as Error)?.message ?? e)}`));
      return;
    }
  }
  const trace = parts.length === 1 ? parts[0].trace : mergeTraces(parts, graph, { command: parts.map((p) => p.name).join(' + ') });
  const diagnostics = parts.length === 1 ? ((trace as RunTrace & { diagnostics?: [] }).diagnostics ?? traceDiagnostics(trace, graph)) : traceDiagnostics(trace, graph);
  panel.post({ type: 'diagnostics', set: 'runtime', diagnostics });
  setTrace(svc, trace);
}

export function clearTraceCommand(svc: AnalysisService): void {
  setTrace(svc, undefined);
  const p = CircuitPanel.current;
  if (!p) return;
  p.post({ type: 'diagnostics', set: 'runtime', diagnostics: [] });
  p.post({ type: 'diagnostics', set: 'build', diagnostics: [] });
}

export function stopRun(): void {
  running?.abort();
}
