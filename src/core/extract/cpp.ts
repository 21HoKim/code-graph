/**
 * C / C++ fact extractor (tree-sitter-c / tree-sitter-cpp).
 *
 * Purely syntactic: it records what is written (names, scopes, call forms,
 * local variable types) and leaves cross-file resolution to the linker.
 */
import type { Node } from 'web-tree-sitter';
import type { Param, RawCall, RawEntity, RawInclude, ScopeKind } from '../model';
import {
  CPP_PRIMITIVES,
  KeyRegistry,
  argTexts,
  clip,
  elemCppType,
  endLineOf,
  lineOf,
  named,
  normCppType,
  stripTemplateArgs,
} from './common';

interface Scope {
  names: string[];
  kinds: ScopeKind[];
  /** RawEntity key of the enclosing class, if directly inside a class body. */
  classKey?: string;
  className?: string;
}

interface FnCtx {
  key: string;
  /** variable -> normalized type (for receiver inference) */
  locals: Map<string, string>;
  /** variable -> type as written (to spot std::vector<std::thread> & co.) */
  rawLocals: Map<string, string>;
}

export interface CppFacts {
  entities: RawEntity[];
  calls: RawCall[];
  includes: RawInclude[];
  usingNamespaces: string[];
}

const CLASS_NODES = new Set(['class_specifier', 'struct_specifier', 'union_specifier']);
const THREAD_TYPE = /(^|::)(thread|jthread)$/;
const MAX_DEPTH = 600;

export function extractCpp(root: Node): CppFacts {
  const x = new CppExtractor();
  x.decls(named(root), { names: [], kinds: [] });
  return { entities: x.entities, calls: x.calls, includes: x.includes, usingNamespaces: x.usingNs };
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
      const type = clip(txt.replace(/\s+([&*])/g, '$1'), 40);
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
  return clip((q ? q + ' ' : '') + s, 32);
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
  includes: RawInclude[] = [];
  usingNs: string[] = [];
  private keys = new KeyRegistry();
  private byKey = new Map<string, RawEntity>();
  private fileCtx: FnCtx = { key: '', locals: new Map(), rawLocals: new Map() };

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
        if (body) this.decls(named(body), inner);
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
        }
        return;
      }
      case 'function_definition':
        this.fn(n, scope, flags, true);
        return;
      case 'declaration':
      case 'field_declaration':
        this.declaration(n, scope, flags);
        return;
      case 'using_declaration': {
        const t = n.text;
        if (/^using\s+namespace\b/.test(t)) {
          const ns = t.replace(/^using\s+namespace\s+/, '').replace(/;$/, '').trim();
          if (ns) this.usingNs.push(ns.replace(/^::/, ''));
        }
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
          owner.fields ??= {};
          owner.fields[name] = normCppType(type.text);
          const elem = elemCppType(type.text);
          if (elem) owner.fields[name + '[]'] = elem;
          if (/\bthread\b/.test(type.text)) owner.fields[name + '#raw'] = type.text;
        }
      } else if (d.type === 'init_declarator') {
        // global initializer: may call functions at static-init time
        const value = d.childForFieldName('value');
        if (value) this.body(value, this.fileCtx, 0);
      }
    }
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
    };
    this.entities.push(ent);
    this.byKey.set(key, ent);
    const inner: Scope = {
      names: [...fullScope, name],
      kinds: [...scope.kinds, ...qualifier.map(() => 'class' as ScopeKind), 'class'],
      classKey: key,
      className: name,
    };
    this.members(named(body), inner);
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
          break;
        }
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
      flags: fl.size ? [...fl] : undefined,
    });
    const ctx: FnCtx = { key, locals: new Map(), rawLocals: new Map() };
    for (const p of params) {
      if (p.name && p.type) {
        ctx.locals.set(p.name, normCppType(p.type));
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
          const parts = qualifiedParts(t);
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
      case 'declaration':
        this.localDecl(n, f, depth);
        return;
      case 'for_range_loop': {
        // for (auto& x : container) -> x has the container's element type
        const name = declName(n.childForFieldName('declarator'));
        const right = n.childForFieldName('right');
        const declared = normCppType(n.childForFieldName('type')?.text ?? '');
        if (name) {
          if (declared && declared !== 'auto') f.locals.set(name, declared);
          else if (right?.type === 'identifier') {
            const raw = f.rawLocals.get(right.text);
            const elem = raw ? elemCppType(raw) : undefined;
            f.locals.set(name, elem ?? '[]' + right.text); // '[]x' = element of field x (resolved by linker)
          }
        }
        break;
      }
      case 'lambda_expression': {
        const b = n.childForFieldName('body');
        if (b) this.body(b, f, depth + 1);
        return;
      }
      case 'function_definition':
      case 'class_specifier':
      case 'struct_specifier':
      case 'union_specifier':
        return; // local classes are ignored
    }
    for (const c of named(n)) this.body(c, f, depth + 1);
  }

  private localDecl(n: Node, f: FnCtx, depth: number): void {
    const typeNode = n.childForFieldName('type');
    const rawType = typeNode?.text ?? '';
    const tnorm = normCppType(rawType);
    for (const d of n.childrenForFieldName('declarator')) {
      if (!d) continue;
      let declNode: Node | null = d;
      let value: Node | null = null;
      if (d.type === 'init_declarator') {
        declNode = d.childForFieldName('declarator');
        value = d.childForFieldName('value');
      }
      const name = declName(declNode);
      let t = tnorm;
      if ((t === 'auto' || !t) && value) t = this.inferExprType(value) ?? t;
      if (name && t && t !== 'auto') {
        f.locals.set(name, t);
        f.rawLocals.set(name, rawType);
      }
      if (value && value.type === 'argument_list' && THREAD_TYPE.test(tnorm)) {
        this.spawnFromArgs(named(value), f, lineOf(n), tnorm.includes('jthread') ? 'std::jthread' : 'std::thread', depth);
        continue;
      }
      if (value && (value.type === 'argument_list' || value.type === 'initializer_list') && tnorm && !CPP_PRIMITIVES.has(tnorm) && !tnorm.startsWith('std::')) {
        const parts = tnorm.split('::');
        this.calls.push({
          caller: f.key,
          form: 'new',
          name: parts[parts.length - 1],
          qualifier: parts.length > 1 ? parts.slice(0, -1) : undefined,
          line: lineOf(n),
          args: argTexts(value),
          instantiate: true,
        });
      }
      if (value) this.body(value, f, depth + 1);
    }
  }

  private inferExprType(v: Node): string | undefined {
    if (v.type === 'new_expression') {
      const t = v.childForFieldName('type');
      return t ? qualifiedParts(t).join('::') : undefined;
    }
    if (v.type === 'call_expression') {
      const fn = v.childForFieldName('function');
      if (!fn) return undefined;
      const tmpl = fn.type === 'template_function' ? fn : fn.type === 'qualified_identifier' ? named(fn).find((c) => c.type === 'template_function') : undefined;
      if (tmpl) {
        const nm = tmpl.childForFieldName('name')?.text ?? '';
        if (/^make_(unique|shared)$/.test(nm)) {
          const arg = tmpl.childForFieldName('arguments');
          const first = named(arg)[0];
          if (first) return normCppType(first.text);
        }
      }
      if (fn.type === 'identifier' || fn.type === 'qualified_identifier') {
        // `auto x = Router(…)` or `auto x = net::Router(…)`: functional cast if it names a class (verified by linker)
        return qualifiedParts(fn).join('::');
      }
    }
    return undefined;
  }

  private call(n: Node, f: FnCtx, depth: number): void {
    const fn = n.childForFieldName('function');
    const argList = n.childForFieldName('arguments');
    const args = named(argList).filter((a) => a.type !== 'comment');
    const line = lineOf(n);
    const argT = argTexts(argList);
    let skipArgs = false;

    if (fn) {
      switch (fn.type) {
        case 'identifier': {
          const name = fn.text;
          if ((name === 'pthread_create' || name === 'CreateThread' || name === '_beginthreadex') && args.length >= 3) {
            this.spawnRef(args[2], f, line, name, depth);
            skipArgs = true;
          } else if (name === '_beginthread' && args.length >= 1) {
            this.spawnRef(args[0], f, line, name, depth);
            skipArgs = true;
          } else if (name === 'thrd_create' && args.length >= 2) {
            this.spawnRef(args[1], f, line, name, depth);
            skipArgs = true;
          } else {
            this.calls.push({ caller: f.key, form: 'plain', name, line, args: argT });
          }
          break;
        }
        case 'qualified_identifier':
        case 'template_function': {
          const parts = qualifiedParts(fn);
          const name = parts[parts.length - 1];
          const full = parts.join('::');
          if (/^(std::)?(thread|jthread|async)$/.test(full) || full === 'boost::thread') {
            this.spawnFromArgs(args, f, line, full.startsWith('std::') ? full : 'std::' + full, depth);
            skipArgs = true;
          } else if (/^(std::)?make_(unique|shared)$/.test(full)) {
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
          } else if (parts.length === 1) {
            this.calls.push({ caller: f.key, form: 'plain', name, line, args: argT });
          } else {
            this.calls.push({ caller: f.key, form: 'qualified', name, qualifier: parts.slice(0, -1), line, args: argT });
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
                receiverType = raw ? elemCppType(raw) : undefined;
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
            (/\bthread\b/.test(rawRecvType) || (!rawRecvType && args.length >= 1))
          ) {
            this.spawnRef(first, f, line, rawRecvType ? 'std::thread' : 'thread (emplace)', depth, args.slice(1), rawRecvType ? undefined : qualifier.join('.'));
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

  private spawnFromArgs(args: Node[], f: FnCtx, line: number, via: string, depth: number): void {
    let i = 0;
    if (args[0] && /launch::/.test(args[0].text)) i = 1; // std::async(std::launch::async, fn, ...)
    const target = args[i];
    if (target) this.spawnRef(target, f, line, via, depth, args.slice(i + 1));
    for (const a of args.slice(i + 1)) this.body(a, f, depth + 1);
  }

  /** A function *reference* handed to a thread API: `worker`, `&Router::rxLoop`, a lambda, std::bind(...). */
  private spawnRef(node: Node, f: FnCtx, line: number, via: string, depth: number, rest?: Node[], spawnRecv?: string): void {
    let n = node;
    if (n.type === 'pointer_expression') n = n.childForFieldName('argument') ?? n;
    if (n.type === 'parenthesized_expression') n = named(n)[0] ?? n;
    if (n.type === 'cast_expression') n = n.childForFieldName('value') ?? n;
    const args = rest?.length ? rest.map((a) => clip(a.text, 32)) : undefined;
    switch (n.type) {
      case 'identifier':
        this.calls.push({ caller: f.key, form: 'plain', name: n.text, line, args, spawn: via, spawnRecv });
        return;
      case 'qualified_identifier':
      case 'template_function': {
        const parts = qualifiedParts(n);
        this.calls.push({
          caller: f.key,
          form: parts.length > 1 ? 'qualified' : 'plain',
          name: parts[parts.length - 1],
          qualifier: parts.length > 1 ? parts.slice(0, -1) : undefined,
          line,
          args,
          spawn: via,
          spawnRecv,
        });
        return;
      }
      case 'lambda_expression': {
        const before = this.calls.length;
        const b = n.childForFieldName('body');
        if (b) this.body(b, f, depth + 1);
        for (let i = before; i < this.calls.length; i++) {
          const c = this.calls[i];
          if (!c.instantiate && !c.spawn) {
            c.spawn = via + ' (lambda)';
            c.spawnRecv = spawnRecv;
          }
        }
        return;
      }
      case 'call_expression': {
        // std::bind(&C::m, this, ...)
        const fn = n.childForFieldName('function');
        if (fn && /(^|::)bind$/.test(fn.text)) {
          const inner = named(n.childForFieldName('arguments'))[0];
          if (inner) this.spawnRef(inner, f, line, via, depth, undefined, spawnRecv);
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
