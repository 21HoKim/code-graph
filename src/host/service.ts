/**
 * Workspace analysis service: file discovery through VS Code, parsing on
 * worker threads, per-file cache, debounced incremental updates.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnalysisSession, DEFAULT_EXCLUDE_DIRS, type FileEntry } from '../core/analyze';
import type { CodeGraph } from '../core/model';
import { ParsePool, defaultWorkerCount } from '../core/pool';

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
  graph?: CodeGraph;
  readonly log: vscode.OutputChannel;

  constructor(ctx: vscode.ExtensionContext) {
    this.log = vscode.window.createOutputChannel('CodeCurrent');
    const cfg = vscode.workspace.getConfiguration('codeCurrent');
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
    const cfg = vscode.workspace.getConfiguration('codeCurrent');
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
