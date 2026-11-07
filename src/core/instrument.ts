/**
 * Source instrumentation for Run & Trace (C and C++).
 *
 * Copies the workspace's C/C++ sources and headers into a build directory and
 * inserts one statement right after the `{` of every function body — on the
 * same line, so compiler diagnostics keep their line numbers:
 *
 *   C++   ::cct::scope cct_s_(7u, this); ::cct::arg("cfg", cfg, 1);
 *   C     __attribute__((cleanup(cct_cleanup_), unused)) unsigned cct_f_ = (cct_enter(7u, 0), cct_arg_i("n", (long long)(n)), 7u);
 *
 * The runtime (runtime/c/cc_trace.{h,c}) turns those into per-thread call
 * events. Every inserted id (fid) is recorded with the static entity it belongs
 * to, so the trace needs no symbol lookup. Files are read and written as latin1:
 * byte-exact whatever their encoding.
 *
 * Skipped on purpose: constexpr/consteval functions, coroutines, function-try
 * blocks, bodies the parser could not read cleanly.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Node } from 'web-tree-sitter';
import type { Parsers } from './extract';
import { named } from './extract/common';
import { findFnDeclarator } from './extract/cpp';
import type { CodeGraph, Entity } from './model';
import type { TraceFn } from './trace';

export interface InstrumentInput {
  /** Every C/C++ source and header of the workspace. */
  files: { abs: string; rel: string; lang: 'c' | 'cpp' }[];
  outDir: string;
  graph: CodeGraph;
  parsers: Parsers;
}

export interface InstrumentResult {
  fns: TraceFn[];
  /** Files copied / files that received probes. */
  files: number;
  instrumented: number;
  skipped: { file: string; line: number; why: string }[];
}

const INT_TYPEDEF = /^(s?size_t|ptrdiff_t|u?intptr_t|off_t|pid_t|time_t|clock_t|u?int(8|16|32|64)_t|u?int_(fast|least)(8|16|32|64)_t|u?intmax_t|uint|ulong|ushort|uchar|u8|u16|u32|u64|i8|i16|i32|i64|BOOL|DWORD|WORD|BYTE|LONG|ULONG)$/;
const UNSIGNED_TYPEDEF = /^(size_t|uintptr_t|uint\w*|ulong|ushort|uchar|u8|u16|u32|u64|DWORD|WORD|BYTE|ULONG)$/;

interface ParamProbe {
  name: string;
  ref: boolean;
  /** C style: the cct_arg_* call, or undefined when the type cannot be summarised safely. */
  c?: string;
}

export function instrumentSources(o: InstrumentInput): InstrumentResult {
  const defs = new Map<string, Entity>();
  for (const e of o.graph.entities) if (e.kind === 'function' && e.def) defs.set(`${e.def.file}:${e.def.line}`, e);
  const cHeaders = headersIncludedByC(o.graph);
  const fns: TraceFn[] = [];
  const skipped: InstrumentResult['skipped'] = [];
  let instrumented = 0;

  for (const f of o.files) {
    let text: string;
    try {
      text = fs.readFileSync(f.abs, 'latin1');
    } catch {
      continue;
    }
    const isHeader = !/\.(c|cc|cpp|cxx|c\+\+)$/i.test(f.rel);
    // a header that any C file includes must stay valid C
    const cStyle = f.lang === 'c' || (isHeader && cHeaders.has(f.rel));
    const parser = f.lang === 'c' ? o.parsers.c : o.parsers.cpp;
    const tree = parser.parse(text);
    const edits: { at: number; text: string }[] = [];
    if (tree) {
      for (const fd of tree.rootNode.descendantsOfType('function_definition')) {
        if (!fd || insideFunction(fd)) continue;
        const line = fd.startPosition.row + 1;
        const body = fd.childForFieldName('body');
        if (!body || body.type !== 'compound_statement') {
          if (body) skipped.push({ file: f.rel, line, why: 'function-try-block' });
          continue;
        }
        if (fd.hasError) {
          skipped.push({ file: f.rel, line, why: 'parse error' });
          continue;
        }
        const head = text.slice(fd.startIndex, body.startIndex);
        if (/\b(constexpr|consteval)\b/.test(head) || /\bnaked\b/.test(head)) {
          skipped.push({ file: f.rel, line, why: 'constexpr' });
          continue;
        }
        if (/\bco_(await|yield|return)\b/.test(body.text)) {
          skipped.push({ file: f.rel, line, why: 'coroutine' });
          continue;
        }
        const decl = findFnDeclarator(fd.childForFieldName('declarator'));
        if (!decl) continue;
        const ent = defs.get(`${f.rel}:${line}`);
        const fid = fns.length;
        fns.push({ id: ent?.id ?? '', name: ent?.qname ?? decl.childForFieldName('declarator')?.text ?? '?', file: f.rel, line });
        const params = paramsOf(decl.childForFieldName('parameters'));
        let probe: string;
        if (cStyle) {
          const args = params.filter((p) => p.c).map((p) => ', ' + p.c);
          probe = ` __attribute__((cleanup(cct_cleanup_), unused)) unsigned cct_f_ = (cct_enter(${fid}u, 0)${args.join('')}, ${fid}u);`;
        } else {
          const self = isMember(fd, head, ent) ? 'this' : 'nullptr';
          probe = ` ::cct::scope cct_s_(${fid}u, ${self});` + params.map((p) => ` ::cct::arg("${p.name}", ${p.name}, ${p.ref ? 1 : 0});`).join('');
        }
        edits.push({ at: body.startIndex + 1, text: probe });
      }
      tree.delete();
    }
    if (edits.length) instrumented++;
    edits.sort((a, b) => b.at - a.at);
    let out = text;
    for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at);
    const dest = path.join(o.outDir, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, out, 'latin1');
  }
  return { fns, files: o.files.length, instrumented, skipped };
}

function insideFunction(n: Node): boolean {
  for (let p = n.parent; p; p = p.parent) if (p.type === 'function_definition' || p.type === 'lambda_expression') return true;
  return false;
}

/** Can the body use `this`? (methods, constructors, destructors that are not static or friends) */
function isMember(fd: Node, head: string, ent: Entity | undefined): boolean {
  if (/\b(static|friend)\b/.test(head)) return false;
  if (ent) return (ent.sub === 'method' || ent.sub === 'ctor' || ent.sub === 'dtor') && !ent.flags?.includes('static');
  for (let p = fd.parent; p; p = p.parent) {
    if (p.type === 'field_declaration_list') return true;
    if (p.type === 'namespace_definition' || p.type === 'translation_unit') return false;
  }
  return false;
}

function paramsOf(list: Node | null): ParamProbe[] {
  const out: ParamProbe[] = [];
  for (const p of named(list)) {
    if (p.type !== 'parameter_declaration' && p.type !== 'optional_parameter_declaration') continue;
    if (/\bvolatile\b/.test(p.text)) continue;
    const d = p.childForFieldName('declarator');
    if (!d || d.text.includes('...')) continue;
    let cur: Node | null = d;
    let ptr = 0;
    let ref = false;
    let arr = false;
    let name: string | undefined;
    for (let guard = 0; cur && guard < 12 && !name; guard++) {
      switch (cur.type) {
        case 'identifier':
          name = cur.text;
          break;
        case 'pointer_declarator':
          ptr++;
          cur = cur.childForFieldName('declarator');
          break;
        case 'reference_declarator':
          ref = true;
          cur = named(cur)[0] ?? null;
          break;
        case 'array_declarator':
          arr = true;
          cur = cur.childForFieldName('declarator');
          break;
        case 'parenthesized_declarator':
        case 'attributed_declarator':
          cur = named(cur).find((c) => c.type !== 'attribute_specifier' && c.type !== 'attribute_declaration') ?? null;
          break;
        default:
          cur = null; // function pointers, member pointers, anything unusual
      }
    }
    if (!name) continue;
    out.push({ name, ref, c: cArg(name, p.childForFieldName('type'), ptr, arr) });
  }
  return out;
}

/** Summarise a C parameter from its declared type (no templates in C). */
function cArg(name: string, type: Node | null, ptr: number, arr: boolean): string | undefined {
  const t = type?.text.trim() ?? '';
  const q = JSON.stringify(name);
  if (ptr === 1 && !arr && /\bchar\b/.test(t)) return `cct_arg_s(${q}, (const char *)(${name}))`;
  if (ptr > 0 || arr) return `cct_arg_p(${q}, (const void *)(${name}))`;
  if (!type) return undefined;
  if (type.type === 'primitive_type' || type.type === 'sized_type_specifier') {
    if (/\bvoid\b/.test(t)) return undefined;
    if (/\b(float|double)\b/.test(t)) return `cct_arg_d(${q}, (double)(${name}))`;
    if (/\b(bool|_Bool)\b/.test(t)) return `cct_arg_b(${q}, (${name}) ? 1 : 0)`;
    if (/\bunsigned\b/.test(t) || UNSIGNED_TYPEDEF.test(t)) return `cct_arg_u(${q}, (unsigned long long)(${name}))`;
    return `cct_arg_i(${q}, (long long)(${name}))`;
  }
  if (type.type === 'type_identifier' && INT_TYPEDEF.test(t)) {
    return UNSIGNED_TYPEDEF.test(t) ? `cct_arg_u(${q}, (unsigned long long)(${name}))` : `cct_arg_i(${q}, (long long)(${name}))`;
  }
  if (type.type === 'enum_specifier') return `cct_arg_i(${q}, (long long)(${name}))`;
  return undefined; // structs by value, unknown typedefs
}

/** Headers reachable through #include from any C translation unit. */
function headersIncludedByC(g: CodeGraph): Set<string> {
  const lang = new Map(g.files.map((f) => [f.path, f.lang]));
  const out = new Map<string, string[]>();
  for (const r of g.relations) {
    if (r.kind !== 'include' || !r.from.startsWith('f:') || !r.to.startsWith('f:')) continue;
    const a = r.from.slice(2);
    (out.get(a) ?? out.set(a, []).get(a)!).push(r.to.slice(2));
  }
  const seen = new Set<string>();
  const stack = g.files.filter((f) => f.lang === 'c' && /\.c$/i.test(f.path)).map((f) => f.path);
  while (stack.length) {
    const f = stack.pop()!;
    for (const h of out.get(f) ?? []) {
      if (seen.has(h)) continue;
      seen.add(h);
      if (lang.get(h) !== undefined) stack.push(h);
    }
  }
  return seen;
}
