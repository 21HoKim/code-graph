/**
 * Node-side orchestration shared by the extension host and the CLI:
 * file discovery, compile_commands.json include paths, per-file caching.
 */
import * as fs from 'fs';
import * as path from 'path';
import { languageOf } from './extract';
import { link } from './link';
import type { CodeGraph, FileFacts } from './model';
import type { ParsePool, Progress } from './pool';

export const DEFAULT_EXCLUDE_DIRS = [
  'node_modules', '.git', '.hg', '.svn', 'build', 'out', 'dist', '.venv', 'venv', 'env', '__pycache__',
  '.mypy_cache', '.pytest_cache', '.tox', 'third_party', 'external', 'vendor', '.cache', '.idea', '.vscode',
  'site-packages',
];

export interface FileEntry {
  abs: string;
  rel: string;
  mtimeMs: number;
  size: number;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Recursively list supported source files under `root`. */
export function walk(root: string, opts: { excludeDirs?: string[]; maxFiles?: number } = {}): { files: FileEntry[]; truncated: boolean } {
  const exclude = new Set(opts.excludeDirs ?? DEFAULT_EXCLUDE_DIRS);
  const max = opts.maxFiles ?? 5000;
  const files: FileEntry[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    ents.sort((a, b) => b.name.localeCompare(a.name));
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!exclude.has(e.name) && !e.name.startsWith('cmake-build-')) stack.push(abs);
        continue;
      }
      if (!e.isFile() || !languageOf(e.name)) continue;
      try {
        const st = fs.statSync(abs);
        files.push({ abs, rel: toPosix(path.relative(root, abs)), mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* vanished */
      }
      if (files.length >= max) return { files, truncated: true };
    }
  }
  return { files, truncated: false };
}

/** Include directories (workspace-relative) from compile_commands.json, if present. */
export function includeDirsFromCompileCommands(root: string): string[] {
  const candidates = ['compile_commands.json', 'build/compile_commands.json', 'out/compile_commands.json'];
  try {
    for (const d of fs.readdirSync(root)) if (d.startsWith('cmake-build-')) candidates.push(`${d}/compile_commands.json`);
  } catch {
    /* ignore */
  }
  const dirs = new Set<string>();
  for (const c of candidates) {
    const p = path.join(root, c);
    if (!fs.existsSync(p)) continue;
    try {
      const db = JSON.parse(fs.readFileSync(p, 'utf8')) as { directory: string; command?: string; arguments?: string[] }[];
      for (const entry of db.slice(0, 5000)) {
        const args = entry.arguments ?? (entry.command ?? '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
        for (let i = 0; i < args.length; i++) {
          let a = args[i].replace(/^["']|["']$/g, '');
          let dir: string | undefined;
          if (a === '-I' || a === '-isystem' || a === '-iquote') dir = args[++i];
          else if (a.startsWith('-I')) dir = a.slice(2);
          else if (a.startsWith('-isystem')) dir = a.slice(8);
          if (!dir) continue;
          a = path.resolve(entry.directory ?? root, dir.replace(/^["']|["']$/g, ''));
          const rel = path.relative(root, a);
          if (!rel.startsWith('..') && !path.isAbsolute(rel)) dirs.add(toPosix(rel));
        }
      }
    } catch {
      /* malformed: ignore */
    }
  }
  // conventional layouts
  for (const d of ['include', 'inc', 'src']) if (fs.existsSync(path.join(root, d))) dirs.add(d);
  return [...dirs];
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  facts: FileFacts;
}

/** Keeps per-file facts between runs so that saving one file re-parses one file. */
export class AnalysisSession {
  private cache = new Map<string, CacheEntry>();
  includePaths: string[];

  constructor(
    public readonly root: string,
    private pool: ParsePool,
    includePaths?: string[],
  ) {
    this.includePaths = includePaths ?? includeDirsFromCompileCommands(root);
  }

  async analyze(entries: FileEntry[], onProgress?: Progress): Promise<CodeGraph> {
    const live = new Set(entries.map((e) => e.rel));
    for (const k of [...this.cache.keys()]) if (!live.has(k)) this.cache.delete(k);
    const todo = entries.filter((e) => {
      const c = this.cache.get(e.rel);
      return !c || c.mtimeMs !== e.mtimeMs || c.size !== e.size;
    });
    const parsed = await this.pool.parse(todo, onProgress);
    parsed.forEach((facts, i) => this.cache.set(todo[i].rel, { mtimeMs: todo[i].mtimeMs, size: todo[i].size, facts }));
    return this.link();
  }

  link(): CodeGraph {
    const facts = [...this.cache.values()].map((c) => c.facts);
    return link(facts, { root: path.basename(this.root), includePaths: this.includePaths });
  }

  invalidate(rel?: string): void {
    if (rel) this.cache.delete(rel);
    else this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
