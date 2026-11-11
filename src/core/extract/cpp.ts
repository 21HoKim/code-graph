/**
 * C / C++ fact extractor (tree-sitter-c / tree-sitter-cpp).
 *
 * Purely syntactic: it records what is written (names, scopes, call forms,
 * local variable types) and leaves cross-file resolution to the linker.
 */
import type { Node } from 'web-tree-sitter';
import type { Param, RawAccess, RawCall, RawEntity, RawInclude, RawTypedef, ScopeKind } from '../model';
import {
  AccessLog,
  CPP_PRIMITIVES,
  KeyRegistry,
  argTexts,
  clip,
  elemCppType,
  endLineOf,
  lineOf,
  named,
  normCppType,
  ownReturns,
  stripTemplateArgs,
  type ReturnRules,
} from './common';
import { CppNames, type LibKind } from './cppnames';

/** A function's own returns: lambdas, local functions and local classes inside it return for themselves. */
const CPP_RETURNS: ReturnRules = {
  returns: new Set(['return_statement', 'co_return_statement', 'co_yield_statement']),
  stops: new Set(['lambda_expression', 'function_definition', 'class_specifier', 'struct_specifier', 'union_specifier']),
};

interface Scope {
  names: string[];
  kinds: ScopeKind[];
  /** RawEntity key of the enclosing class, if directly inside a class body. */
  classKey?: string;
  className?: string;
}

/** How a function reference is handed to another thread. */
interface Spawn {
  /** The API, for the wire's label: `std::thread`, `pthread_create`. */
  via: string;
  /** Container or member that receives the thread, for the linker to confirm by its declared type. */
  recv?: string;
  /** The API was taken from a bare name the file never brings in (see `RawCall.assumed`). */
  assumed?: string;
}

/** A thread or task API that a written name stands for, or is most likely meant as. */
interface ThreadApi {
  name: string;
  kind: LibKind;
  arg?: number;
  assumed?: boolean;
}

interface FnCtx {
  key: string;
  /** variable -> normalized type (for receiver inference) */
  locals: Map<string, string>;
  /** variable -> type as written (to spot std::vector<std::thread> & co.) */
  rawLocals: Map<string, string>;
  /** A method (inline or `Class::f`): a bare name may be one of the class's members. */
  member?: boolean;
  /** Every parameter and local declared so far, typed or not (they hide members of the same name). */
  names?: Set<string>;
}

export interface CppFacts {
  entities: RawEntity[];
  calls: RawCall[];
  includes: RawInclude[];
  usingNamespaces: string[];
  typedefs: RawTypedef[];
  accesses: RawAccess[];
}

const CLASS_NODES = new Set(['class_specifier', 'struct_specifier', 'union_specifier']);
const MAX_DEPTH = 600;

/** `cxx`: the file is C++ (C has no namespaces, so no `std::thread` is assumed from a bare `thread`). */
export function extractCpp(root: Node, cxx = true): CppFacts {
  const x = new CppExtractor(cxx);
  x.decls(named(root), { names: [], kinds: [] });
  return { entities: x.entities, calls: x.calls, includes: x.includes, usingNamespaces: x.usingNs, typedefs: x.typedefs, accesses: x.access.list };
}

// ---------------------------------------------------------------------------
// Syntax helpers
// ---------------------------------------------------------------------------

export function qualifiedParts(n: Node): string[] {
  switch (n.type) {
    case 'qualified_identifier': {
      const scope = n.childForFieldName('scope');
      const name = n.childForFieldName('name');
      return [...(scope ? qualifiedParts(scope) : []), ...(name ? qualifiedParts(name) : [])];
    }
    case 'template_type':
    case 'template_function':
    case 'template_method': {
      const nm = n.childForFieldName('name');
      return nm ? qualifiedParts(nm) : [stripTemplateArgs(n.text)];
    }
    case 'destructor_name':
      return [n.text.replace(/\s+/g, '')];
    case 'operator_name':
    case 'operator_cast':
      return [n.text.replace(/\s+/g, ' ').trim()];
    default:
      return [stripTemplateArgs(n.text)];
  }
}

export function innerDeclarator(n: Node): Node | null {
  return (
    n.childForFieldName('declarator') ??
    named(n).find((c) => c.type.endsWith('declarator') || c.type === 'identifier' || c.type === 'field_identifier') ??
    null
  );
}

/** Walk through pointer/reference/attributed declarators to the function_declarator. */
export function findFnDeclarator(d: Node | null): Node | null {
  let cur = d;
  for (let guard = 0; cur && guard < 8; guard++) {
    if (cur.type === 'function_declarator') {
      const inner = cur.childForFieldName('declarator');
      // `void (*cb)(int)` is a function-pointer variable, not a function.
      return inner && inner.type === 'parenthesized_declarator' ? null : cur;
    }
    if (cur.type === 'identifier' || cur.type === 'field_identifier' || cur.type === 'parenthesized_declarator') return null;
    cur = innerDeclarator(cur);
  }
  return null;
}

/** Name declared by a (possibly wrapped) declarator. */
/** The expression is assigned to, incremented / decremented, or has its address taken. */
function writes(n: Node): boolean {
  const p = n.parent;
  if (!p) return false;
  const same = (x: Node | null) => !!x && x.startIndex === n.startIndex && x.endIndex === n.endIndex;
  if (p.type === 'assignment_expression') return same(p.childForFieldName('left'));
  if (p.type === 'update_expression') return true;
  if (p.type === 'pointer_expression') return p.text.trimStart().startsWith('&');
  return false;
}

function declName(d: Node | null): string | undefined {
  let cur = d;
  for (let guard = 0; cur && guard < 10; guard++) {
    switch (cur.type) {
      case 'identifier':
      case 'field_identifier':
      case 'type_identifier':
        return cur.text;
      case 'qualified_identifier':
        return qualifiedParts(cur).at(-1);
      default:
        cur = innerDeclarator(cur);
    }
  }
  return undefined;
}

function parseParams(list: Node | null): Param[] {
  const out: Param[] = [];
  for (const p of named(list)) {
    if (p.type === 'parameter_declaration' || p.type === 'optional_parameter_declaration') {
      const name = declName(p.childForFieldName('declarator'));
      let txt = p.text.split('=')[0];
      if (name) {
        const i = txt.lastIndexOf(name);
        if (i >= 0) txt = txt.slice(0, i) + txt.slice(i + name.length);
      }
      const type = clip(txt.replace(/\s+([&*])/g, '$1'), 160);
      out.push({ name, type: type || undefined });
    } else if (p.type === 'variadic_parameter_declaration' || p.type === 'variadic_parameter') {
      out.push({ name: '...', type: '...' });
    }
  }
  // `...` is an anonymous token in tree-sitter-c/cpp
  if (list) for (let i = 0; i < list.childCount; i++) if (list.child(i)?.type === '...') out.push({ name: '...', type: '...' });
  if (out.length === 1 && !out[0].name && out[0].type === 'void') return [];
  return out;
}

function returnType(def: Node, declarator: Node | null): string | undefined {
  const t = def.childForFieldName('type');
  if (!t) return undefined; // constructors, destructors
  let s = t.text;
  let cur = declarator;
  for (let guard = 0; cur && cur.type !== 'function_declarator' && guard < 6; guard++) {
    if (cur.type === 'pointer_declarator') s += '*';
    else if (cur.type === 'reference_declarator') s += cur.text.startsWith('&&') ? '&&' : '&';
    cur = innerDeclarator(cur);
  }
  const q = named(def)
    .filter((c) => c.type === 'type_qualifier')
    .map((c) => c.text)
    .join(' ');
  return clip((q ? q + ' ' : '') + s, 160);
}

function collectFlags(def: Node, fd: Node | null, out: Set<string>): void {
  for (let i = 0; i < def.childCount; i++) {
    const c = def.child(i);
    if (!c) continue;
    switch (c.type) {
      case 'storage_class_specifier':
        out.add(c.text.trim());
        break;
      case 'virtual':
      case 'virtual_function_specifier':
        out.add('virtual');
        break;
      case 'explicit_function_specifier':
        out.add('explicit');
        break;
      case 'inline':
      case 'constexpr':
      case 'static':
        out.add(c.type);
        break;
    }
  }
  if (fd) {
    for (const c of named(fd)) {
      if (c.type === 'virtual_specifier') out.add(c.text.trim());
      else if (c.type === 'type_qualifier' && c.text === 'const') out.add('const');
    }
  }
}

function isClassNode(n: Node | null): n is Node {
  return !!n && CLASS_NODES.has(n.type) && !!n.childForFieldName('body');
}

// ---------------------------------------------------------------------------

class CppExtractor {
  entities: RawEntity[] = [];
  calls: RawCall[] = [];
  typedefs: RawTypedef[] = [];
  access = new AccessLog();
  includes: RawInclude[] = [];
  usingNs: string[] = [];
  private keys = new KeyRegistry();
  private byKey = new Map<string, RawEntity>();
  private fileCtx: FnCtx = { key: '', locals: new Map(), rawLocals: new Map() };
  /** `using` declarations, namespace and type aliases in reach: what a written name stands for. */
  private names: CppNames;

  constructor(cxx: boolean) {
    this.names = new CppNames(cxx);
  }

  decls(nodes: Node[], scope: Scope, flags?: string[]): void {
    for (const n of nodes) this.decl(n, scope, flags);
  }

  decl(n: Node, scope: Scope, flags?: string[]): void {
    switch (n.type) {
      case 'preproc_include': {
        const p = n.childForFieldName('path');
        if (p) {
          const raw = p.text.trim();
          const system = raw.startsWith('<');
          this.includes.push({ path: raw.replace(/^["<]|[">]$/g, ''), system, line: lineOf(n) });
        }
        return;
      }
      case 'namespace_definition': {
        const nameNode = n.childForFieldName('name');
        const parts = nameNode ? nameNode.text.split('::').map((s) => s.trim()).filter(Boolean) : ['(anonymous)'];
        const inner: Scope = {
          names: [...scope.names, ...parts],
          kinds: [...scope.kinds, ...parts.map(() => 'namespace' as ScopeKind)],
        };
        const body = n.childForFieldName('body');
        this.names.enter();
        if (body) this.decls(named(body), inner);
        this.names.leave();
        return;
      }
      case 'linkage_specification': {
        const body = n.childForFieldName('body');
        if (!body) return;
        if (body.type === 'declaration_list') this.decls(named(body), scope, flags);
        else this.decl(body, scope, flags);
        return;
      }
      case 'template_declaration':
        for (const c of named(n)) {
          if (c.type !== 'template_parameter_list') this.decl(c, scope, [...(flags ?? []), 'template']);
        }
        return;
      case 'class_specifier':
      case 'struct_specifier':
      case 'union_specifier':
        this.klass(n, scope, undefined, flags);
        return;
      case 'type_definition': {
        const t = n.childForFieldName('type');
        if (isClassNode(t)) {
          const alias = declName(n.childForFieldName('declarator'));
          this.klass(t, scope, alias, flags);
        } else this.typedef(n, scope, flags);
        return;
      }
      case 'alias_declaration':
        this.typedef(n, scope, flags);
        return;
      case 'namespace_alias_definition':
        this.usingDecl(n);
        return;
      case 'function_definition':
        this.fn(n, scope, flags, true);
        return;
      case 'declaration':
      case 'field_declaration':
        this.declaration(n, scope, flags);
        return;
      case 'using_declaration': {
        const ns = this.usingDecl(n);
        if (ns && !this.usingNs.includes(ns)) this.usingNs.push(ns);
        return;
      }
      case 'expression_statement':
        return;
      default:
        // #ifdef / #if / #else blocks (include guards!) contain declarations.
        if (n.type.startsWith('preproc_') && n.type !== 'preproc_def' && n.type !== 'preproc_function_def' && n.type !== 'preproc_call') {
          for (const c of named(n)) {
            if (c.type === 'identifier' || c.type.endsWith('_expression') || c.type === 'preproc_defined') continue;
            this.decl(c, scope, flags);
          }
        }
    }
  }

  /** `declaration` at namespace scope or `field_declaration`/`declaration` in a class body. */
  /**
   * `typedef struct buffer buffer_t;`, `typedef Packet Frame;`, `using Frame = net::Packet;`: another name for a
   * class that may be defined elsewhere. Only plain names: not pointers, functions or templates.
   */
  private typedef(n: Node, scope: Scope, flags?: string[]): void {
    this.typeAlias(n, flags);
    let t: Node | null;
    let name: string | undefined;
    if (n.type === 'alias_declaration') {
      name = n.childForFieldName('name')?.text;
      t = n.childForFieldName('type');
      if (t?.type === 'type_descriptor') {
        if (named(t).some((c) => c.type.endsWith('_declarator'))) return; // using P = Foo*;
        t = t.childForFieldName('type');
      }
    } else {
      const d = n.childForFieldName('declarator');
      if (d?.type !== 'type_identifier') return; // typedef struct x *xp; typedef int (*fn)(void);
      name = d.text;
      t = n.childForFieldName('type');
    }
    if (!t || !name) return;
    if (CLASS_NODES.has(t.type)) t = t.childForFieldName('name');
    if (!t || (t.type !== 'type_identifier' && t.type !== 'qualified_identifier')) return;
    if (/[<*&(]/.test(t.text)) return;
    const target = t.text.replace(/\s+/g, '').replace(/^::/, '');
    if (target !== name) this.typedefs.push({ name, target, scope: scope.names, line: lineOf(n) });
  }

  /**
   * `using namespace X;`, `using X::y;`, `namespace A = B;` (any scope): remembered in `names`. Returns the namespace
   * of a `using namespace`, for the file's list.
   */
  private usingDecl(n: Node): string | undefined {
    if (n.type === 'namespace_alias_definition') {
      const alias = named(n).find((c) => c.type === 'namespace_identifier' || c.type === 'identifier');
      const target = named(n).find((c) => c !== alias);
      if (alias && target) this.names.namespaceAlias(alias.text, target.text);
      return undefined;
    }
    const t = n.text;
    if (/^using\s+namespace\b/.test(t)) {
      const ns = t.replace(/^using\s+namespace\s+/, '').replace(/;$/, '').trim().replace(/^::/, '');
      if (!ns) return undefined;
      this.names.usingNamespace(ns);
      return this.names.expand(ns.split('::'), true).join('::');
    }
    const q = named(n).find((c) => c.type === 'qualified_identifier');
    if (q) this.names.usingName(qualifiedParts(q).join('::'));
    return undefined;
  }

  /** Any `using T = X;` / `typedef X T;` with a plain name, for `names` (not alias templates). */
  private typeAlias(n: Node, flags?: string[]): void {
    if (flags?.includes('template')) return;
    let name: string | undefined;
    let t: Node | null;
    if (n.type === 'alias_declaration') {
      name = n.childForFieldName('name')?.text;
      t = n.childForFieldName('type');
      if (t?.type === 'type_descriptor' && named(t).some((c) => c.type.endsWith('_declarator'))) return;
    } else {
      const d = n.childForFieldName('declarator');
      if (d?.type !== 'type_identifier') return;
      name = d.text;
      t = n.childForFieldName('type');
    }
    if (name && t) this.names.typeAlias(name, this.names.type(normCppType(t.text)));
  }

  /** The thread or task API a written name stands for: `std::thread`, `thread` after `using namespace std;`. */
  private threadApi(parts: string[], kinds: LibKind[]): ThreadApi | undefined {
    const hit = this.names.library(parts);
    if (hit) return kinds.includes(hit.entry.kind) ? { name: hit.name, kind: hit.entry.kind, arg: hit.entry.arg } : undefined;
    const guess = this.names.assumed(parts, kinds);
    return guess && { name: guess.name, kind: guess.entry.kind, assumed: true };
  }

  /** A type spelling with a thread type in it, alone or as an element (`std::vector<std::jthread>`). */
  private threadish(raw: string): boolean {
    for (const m of raw.matchAll(/[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*/g)) {
      if (this.threadApi(m[0].replace(/\s+/g, '').split('::'), ['thread'])) return true;
    }
    return false;
  }

  private declaration(n: Node, scope: Scope, flags?: string[]): void {
    const type = n.childForFieldName('type');
    if (isClassNode(type)) this.klass(type, scope, undefined, flags);
    if (n.children.some((c) => c?.type === 'friend')) return;
    const declarators = n.childrenForFieldName('declarator').filter((d): d is Node => !!d);
    const inClass = scope.kinds.at(-1) === 'class';
    for (const d of declarators) {
      const fd = findFnDeclarator(d);
      if (fd) {
        this.fnDecl(n, d, fd, scope, flags);
        continue;
      }
      if (inClass) {
        // data member: remember its type for receiver inference
        const name = declName(d);
        const owner = scope.classKey ? this.byKey.get(scope.classKey) : undefined;
        if (name && type && owner) {
          // as written, for display: the declarator's `*`, `&`, `[N]` belong to the type
          const dt = d.text;
          const at = dt.lastIndexOf(name);
          const decor = at >= 0 ? (dt.slice(0, at) + dt.slice(at + name.length)).replace(/\s+/g, '') : '';
          (owner.members ??= []).push({ name, type: clip(type.text + decor, 160) });
          owner.fields ??= {};
          owner.fields[name] = this.names.type(normCppType(type.text));
          const elem = elemCppType(type.text);
          if (elem) owner.fields[name + '[]'] = this.names.type(elem);
          if (this.threadish(type.text)) owner.fields[name + '#raw'] = type.text;
        }
        // `std::thread rx_{&Router::rxLoop, this};`, `int n_ = count();`: runs in every constructor of the class
        const value = n.childForFieldName('default_value');
        if (value && scope.classKey) this.memberInit(type, value, scope.classKey);
      } else if (d.type === 'init_declarator') {
        // global initializer: may call functions at static-init time
        const value = d.childForFieldName('value');
        if (value) this.body(value, this.fileCtx, 0);
      }
    }
  }

  /** A default member initializer, recorded for the class (its constructors run it). */
  private memberInit(type: Node | null, value: Node, classKey: string): void {
    const ctx: FnCtx = { key: classKey, locals: new Map(), rawLocals: new Map() };
    const api = type ? this.threadApi(normCppType(type.text).split('::'), ['thread']) : undefined;
    if (api && (value.type === 'initializer_list' || value.type === 'argument_list')) {
      this.spawnFromArgs(argNodes(value), ctx, lineOf(value), { via: api.name, assumed: api.assumed ? api.name : undefined }, 0);
    } else this.body(value, ctx, 0);
  }

  private klass(n: Node, scope: Scope, alias?: string, flags?: string[]): void {
    const body = n.childForFieldName('body');
    if (!body) return;
    const nameNode = n.childForFieldName('name');
    const parts = nameNode ? qualifiedParts(nameNode) : alias ? [alias] : [];
    if (!parts.length) return; // anonymous struct without typedef name
    const name = parts[parts.length - 1];
    const qualifier = parts.slice(0, -1);
    const bases: string[] = [];
    for (const c of named(n)) {
      if (c.type !== 'base_class_clause') continue;
      for (const b of named(c)) {
        if (b.type === 'type_identifier' || b.type === 'qualified_identifier' || b.type === 'template_type') {
          bases.push(qualifiedParts(b).join('::'));
        }
      }
    }
    const fullScope = [...scope.names, ...qualifier];
    const key = this.keys.unique([...fullScope, name].join('::'));
    const ent: RawEntity = {
      key,
      kind: 'class',
      sub: n.type.replace('_specifier', ''),
      name,
      scope: scope.names,
      scopeKinds: scope.kinds,
      qualifier: qualifier.length ? qualifier : undefined,
      parentKey: scope.classKey,
      line: lineOf(n),
      endLine: endLineOf(n),
      isDefinition: true,
      bases: bases.length ? bases : undefined,
      flags: flags?.length ? [...flags] : undefined,
      // `typedef struct ringbuf {…} ringbuf_t;`: code names the type either way
      aliases: alias && nameNode && alias !== name ? [alias] : undefined,
    };
    this.entities.push(ent);
    this.byKey.set(key, ent);
    this.names.declare(name);
    if (ent.aliases) for (const a of ent.aliases) this.names.declare(a);
    const inner: Scope = {
      names: [...fullScope, name],
      kinds: [...scope.kinds, ...qualifier.map(() => 'class' as ScopeKind), 'class'],
      classKey: key,
      className: name,
    };
    this.names.enter(); // type aliases of the class body are seen by its inline methods
    this.members(named(body), inner);
    this.names.leave();
  }

  private members(nodes: Node[], scope: Scope): void {
    for (const m of nodes) {
      switch (m.type) {
        case 'function_definition':
          this.fn(m, scope, undefined, true);
          break;
        case 'field_declaration':
        case 'declaration':
          this.declaration(m, scope);
          break;
        case 'template_declaration':
          for (const c of named(m)) {
            if (c.type === 'function_definition') this.fn(c, scope, ['template'], true);
            else if (c.type === 'declaration' || c.type === 'field_declaration') this.declaration(c, scope, ['template']);
            else if (CLASS_NODES.has(c.type)) this.klass(c, scope, undefined, ['template']);
          }
          break;
        case 'class_specifier':
        case 'struct_specifier':
        case 'union_specifier':
          this.klass(m, scope);
          break;
        case 'type_definition': {
          const t = m.childForFieldName('type');
          if (isClassNode(t)) this.klass(t, scope, declName(m.childForFieldName('declarator')));
          else this.typedef(m, scope);
          break;
        }
        case 'alias_declaration':
          this.typedef(m, scope);
          break;
        case 'using_declaration':
          if (/^using\s+namespace\b/.test(m.text)) this.usingDecl(m); // `using Base::f;` in a class is not a name import
          break;
        default:
          if (m.type.startsWith('preproc_')) this.members(named(m), scope);
      }
    }
  }

  /** Prototype / method declaration without body. */
  private fnDecl(n: Node, d: Node, fd: Node, scope: Scope, flags?: string[]): void {
    const nameNode = fd.childForFieldName('declarator');
    if (!nameNode) return;
    const parts = qualifiedParts(nameNode);
    const name = parts[parts.length - 1];
    const qualifier = parts.slice(0, -1);
    const params = parseParams(fd.childForFieldName('parameters'));
    const fl = new Set<string>(flags ?? []);
    collectFlags(n, fd, fl);
    const dv = n.childForFieldName('default_value');
    if (dv && dv.text.trim() === '0') fl.add('abstract');
    const key = this.keys.unique(`${[...scope.names, ...qualifier, name].join('::')}(${params.map((p) => p.type ?? '').join(',')})`);
    if (!scope.classKey && !qualifier.length) this.names.declare(name);
    this.entities.push({
      key,
      kind: 'function',
      sub: this.fnSub(name, qualifier, scope),
      name,
      scope: scope.names,
      scopeKinds: scope.kinds,
      qualifier: qualifier.length ? qualifier : undefined,
      parentKey: scope.classKey,
      line: lineOf(n),
      endLine: endLineOf(n),
      isDefinition: false,
      params,
      returns: returnType(n, d),
      flags: fl.size ? [...fl] : undefined,
    });
  }

  private fnSub(name: string, qualifier: string[], scope: Scope): string {
    const owner = qualifier.length ? qualifier[qualifier.length - 1] : scope.className;
    if (!owner) return 'function';
    if (name === owner) return 'ctor';
    if (name.startsWith('~')) return 'dtor';
    return 'method';
  }

  private fn(n: Node, scope: Scope, flags: string[] | undefined, _withBody: boolean): void {
    const declarator = n.childForFieldName('declarator');
    const fd = findFnDeclarator(declarator);
    if (!fd) return;
    const nameNode = fd.childForFieldName('declarator');
    if (!nameNode) return;
    const parts = qualifiedParts(nameNode);
    const name = parts[parts.length - 1];
    if (!name) return;
    const qualifier = parts.slice(0, -1);
    const params = parseParams(fd.childForFieldName('parameters'));
    const fl = new Set<string>(flags ?? []);
    collectFlags(n, fd, fl);
    const key = this.keys.unique(`${[...scope.names, ...qualifier, name].join('::')}(${params.map((p) => p.type ?? '').join(',')})`);
    if (!scope.classKey && !qualifier.length) this.names.declare(name);
    this.entities.push({
      key,
      kind: 'function',
      sub: this.fnSub(name, qualifier, scope),
      name,
      scope: scope.names,
      scopeKinds: scope.kinds,
      qualifier: qualifier.length ? qualifier : undefined,
      parentKey: scope.classKey,
      line: lineOf(n),
      endLine: endLineOf(n),
      isDefinition: true,
      params,
      returns: returnType(n, declarator),
      rets: ownReturns(n.childForFieldName('body'), CPP_RETURNS),
      flags: fl.size ? [...fl] : undefined,
    });
    const ctx: FnCtx = { key, locals: new Map(), rawLocals: new Map(), member: !!scope.className || qualifier.length > 0, names: new Set() };
    for (const p of params) {
      if (p.name) ctx.names!.add(p.name);
      if (p.name && p.type) {
        ctx.locals.set(p.name, this.names.type(normCppType(p.type)));
        ctx.rawLocals.set(p.name, p.type);
      }
    }
    for (const c of named(n)) {
      if (c.type === 'field_initializer_list') this.body(c, ctx, 0);
    }
    const body = n.childForFieldName('body');
    if (body) this.body(body, ctx, 0);
  }

  // -------------------------------------------------------------------------
  // Function bodies
  // -------------------------------------------------------------------------

  private body(n: Node, f: FnCtx, depth: number): void {
    if (depth > MAX_DEPTH) return;
    switch (n.type) {
      case 'call_expression':
        this.call(n, f, depth);
        return;
      case 'new_expression': {
        const t = n.childForFieldName('type');
        if (t) {
          const parts = this.names.type(qualifiedParts(t).join('::')).split('::');
          this.calls.push({
            caller: f.key,
            form: 'new',
            name: parts[parts.length - 1],
            qualifier: parts.length > 1 ? parts.slice(0, -1) : undefined,
            line: lineOf(n),
            args: argTexts(n.childForFieldName('arguments')),
            instantiate: true,
          });
        }
        const a = n.childForFieldName('arguments');
        if (a) this.body(a, f, depth + 1);
        return;
      }
      case 'compound_statement':
        // `using namespace std;` inside a function or block holds until its `}`
        this.names.enterBlock();
        for (const c of named(n)) this.body(c, f, depth + 1);
        this.names.leaveBlock();
        return;
      case 'using_declaration':
      case 'namespace_alias_definition':
        this.usingDecl(n);
        return;
      case 'alias_declaration':
      case 'type_definition':
        this.typeAlias(n);
        return;
      case 'declaration':
        this.localDecl(n, f, depth);
        return;
      case 'for_range_loop': {
        // for (auto& x : container) -> x has the container's element type
        const name = declName(n.childForFieldName('declarator'));
        const right = n.childForFieldName('right');
        const declared = this.names.type(normCppType(n.childForFieldName('type')?.text ?? ''));
        if (name) f.names?.add(name);
        if (name) {
          if (declared && declared !== 'auto') f.locals.set(name, declared);
          else if (right?.type === 'identifier') {
            const raw = f.rawLocals.get(right.text);
            const elem = raw ? elemCppType(raw) : undefined;
            f.locals.set(name, elem ? this.names.type(elem) : '[]' + right.text); // '[]x' = element of field x (resolved by linker)
          }
        }
        break;
      }
      case 'lambda_expression': {
        const b = n.childForFieldName('body');
        if (b) this.body(b, f, depth + 1);
        return;
      }
      case 'field_expression': {
        const base = this.memberChain(n, f);
        if (base) this.body(base, f, depth + 1);
        return;
      }
      case 'field_initializer': {
        // Router(int p) : port_(p) {} — the constructor sets the member
        const id = named(n).find((c) => c.type === 'field_identifier');
        if (id && f.member) this.access.add(f.key, { self: true, path: [id.text], write: true }, lineOf(id));
        // Router() : rx_(&Router::rxLoop, this) {} — a thread member started by the constructor
        const init = named(n).find((c) => c.type === 'argument_list' || c.type === 'initializer_list');
        const args = init ? argNodes(init) : [];
        if (id && f.member && args[0] && isFnRef(args[0])) {
          this.spawnFromArgs(args, f, lineOf(n), { via: 'std::thread', recv: 'this.' + id.text }, depth);
          return;
        }
        for (const c of named(n)) if (c !== id) this.body(c, f, depth + 1);
        return;
      }
      case 'identifier':
        // a bare name in a method may be a member of its class (the linker / view checks the class has it)
        if (f.member && !f.names?.has(n.text) && !f.locals.has(n.text)) {
          this.access.add(f.key, { self: true, implicit: true, path: [n.text], write: writes(n) }, lineOf(n));
        }
        return;
      case 'function_definition':
      case 'class_specifier':
      case 'struct_specifier':
      case 'union_specifier':
        return; // local classes are ignored
    }
    for (const c of named(n)) this.body(c, f, depth + 1);
  }

  /**
   * `a.b.c`, `p->len`, `this->cfg.port`: records which members the chain reads (or writes, for the last one) and
   * returns the expression the chain starts from when it is not a plain name, so calls in it are still seen.
   */
  private memberChain(n: Node, f: FnCtx): Node | null {
    const path: string[] = [];
    let cur: Node | null = n;
    while (cur?.type === 'field_expression') {
      const field = cur.childForFieldName('field');
      if (!field) return null;
      path.unshift(field.type === 'field_identifier' ? field.text : qualifiedParts(field).at(-1) ?? field.text);
      cur = cur.childForFieldName('argument');
    }
    if (!cur) return null;
    const line = lineOf(n);
    const write = writes(n);
    if (cur.type === 'this') this.access.add(f.key, { self: true, path, write }, line);
    else if (cur.type === 'identifier') {
      const type = f.locals.get(cur.text);
      if (type) this.access.add(f.key, { type, path, write }, line);
      else if (f.member && !f.names?.has(cur.text)) this.access.add(f.key, { self: true, implicit: true, path: [cur.text, ...path], write }, line);
      return null;
    }
    return cur.type === 'this' ? null : cur;
  }

  private localDecl(n: Node, f: FnCtx, depth: number): void {
    const typeNode = n.childForFieldName('type');
    const rawType = typeNode?.text ?? '';
    const written = normCppType(rawType);
    const tnorm = this.names.type(written);
    const thread = written ? this.threadApi(written.split('::'), ['thread']) : undefined;
    const spawn: Spawn | undefined = thread && { via: thread.name, assumed: thread.assumed ? thread.name : undefined };
    for (const d of n.childrenForFieldName('declarator')) {
      if (!d) continue;
      let declNode: Node | null = d;
      let value: Node | null = null;
      if (d.type === 'init_declarator') {
        declNode = d.childForFieldName('declarator');
        value = d.childForFieldName('value');
      }
      const name = declName(declNode);
      if (name) f.names?.add(name);
      let t = tnorm;
      if ((t === 'auto' || !t) && value) t = this.inferExprType(value) ?? t;
      if (name && t && t !== 'auto') {
        f.locals.set(name, t);
        f.rawLocals.set(name, rawType);
      }
      // `T x(a, b)` / `T x{a, b}`, or `T x(a)` that the grammar reads as a function declaration (a and b are names)
      let init: Node[] | undefined;
      if (value && (value.type === 'argument_list' || value.type === 'initializer_list')) init = argNodes(value);
      else if (!value && declNode?.type === 'function_declarator') init = this.ctorArgs(declNode, f, !!spawn);
      if (spawn && init) {
        this.spawnFromArgs(init, f, lineOf(n), spawn, depth);
        continue;
      }
      if (init && tnorm && !CPP_PRIMITIVES.has(tnorm) && !tnorm.startsWith('std::')) {
        const parts = tnorm.split('::');
        this.calls.push({
          caller: f.key,
          form: 'new',
          name: parts[parts.length - 1],
          qualifier: parts.length > 1 ? parts.slice(0, -1) : undefined,
          line: lineOf(n),
          args: value ? argTexts(value) : init.map((a) => clip(a.text, 32)),
          instantiate: true,
        });
      }
      if (value) this.body(value, f, depth + 1);
    }
  }

  /**
   * `std::thread t(worker);` or `Router r(cfg);` inside a function: C++ reads it as a variable built from `worker`
   * or `cfg`, tree-sitter as a declaration of a function `t` with a parameter of type `worker`. The parameters are
   * the constructor's arguments when each is a bare name with no declarator, and either the type starts a thread
   * (a local function returning a thread object would be odd) or every name is a variable in reach.
   */
  private ctorArgs(fd: Node, f: FnCtx, thread: boolean): Node[] | undefined {
    const params = named(fd.childForFieldName('parameters')).filter((p) => p.type !== 'comment');
    if (!params.length) return undefined;
    const out: Node[] = [];
    for (const p of params) {
      const t = p.type === 'parameter_declaration' && !p.childForFieldName('declarator') ? p.childForFieldName('type') : null;
      if (!t || (t.type !== 'type_identifier' && t.type !== 'qualified_identifier')) return undefined;
      if (named(p).length !== 1) return undefined; // `const T` and the like is a real parameter
      out.push(t);
    }
    if (thread) return out;
    return out.every((t) => t.type === 'type_identifier' && (f.names?.has(t.text) || f.locals.has(t.text))) ? out : undefined;
  }

  private inferExprType(v: Node): string | undefined {
    if (v.type === 'new_expression') {
      const t = v.childForFieldName('type');
      return t ? this.names.type(qualifiedParts(t).join('::')) : undefined;
    }
    if (v.type === 'call_expression') {
      const fn = v.childForFieldName('function');
      if (!fn) return undefined;
      const tmpl = fn.type === 'template_function' ? fn : fn.type === 'qualified_identifier' ? named(fn).find((c) => c.type === 'template_function') : undefined;
      if (tmpl) {
        const parts = qualifiedParts(fn);
        const lib = this.names.library(parts) ?? this.names.assumed(parts, ['make']);
        if (lib?.entry.kind === 'make') {
          const arg = tmpl.childForFieldName('arguments');
          const first = named(arg)[0];
          if (first) return this.names.type(normCppType(first.text));
        }
      }
      if (fn.type === 'identifier' || fn.type === 'qualified_identifier') {
        // `auto x = Router(…)` or `auto x = net::Router(…)`: functional cast if it names a class (verified by linker)
        return this.names.type(qualifiedParts(fn).join('::'));
      }
    }
    return undefined;
  }

  private call(n: Node, f: FnCtx, depth: number): void {
    const fn = n.childForFieldName('function');
    const argList = n.childForFieldName('arguments');
    const args = argNodes(argList);
    const line = lineOf(n);
    const argT = argTexts(argList);
    let skipArgs = false;

    if (fn) {
      switch (fn.type) {
        case 'identifier':
        case 'qualified_identifier':
        case 'template_function': {
          const parts = fn.type === 'identifier' ? [fn.text] : qualifiedParts(fn);
          const api = this.threadApi(parts, ['thread', 'task', 'cthread']);
          if (api?.kind === 'cthread' && args.length > (api.arg ?? 0)) {
            // pthread_create(&t, NULL, worker, arg)
            this.spawnRef(args[api.arg ?? 0], f, line, { via: api.name }, depth);
            skipArgs = true;
          } else if (api && api.kind !== 'cthread') {
            // std::thread(&Server::run, this).detach(), std::async(std::launch::async, load, path)
            this.spawnFromArgs(args, f, line, { via: api.name, assumed: api.assumed ? api.name : undefined }, depth);
            skipArgs = true;
          } else if ((this.names.library(parts) ?? this.names.assumed(parts, ['make']))?.entry.kind === 'make') {
            const t = this.inferExprType(n);
            if (t) {
              const tp = t.split('::');
              this.calls.push({
                caller: f.key,
                form: 'new',
                name: tp[tp.length - 1],
                qualifier: tp.length > 1 ? tp.slice(0, -1) : undefined,
                line,
                args: argT,
                instantiate: true,
              });
            }
          } else {
            const p = this.names.expand(parts);
            const name = p[p.length - 1];
            const call: RawCall =
              p.length === 1
                ? { caller: f.key, form: 'plain', name, line, args: argT }
                : { caller: f.key, form: 'qualified', name, qualifier: p.slice(0, -1), line, args: argT };
            const usingNames = this.names.scoped(p);
            if (usingNames) call.usingNames = usingNames;
            this.calls.push(call);
          }
          break;
        }
        case 'field_expression': {
          const recv = fn.childForFieldName('argument');
          const field = fn.childForFieldName('field');
          const name = field ? qualifiedParts(field).at(-1) ?? field.text : '';
          let qualifier: string[] = ['?'];
          let receiverType: string | undefined;
          let rawRecvType = '';
          if (recv) {
            if (recv.type === 'this') qualifier = ['this'];
            else if (recv.type === 'identifier') {
              qualifier = [recv.text];
              receiverType = f.locals.get(recv.text);
              rawRecvType = f.rawLocals.get(recv.text) ?? '';
            } else if (recv.type === 'field_expression' && recv.childForFieldName('argument')?.type === 'this') {
              qualifier = ['this', recv.childForFieldName('field')?.text ?? '?'];
            } else if (recv.type === 'subscript_expression') {
              // ifaces_[i]->send(p): receiver is an element of a container
              const base = recv.childForFieldName('argument');
              if (base?.type === 'identifier') {
                qualifier = [base.text + '[]'];
                const raw = f.rawLocals.get(base.text);
                const elem = raw ? elemCppType(raw) : undefined;
                receiverType = elem ? this.names.type(elem) : undefined;
              } else if (base?.type === 'field_expression' && base.childForFieldName('argument')?.type === 'this') {
                qualifier = ['this', (base.childForFieldName('field')?.text ?? '?') + '[]'];
              }
            } else if (recv.type === 'pointer_expression' || recv.type === 'parenthesized_expression') {
              const id = named(recv).find((c) => c.type === 'identifier');
              if (id) {
                qualifier = [id.text];
                receiverType = f.locals.get(id.text);
              }
            }
          }
          // std::vector<std::thread> workers; workers.emplace_back(&Router::txLoop, this);
          const first = args[0];
          if (
            (name === 'emplace_back' || name === 'emplace' || name === 'push_back') &&
            first &&
            (first.type === 'lambda_expression' ||
              (first.type === 'pointer_expression' && first.childForFieldName('argument')?.type === 'qualified_identifier')) &&
            (this.threadish(rawRecvType) || (!rawRecvType && args.length >= 1))
          ) {
            const how: Spawn = rawRecvType ? { via: 'std::thread' } : { via: 'thread (emplace)', recv: qualifier.join('.') };
            this.spawnRef(first, f, line, how, depth, args.slice(1));
            skipArgs = true;
          } else if (name) {
            this.calls.push({ caller: f.key, form: 'member', name, qualifier, receiverType, line, args: argT });
          }
          if (recv) this.body(recv, f, depth + 1);
          break;
        }
        default:
          // (*fp)(x), functor(), etc. – not statically resolvable
          this.body(fn, f, depth + 1);
      }
    }
    if (!skipArgs) for (const a of args) this.body(a, f, depth + 1);
  }

  private spawnFromArgs(args: Node[], f: FnCtx, line: number, how: Spawn, depth: number): void {
    let i = 0;
    if (args[0] && /launch::/.test(args[0].text)) i = 1; // std::async(std::launch::async, fn, ...)
    const target = args[i];
    if (target) this.spawnRef(target, f, line, how, depth, args.slice(i + 1));
    for (const a of args.slice(i + 1)) this.body(a, f, depth + 1);
  }

  /** A function *reference* handed to a thread API: `worker`, `&Router::rxLoop`, a lambda, std::bind(...). */
  private spawnRef(node: Node, f: FnCtx, line: number, how: Spawn, depth: number, rest?: Node[]): void {
    let n = node;
    if (n.type === 'pointer_expression') n = n.childForFieldName('argument') ?? n;
    if (n.type === 'parenthesized_expression') n = named(n)[0] ?? n;
    if (n.type === 'cast_expression') n = n.childForFieldName('value') ?? n;
    const args = rest?.length ? rest.map((a) => clip(a.text, 32)) : undefined;
    const mark = (c: RawCall): RawCall => {
      if (how.recv) c.spawnRecv = how.recv;
      if (how.assumed) c.assumed = how.assumed;
      return c;
    };
    switch (n.type) {
      case 'identifier':
      case 'type_identifier': {
        // `worker`, or `ns::worker` written through `using ns::worker;`
        const usingNames = this.names.scoped([n.text]);
        const c = mark({ caller: f.key, form: 'plain', name: n.text, line, args, spawn: how.via });
        if (usingNames) c.usingNames = usingNames;
        this.calls.push(c);
        return;
      }
      case 'qualified_identifier':
      case 'template_function': {
        const parts = this.names.expand(qualifiedParts(n));
        this.calls.push(
          mark({
            caller: f.key,
            form: parts.length > 1 ? 'qualified' : 'plain',
            name: parts[parts.length - 1],
            qualifier: parts.length > 1 ? parts.slice(0, -1) : undefined,
            line,
            args,
            spawn: how.via,
          }),
        );
        return;
      }
      case 'lambda_expression': {
        const before = this.calls.length;
        const b = n.childForFieldName('body');
        if (b) this.body(b, f, depth + 1);
        for (let i = before; i < this.calls.length; i++) {
          const c = this.calls[i];
          if (!c.instantiate && !c.spawn) {
            c.spawn = how.via + ' (lambda)';
            mark(c);
          }
        }
        return;
      }
      case 'call_expression': {
        // std::bind(&C::m, this, ...)
        const fn = n.childForFieldName('function');
        const parts = fn ? (fn.type === 'identifier' ? [fn.text] : qualifiedParts(fn)) : [];
        if (fn && (this.names.library(parts)?.entry.kind === 'bind' || parts[parts.length - 1] === 'bind')) {
          const inner = named(n.childForFieldName('arguments'))[0];
          if (inner) this.spawnRef(inner, f, line, how, depth);
          return;
        }
        this.body(n, f, depth + 1);
        return;
      }
      default:
        this.body(n, f, depth + 1);
    }
  }
}

/** The arguments of an argument list or a braced initializer, without comments. */
function argNodes(list: Node | null | undefined): Node[] {
  return named(list).filter((a) => a.type !== 'comment');
}

/** Looks like a function handed over to run: `&C::run`, `&worker`, a lambda, `std::bind(…)`. */
function isFnRef(n: Node): boolean {
  if (n.type === 'lambda_expression') return true;
  if (n.type === 'pointer_expression') {
    const a = n.childForFieldName('argument');
    return a?.type === 'qualified_identifier' || a?.type === 'identifier';
  }
  if (n.type === 'call_expression') return /(^|::)bind$/.test(n.childForFieldName('function')?.text ?? '');
  return false;
}
