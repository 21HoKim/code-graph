import type { Node } from 'web-tree-sitter';

/** Collapse whitespace and truncate for display ("data on the wire"). */
export function clip(s: string, max = 40): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function lineOf(n: Node): number {
  return n.startPosition.row + 1;
}

export function endLineOf(n: Node): number {
  return n.endPosition.row + 1;
}

export function argTexts(argList: Node | null | undefined, max = 6): string[] | undefined {
  if (!argList) return undefined;
  const out: string[] = [];
  for (const a of argList.namedChildren) {
    if (!a || a.type === 'comment') continue;
    if (out.length >= max) {
      out.push('…');
      break;
    }
    out.push(clip(a.text, 32));
  }
  return out.length ? out : undefined;
}

/**
 * Node types that end a function's own body for {@link ownReturns}: what is written inside them belongs to another
 * function (a lambda, a nested or local function, a local class's methods).
 */
export interface ReturnRules {
  /** Statements that give a value back or hand one out: `return`, `co_return`, `yield`. */
  returns: ReadonlySet<string>;
  /** Nodes whose `return`s are their own, not the enclosing function's. */
  stops: ReadonlySet<string>;
}

/**
 * The 1-based lines of the `return` statements of one function body, in order, without those of the lambdas,
 * nested functions and local classes written inside it. Every language extractor uses this with its own node
 * types, so the rule is the same everywhere.
 */
export function ownReturns(body: Node | null | undefined, rules: ReturnRules): number[] {
  const out: number[] = [];
  const walk = (n: Node, depth: number): void => {
    if (depth > 400) return;
    for (const c of named(n)) {
      if (rules.stops.has(c.type)) continue;
      if (rules.returns.has(c.type) && out[out.length - 1] !== lineOf(c)) out.push(lineOf(c));
      walk(c, depth + 1);
    }
  };
  if (body) walk(body, 0);
  return out;
}

/** FNV-1a 32-bit hash, enough to detect content changes for caching. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export class KeyRegistry {
  private seen = new Map<string, number>();
  unique(base: string): string {
    const n = this.seen.get(base) ?? 0;
    this.seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n + 1}`;
  }
}

export function named(n: Node | null | undefined): Node[] {
  if (!n) return [];
  return n.namedChildren.filter((c): c is Node => !!c);
}

/** Names that are almost always library containers/primitives; a unique workspace
 *  method with one of these names is not good evidence for a "guess" edge. */
export const COMMON_METHOD_NAMES = new Set([
  // C++ std
  'push_back', 'emplace_back', 'pop_back', 'push_front', 'pop_front', 'size', 'begin', 'end', 'cbegin', 'cend',
  'find', 'insert', 'erase', 'empty', 'clear', 'lock', 'unlock', 'try_lock', 'c_str', 'data', 'at', 'front',
  'back', 'get', 'reset', 'release', 'load', 'store', 'exchange', 'push', 'pop', 'top', 'emplace', 'count',
  'append', 'substr', 'length', 'swap', 'wait', 'wait_for', 'notify_one', 'notify_all', 'join', 'detach',
  'joinable', 'reserve', 'resize', 'str', 'first', 'second', 'value', 'has_value', 'what', 'compare', 'operator()',
  // Python builtins / stdlib objects
  'extend', 'items', 'keys', 'values', 'update', 'split', 'strip', 'rstrip', 'lstrip', 'format', 'read',
  'readline', 'readlines', 'write', 'close', 'open', 'put', 'put_nowait', 'get_nowait', 'add', 'remove',
  'discard', 'copy', 'sort', 'index', 'encode', 'decode', 'startswith', 'endswith', 'replace', 'lower',
  'upper', 'setdefault', 'acquire', 'set', 'is_set', 'submit', 'result', 'map', 'filter', 'sendall', 'recv',
  'send', 'connect', 'bind', 'listen', 'accept', 'task_done', 'qsize', 'shutdown', 'cancel', 'done', 'info',
  'debug', 'warning', 'error', 'exception', 'critical', 'log', 'start', 'is_alive', 'run_until_complete',
]);

export const CPP_PRIMITIVES = new Set([
  'int', 'char', 'bool', 'float', 'double', 'long', 'short', 'unsigned', 'signed', 'void', 'auto', 'size_t',
  'ssize_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'uintptr_t', 'intptr_t', 'wchar_t', 'char16_t', 'char32_t', 'char8_t',
]);

const SMART_WRAPPERS = /^(?:std::)?(?:unique_ptr|shared_ptr|weak_ptr|reference_wrapper|optional|atomic)\s*<\s*(.+)>$/;

/**
 * Normalize a C++ type spelling to a class-lookup key:
 *   'const net::Packet &'           -> 'net::Packet'
 *   'std::unique_ptr<Router>'       -> 'Router'
 *   'std::vector<Packet>'           -> 'std::vector'
 */
export function normCppType(t: string): string {
  let s = t
    .replace(/\b(const|volatile|struct|class|union|enum|typename|mutable|static|inline|constexpr|extern|register)\b/g, ' ')
    .replace(/[&*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 3; i++) {
    const m = SMART_WRAPPERS.exec(s);
    if (!m) break;
    s = m[1].trim();
  }
  const lt = s.indexOf('<');
  if (lt >= 0) s = s.slice(0, lt);
  return s.replace(/\s+/g, '').replace(/^::/, '');
}

export function stripTemplateArgs(s: string): string {
  let depth = 0;
  let out = '';
  for (const ch of s) {
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out.replace(/\s+/g, '');
}

const SEQ_CONTAINERS = /^(?:std::)?(?:vector|deque|list|forward_list|array|set|unordered_set|multiset|span|initializer_list)$/;
const MAP_CONTAINERS = /^(?:std::)?(?:map|unordered_map|multimap|unordered_multimap)$/;

/** Element type of a container spelling: 'std::vector<std::unique_ptr<Iface>>' -> 'Iface'. */
export function elemCppType(raw: string): string | undefined {
  const s = raw.replace(/\b(const|volatile)\b/g, ' ').trim();
  const lt = s.indexOf('<');
  if (lt < 0 || !s.endsWith('>')) return undefined;
  const outer = s.slice(0, lt).replace(/\s+/g, '');
  const args: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s.slice(lt + 1, -1)) {
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      args.push(cur);
      cur = '';
    } else cur += ch;
  }
  args.push(cur);
  if (SEQ_CONTAINERS.test(outer)) return normCppType(args[0]);
  if (MAP_CONTAINERS.test(outer) && args[1]) return normCppType(args[1]);
  return undefined;
}
