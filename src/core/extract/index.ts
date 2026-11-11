import * as path from 'path';
import { Language, Parser } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';
import type { FileFacts, Lang } from '../model';
import { SOURCE_EXTENSIONS } from '../model';
import { hashText } from './common';
import { extractCpp } from './cpp';
import { extractPython } from './python';

export interface Parsers {
  c: Parser;
  cpp: Parser;
  python: Parser;
}

let initPromise: Promise<void> | undefined;

export const WASM_FILES = ['web-tree-sitter.wasm', 'tree-sitter-c.wasm', 'tree-sitter-cpp.wasm', 'tree-sitter-python.wasm'];

/** Load the tree-sitter runtime and the three grammars from `wasmDir`. */
export async function loadParsers(wasmDir: string): Promise<Parsers> {
  initPromise ??= Parser.init({ locateFile: (f: string) => path.join(wasmDir, f) });
  await initPromise;
  const [c, cpp, py] = await Promise.all([
    Language.load(path.join(wasmDir, 'tree-sitter-c.wasm')),
    Language.load(path.join(wasmDir, 'tree-sitter-cpp.wasm')),
    Language.load(path.join(wasmDir, 'tree-sitter-python.wasm')),
  ]);
  const mk = (l: Language) => {
    const p = new Parser();
    p.setLanguage(l);
    return p;
  };
  return { c: mk(c), cpp: mk(cpp), python: mk(py) };
}

export function languageOf(relPath: string, text?: string): Lang | undefined {
  const ext = path.extname(relPath).toLowerCase();
  const l = SOURCE_EXTENSIONS[ext];
  if (!l) return undefined;
  if (l !== 'header') return l;
  // .h is shared by C and C++. Look for C++-only syntax.
  if (text === undefined) return 'cpp';
  return /\b(class|namespace|template\s*<|public:|private:|protected:|virtual|constexpr|nullptr|typename)\b|::|\bstd::/.test(text) ? 'cpp' : 'c';
}

const MAX_FILE_BYTES = 2_000_000;

export function extractFile(parsers: Parsers, relPath: string, text: string): FileFacts {
  const t0 = Date.now();
  const lang = languageOf(relPath, text) ?? 'cpp';
  const base: FileFacts = {
    path: relPath,
    lang,
    lines: countLines(text),
    hash: hashText(text),
    entities: [],
    calls: [],
    includes: [],
    imports: [],
    usingNamespaces: [],
    parseMs: 0,
  };
  if (text.length > MAX_FILE_BYTES) {
    base.error = `skipped: file larger than ${MAX_FILE_BYTES} bytes`;
    return base;
  }
  const parser = lang === 'python' ? parsers.python : lang === 'c' ? parsers.c : parsers.cpp;
  const tree = parser.parse(text);
  if (!tree) {
    base.error = 'parse failed';
    return base;
  }
  try {
    if (tree.rootNode.hasError) base.syntaxErrors = syntaxIssues(tree.rootNode);
    if (lang === 'python') {
      const r = extractPython(tree.rootNode);
      base.entities = r.entities;
      base.calls = r.calls;
      base.imports = r.imports;
      if (r.accesses.length) base.accesses = r.accesses;
      base.boundNames = r.boundNames;
      base.wildcardImport = r.wildcardImport || undefined;
      base.mainGuard = r.mainGuard || undefined;
    } else {
      const r = extractCpp(tree.rootNode, lang === 'cpp');
      base.entities = r.entities;
      base.calls = r.calls;
      base.includes = r.includes;
      base.usingNamespaces = r.usingNamespaces;
      if (r.typedefs.length) base.typedefs = r.typedefs;
      if (r.accesses.length) base.accesses = r.accesses;
    }
  } catch (e) {
    base.error = String((e as Error)?.stack ?? e);
  } finally {
    tree.delete(); // free WASM memory
  }
  base.parseMs = Date.now() - t0;
  return base;
}

/** ERROR / MISSING nodes, outermost only. Positions are approximate (error recovery). */
function syntaxIssues(root: Node, max = 8): { line: number; endLine: number; message: string }[] {
  const out: { line: number; endLine: number; message: string }[] = [];
  const visit = (n: Node) => {
    if (out.length >= max) return;
    const line = n.startPosition.row + 1;
    if (n.isMissing) {
      out.push({ line, endLine: line, message: `missing '${n.type}'` });
      return;
    }
    if (n.isError) {
      const first = n.text.split('\n')[0].trim().slice(0, 32);
      out.push({ line, endLine: n.endPosition.row + 1, message: `cannot parse near '${first}'` });
      return;
    }
    if (!n.hasError) return;
    for (const c of n.children) if (c) visit(c);
  };
  visit(root);
  return out;
}

function countLines(s: string): number {
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}
