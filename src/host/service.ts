/**
 * Workspace analysis service: file discovery through VS Code, parsing on
 * worker threads, per-file cache, debounced incremental updates.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnalysisSession, DEFAULT_EXCLUDE_DIRS, type FileEntry } from '../core/analyze';
import type { CodeGraph, Diagnostic } from '../core/model';
import { ParsePool, defaultWorkerCount } from '../core/pool';
import { compileCommandsOf, readBuildTargets, type BuildTarget } from '../core/buildinfo';
import { detectToolchain, loadCompileCommands, verifyWorkspace, type Toolchain } from '../core/verify';
import type { RunTrace } from '../core/trace';
import type { VerifyInfo } from '../shared/protocol';

const SOURCE_GLOB = '**/*.{c,h,cc,cpp,cxx,c++,hpp,hh,hxx,h++,ipp,inl,py,pyi}';

export interface AnalysisEvents {
  onProgress(done: number, total: number): void;
}

export class AnalysisService implements vscode.Disposable {
  private pool: ParsePool;
  private session?: AnalysisSession;
  private absOf = new Map<string, string>();
  private relOf = new Map<string, string>();
  private running?: Promise<CodeGraph>;
  private rerun = false;
  private entries: FileEntry[] = [];
  private unitDiags = new Map<string, Diagnostic[]>();
  private toolchain?: { key: string; tc: Toolchain };
  graph?: CodeGraph;
  /** Latest compile-check result (merged over all units). */
  verified?: { diagnostics: Diagnostic[]; info: VerifyInfo };
  /** Latest runtime trace (survives closing the panel). */
  lastTrace?: { trace: RunTrace; notes: string[] };
  readonly log: vscode.OutputChannel;

  constructor(ctx: vscode.ExtensionContext) {
    this.log = vscode.window.createOutputChannel('CodeGraph');
    const cfg = vscode.workspace.getConfiguration('codeGraph');
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    this.pool = new ParsePool(
      vscode.Uri.joinPath(dist, 'wasm').fsPath,
      vscode.Uri.joinPath(dist, 'parseWorker.js').fsPath,
      defaultWorkerCount(cfg.get<number>('analysis.workers', 0)),
    );
  }

  dispose(): void {
    this.pool.dispose();
    this.log.dispose();
  }

  /** Workspace-relative path used inside the graph (prefixed with folder name in multi-root workspaces). */
  rel(uri: vscode.Uri): string | undefined {
    return this.relOf.get(uri.fsPath) ?? this.computeRel(uri);
  }

  abs(rel: string): string | undefined {
    return this.absOf.get(rel);
  }

  private computeRel(uri: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return undefined;
    const r = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
    return (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? `${folder.name}/${r}` : r;
  }

  isSupported(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && /\.(c|h|cc|cpp|cxx|c\+\+|hpp|hh|hxx|h\+\+|ipp|inl|py|pyi)$/i.test(uri.fsPath);
  }

  invalidate(): void {
    this.session?.invalidate();
  }

  get root(): string {
    return this.session?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  get includePaths(): string[] {
    return this.session?.includePaths ?? [];
  }

  /** Source files of the last analysis with their language. */
  sourceFiles(): { abs: string; rel: string; lang: 'c' | 'cpp' | 'python' }[] {
    const out: { abs: string; rel: string; lang: 'c' | 'cpp' | 'python' }[] = [];
    for (const e of this.entries) {
      if (/\.py$/i.test(e.rel)) out.push({ abs: e.abs, rel: e.rel, lang: 'python' });
      else if (/\.c$/i.test(e.rel)) out.push({ abs: e.abs, rel: e.rel, lang: 'c' });
      else if (!/\.pyi$/i.test(e.rel)) out.push({ abs: e.abs, rel: e.rel, lang: /\.h$/i.test(e.rel) && !this.cppHeader(e.rel) ? 'c' : 'cpp' });
    }
    return out;
  }

  private cppHeader(rel: string): boolean {
    return this.graph?.files.find((f) => f.path === rel)?.lang === 'cpp';
  }

  private buildInfo?: Promise<{ targets: BuildTarget[]; from?: BuildTarget['from']; error?: string }>;

  /** The project's own programs (make dry run / CMake link files), cached until a build file changes. */
  buildTargets(): Promise<{ targets: BuildTarget[]; from?: BuildTarget['from']; error?: string }> {
    if (!vscode.workspace.isTrusted) return Promise.resolve({ targets: [] }); // make -n runs the makefile
    this.buildInfo ??= readBuildTargets(this.root, { compileCommands: loadCompileCommands(this.root) }).then(
      (r) => {
        if (r.targets.length) this.log.appendLine(`build: ${r.from} — ${r.targets.map((t) => t.name).join(', ')}`);
        if (r.error) this.log.appendLine(`build: make -n: ${r.error}`);
        return r;
      },
      (e) => {
        this.log.appendLine(`build: ${String((e as Error)?.message ?? e)}`);
        return { targets: [] };
      },
    );
    return this.buildInfo;
  }

  invalidateBuildInfo(): void {
    this.buildInfo = undefined;
  }

  toolchainFor(): Toolchain {
    const c = vscode.workspace.getConfiguration('codeGraph.verify');
    const pref = { cc: c.get<string>('cc', '') || undefined, cxx: c.get<string>('cxx', '') || undefined, python: c.get<string>('python', '') || undefined };
    const key = JSON.stringify(pref);
    if (this.toolchain?.key !== key) {
      const tc = detectToolchain(pref);
      this.toolchain = { key, tc };
      this.log.appendLine(`toolchain: cc=${tc.cc ?? '-'} (${tc.ccKind ?? '?'}), c++=${tc.cxx ?? '-'} (${tc.cxxKind ?? '?'}), python=${tc.python ?? '-'}`);
    }
    return this.toolchain.tc;
  }

  /**
   * Compile-check the workspace (or only `units`) with the real toolchain. Keeps per-unit results so a
   * save re-checks just the affected translation units.
   */
  async verify(opts: { units?: string[]; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<{ diagnostics: Diagnostic[]; info: VerifyInfo }> {
    const cfg = vscode.workspace.getConfiguration('codeGraph.verify');
    const all = this.sourceFiles();
    const wanted = opts.units ? new Set(opts.units) : undefined;
    const files = wanted ? all.filter((f) => wanted.has(f.rel)) : all;
    const root = this.root;
    // the project's flags: compile_commands.json, else what its makefile passes (defines like -DNODE_A, -I…)
    let compileCommands = cfg.get<boolean>('useCompileCommands', true) ? loadCompileCommands(root) : undefined;
    if (!compileCommands && cfg.get<boolean>('useCompileCommands', true)) {
      const bt = await this.buildTargets();
      if (bt.targets.length) compileCommands = compileCommandsOf(bt.targets);
    }
    const r = await verifyWorkspace({
      root,
      files,
      includePaths: this.includePaths,
      toolchain: this.toolchainFor(),
      compileCommands,
      extraFlags: cfg.get<string[]>('extraFlags', []),
      timeoutMs: Math.max(5, cfg.get<number>('timeoutSeconds', 60)) * 1000,
      onProgress: opts.onProgress,
      signal: opts.signal,
      relOf: (abs) => this.relOf.get(abs) ?? this.computeRel(vscode.Uri.file(abs)),
    });
    if (opts.signal?.aborted) throw new Error('cancelled');
    const live = new Set(all.map((f) => f.rel));
    if (!wanted) this.unitDiags.clear();
    for (const f of files) this.unitDiags.delete(f.rel);
    for (const [u, d] of r.units) this.unitDiags.set(u, d);
    for (const u of [...this.unitDiags.keys()]) if (!live.has(u)) this.unitDiags.delete(u);
    const seen = new Set<string>();
    const diagnostics: Diagnostic[] = [];
    for (const list of this.unitDiags.values())
      for (const d of list) {
        const k = `${d.file}:${d.line}:${d.col ?? 0}:${d.severity}:${d.message}`;
        if (!seen.has(k)) {
          seen.add(k);
          diagnostics.push(d);
        }
      }
    const prev = this.verified?.info;
    const info: VerifyInfo = wanted && prev
      ? { ...prev, cChecked: prev.cChecked || r.cChecked, pyChecked: prev.pyChecked || r.pyChecked, notes: r.notes.length ? r.notes : prev.notes, ms: r.ms }
      : { cChecked: r.cChecked, pyChecked: r.pyChecked, checkedC: r.checkedC, checkedPython: r.checkedPython, notes: r.notes, ms: r.ms };
    this.verified = { diagnostics, info };
    const errs = diagnostics.filter((d) => d.severity === 'error').length;
    this.log.appendLine(
      `verify${wanted ? ` (${files.length} units)` : ''}: ${r.checkedC} C/C++ units, ${r.checkedPython} Python files — ${errs} errors, ${diagnostics.length - errs} warnings in ${r.ms} ms`,
    );
    for (const n of r.notes) this.log.appendLine('  note: ' + n);
    return this.verified;
  }

  /** Translation units / Python files to re-check after `changed` files were saved (headers → every TU including them). */
  unitsAffectedBy(changed: string[]): string[] {
    const g = this.graph;
    const out = new Set<string>();
    const isUnit = (rel: string) => /\.(c|cc|cpp|cxx|c\+\+|py)$/i.test(rel);
    const includers = new Map<string, string[]>();
    for (const r of g?.relations ?? []) {
      if (r.kind !== 'include' || !r.from.startsWith('f:') || !r.to.startsWith('f:')) continue;
      const to = r.to.slice(2);
      (includers.get(to) ?? includers.set(to, []).get(to)!).push(r.from.slice(2));
    }
    const seen = new Set<string>();
    const stack = [...changed];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      if (isUnit(f)) out.add(f);
      for (const by of includers.get(f) ?? []) stack.push(by);
    }
    return [...out];
  }

  /** Errors that VS Code's language servers (C/C++, Pylance, clangd…) report for workspace sources. */
  editorDiagnostics(): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const [uri, list] of vscode.languages.getDiagnostics()) {
      if (!this.isSupported(uri)) continue;
      const rel = this.rel(uri);
      if (!rel) continue;
      for (const d of list) {
        if (d.severity !== vscode.DiagnosticSeverity.Error) continue;
        out.push({
          file: rel,
          line: d.range.start.line + 1,
          col: d.range.start.character + 1,
          endLine: d.range.end.line + 1,
          severity: 'error',
          source: 'editor',
          message: `${d.message}${d.source ? ` (${d.source})` : ''}`,
        });
      }
    }
    return out;
  }

  /** Analyze (or re-analyze) the workspace. Concurrent calls coalesce. */
  analyze(events?: AnalysisEvents): Promise<CodeGraph> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        let g: CodeGraph;
        do {
          this.rerun = false;
          g = await this.run(events);
        } while (this.rerun);
        this.graph = g;
        return g;
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private async run(events?: AnalysisEvents): Promise<CodeGraph> {
    const t0 = Date.now();
    const folders = vscode.workspace.workspaceFolders ?? [];
    const root = folders[0]?.uri.fsPath ?? process.cwd();
    const cfg = vscode.workspace.getConfiguration('codeGraph');
    const max = cfg.get<number>('maxFiles', 3000);
    const exclude = cfg.get<string[]>('exclude', DEFAULT_EXCLUDE_DIRS.map((d) => `**/${d}/**`));
    const uris = await vscode.workspace.findFiles(SOURCE_GLOB, exclude.length ? `{${exclude.join(',')}}` : null, max);
    const entries: FileEntry[] = [];
    this.absOf.clear();
    this.relOf.clear();
    await Promise.all(
      uris
        .filter((u) => u.scheme === 'file')
        .map(async (u) => {
          const rel = this.computeRel(u);
          if (!rel) return;
          try {
            const st = await fs.promises.stat(u.fsPath);
            entries.push({ abs: u.fsPath, rel, mtimeMs: st.mtimeMs, size: st.size });
            this.absOf.set(rel, u.fsPath);
            this.relOf.set(u.fsPath, rel);
          } catch {
            /* vanished */
          }
        }),
    );
    entries.sort((a, b) => a.rel.localeCompare(b.rel));
    this.entries = entries;
    if (!this.session || this.session.root !== root) {
      const extra = cfg.get<string[]>('cpp.includePaths', []);
      this.session = new AnalysisSession(root, this.pool);
      if (extra.length) this.session.includePaths = [...new Set([...this.session.includePaths, ...extra])];
    }
    const g = await this.session.analyze(entries, (d, t) => events?.onProgress(d, t));
    const s = g.stats;
    this.log.appendLine(
      `[${new Date().toLocaleTimeString()}] ${s.files} files${uris.length >= max ? ' (maxFiles reached)' : ''}, ${s.functions} functions, ` +
        `${s.relations} relations, ${s.resolvedCalls}/${s.callSites} calls resolved — parse ${s.parseMs} ms cpu, link ${s.linkMs} ms, total ${Date.now() - t0} ms`,
    );
    for (const w of g.warnings ?? []) this.log.appendLine('  warn: ' + w);
    return g;
  }
}
