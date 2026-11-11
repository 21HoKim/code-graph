/**
 * Python fact extractor (tree-sitter-python).
 */
import type { Node } from 'web-tree-sitter';
import type { Param, RawAccess, RawCall, RawEntity, RawImport, ScopeKind } from '../model';
import { AccessLog, KeyRegistry, argTexts, clip, endLineOf, lineOf, named, ownReturns, type ReturnRules } from './common';

/** A function's own returns and yields: nested functions, lambdas and classes inside it return for themselves. */
const PY_RETURNS: ReturnRules = {
  returns: new Set(['return_statement', 'yield']),
  stops: new Set(['function_definition', 'class_definition', 'lambda', 'decorated_definition']),
};

interface Scope {
  names: string[];
  kinds: ScopeKind[];
  parentKey?: string;
  /** Nearest enclosing class (for `self.x = Foo()` field typing). */
  cls?: RawEntity;
}

interface FnCtx {
  key: string;
  locals: Map<string, string>;
  /** `self` inside methods: attribute assignments go to this class. */
  selfClass?: RawEntity;
}

export interface PyFacts {
  entities: RawEntity[];
  calls: RawCall[];
  imports: RawImport[];
  accesses: RawAccess[];
  boundNames: string[];
  wildcardImport: boolean;
  mainGuard: boolean;
}

const MAX_DEPTH = 600;
const EXECUTOR_TYPES = /(ThreadPoolExecutor|ProcessPoolExecutor|ThreadPool|Pool|Executor)$/;
const EXECUTOR_NAMES = /(pool|executor)$|^ex$|^tp$/i;

export function extractPython(root: Node): PyFacts {
  const x = new PyExtractor();
  const moduleCtx: FnCtx = { key: '', locals: new Map() };
  x.block(named(root), { names: [], kinds: [] }, moduleCtx, 0);
  const b = collectBindings(root);
  return { entities: x.entities, calls: x.calls, imports: x.imports, accesses: x.access.list, boundNames: [...b.names], wildcardImport: b.wildcard, mainGuard: b.mainGuard };
}

/**
 * Every name the module binds anywhere (any scope). Deliberately over-approximate: a call to a name that is
 * not in this set, not a builtin and not star-imported is a guaranteed NameError when it runs.
 */
function collectBindings(root: Node): { names: Set<string>; wildcard: boolean; mainGuard: boolean } {
  const names = new Set<string>();
  let wildcard = false;
  let mainGuard = false;
  const targets = (n: Node | null): void => {
    if (!n) return;
    if (n.type === 'identifier') names.add(n.text);
    else if (n.type !== 'attribute' && n.type !== 'subscript') for (const c of named(n)) targets(c);
  };
  const walk = (n: Node, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    switch (n.type) {
      case 'function_definition':
      case 'class_definition':
        targets(n.childForFieldName('name'));
        break;
      case 'parameters':
      case 'lambda_parameters':
        for (const p of named(n)) {
          if (p.type === 'identifier') names.add(p.text);
          else {
            targets(p.childForFieldName('name'));
            for (const c of named(p)) if (c.type === 'identifier' || c.type.endsWith('splat_pattern')) targets(c);
          }
        }
        break;
      case 'assignment':
      case 'augmented_assignment':
      case 'for_statement':
      case 'for_in_clause':
        targets(n.childForFieldName('left'));
        break;
      case 'named_expression':
        targets(n.childForFieldName('name'));
        break;
      case 'as_pattern':
        targets(n.childForFieldName('alias'));
        break;
      case 'except_clause':
        for (let i = 0; i < n.childCount - 1; i++) if (n.child(i)?.type === 'as') targets(n.child(i + 1));
        break;
      case 'import_statement':
        for (const c of named(n)) {
          if (c.type === 'dotted_name') names.add(c.text.split('.')[0]);
          else if (c.type === 'aliased_import') targets(c.childForFieldName('alias'));
        }
        break;
      case 'import_from_statement':
        for (const c of n.childrenForFieldName('name')) {
          if (!c) continue;
          if (c.type === 'dotted_name') names.add(c.text.split('.')[0]);
          else if (c.type === 'aliased_import') targets(c.childForFieldName('alias') ?? c.childForFieldName('name'));
        }
        if (named(n).some((c) => c.type === 'wildcard_import')) wildcard = true;
        break;
      case 'global_statement':
      case 'nonlocal_statement':
        for (const c of named(n)) if (c.type === 'identifier') names.add(c.text);
        break;
      case 'if_statement':
        if (n.parent?.type === 'module' && /__name__\s*==\s*['"]__main__['"]|['"]__main__['"]\s*==\s*__name__/.test(n.childForFieldName('condition')?.text ?? '')) {
          mainGuard = true;
        }
        break;
    }
    for (const c of named(n)) walk(c, depth + 1);
  };
  walk(root, 0);
  return { names, wildcard, mainGuard };
}

/** a.b.c as a list of names, or undefined if the expression is not a plain dotted path. */
function dotted(n: Node | null): string[] | undefined {
  if (!n) return undefined;
  if (n.type === 'identifier') return [n.text];
  if (n.type === 'attribute') {
    const o = dotted(n.childForFieldName('object'));
    const a = n.childForFieldName('attribute');
    return o && a ? [...o, a.text] : undefined;
  }
  return undefined;
}

function parseParams(list: Node | null, isMethod: boolean): Param[] {
  const out: Param[] = [];
  for (const p of named(list)) {
    switch (p.type) {
      case 'identifier':
        out.push({ name: p.text });
        break;
      case 'typed_parameter': {
        const id = named(p).find((c) => c.type === 'identifier' || c.type.endsWith('splat_pattern'));
        out.push({ name: id?.text, type: clip(p.childForFieldName('type')?.text ?? '', 160) || undefined });
        break;
      }
      case 'default_parameter':
        out.push({ name: p.childForFieldName('name')?.text });
        break;
      case 'typed_default_parameter':
        out.push({ name: p.childForFieldName('name')?.text, type: clip(p.childForFieldName('type')?.text ?? '', 160) || undefined });
        break;
      case 'list_splat_pattern':
      case 'dictionary_splat_pattern':
        out.push({ name: p.text });
        break;
    }
  }
  if (isMethod && out.length && (out[0].name === 'self' || out[0].name === 'cls')) out.shift();
  return out;
}

/** Best-effort class name produced by an expression: `Foo(...)`, `mod.Foo(...)`. */
function constructedType(v: Node | null): string | undefined {
  if (!v) return undefined;
  if (v.type === 'await') return constructedType(named(v)[0] ?? null);
  if (v.type !== 'call') return undefined;
  const d = dotted(v.childForFieldName('function'));
  if (!d) return undefined;
  const last = d[d.length - 1];
  // Heuristic: PEP 8 class names are CapWords. Lower-case calls are factories we cannot type.
  return /^[A-Z]/.test(last) ? d.join('.') : undefined;
}

class PyExtractor {
  entities: RawEntity[] = [];
  calls: RawCall[] = [];
  imports: RawImport[] = [];
  access = new AccessLog();
  private keys = new KeyRegistry();

  block(nodes: Node[], scope: Scope, f: FnCtx, depth: number): void {
    for (const n of nodes) this.visit(n, scope, f, depth);
  }

  visit(n: Node, scope: Scope, f: FnCtx, depth: number, decorators?: string[]): void {
    if (depth > MAX_DEPTH) return;
    switch (n.type) {
      case 'import_statement':
        for (const c of named(n)) {
          if (c.type === 'dotted_name') this.imports.push({ module: c.text, level: 0, line: lineOf(n) });
          else if (c.type === 'aliased_import') {
            this.imports.push({
              module: c.childForFieldName('name')?.text ?? '',
              level: 0,
              alias: c.childForFieldName('alias')?.text,
              line: lineOf(n),
            });
          }
        }
        return;
      case 'import_from_statement': {
        const mod = n.childForFieldName('module_name');
        let module = '';
        let level = 0;
        if (mod?.type === 'relative_import') {
          const prefix = named(mod).find((c) => c.type === 'import_prefix');
          level = prefix ? prefix.text.replace(/\s/g, '').length : 1;
          module = named(mod).find((c) => c.type === 'dotted_name')?.text ?? '';
        } else if (mod) module = mod.text;
        const names: { name: string; alias?: string }[] = [];
        for (const c of n.childrenForFieldName('name')) {
          if (!c) continue;
          if (c.type === 'dotted_name') names.push({ name: c.text });
          else if (c.type === 'aliased_import') {
            names.push({ name: c.childForFieldName('name')?.text ?? '', alias: c.childForFieldName('alias')?.text });
          }
        }
        if (named(n).some((c) => c.type === 'wildcard_import')) names.push({ name: '*' });
        this.imports.push({ module, level, names, line: lineOf(n) });
        return;
      }
      case 'decorated_definition': {
        const decos = named(n)
          .filter((c) => c.type === 'decorator')
          .map((d) => d.text.replace(/^@\s*/, '').split('(')[0].trim());
        const def = n.childForFieldName('definition');
        if (def) this.visit(def, scope, f, depth + 1, decos);
        return;
      }
      case 'class_definition':
        this.klass(n, scope, f, depth, decorators);
        return;
      case 'function_definition':
        this.fn(n, scope, f, depth, decorators);
        return;
      case 'call':
        this.call(n, scope, f, depth);
        return;
      case 'assignment':
      case 'augmented_assignment':
        this.assign(n, f);
        break; // also visit children (calls on the right-hand side)
      case 'as_pattern': {
        // with Foo() as x:
        const value = named(n)[0] ?? null;
        const alias = n.childForFieldName('alias');
        const t = constructedType(value);
        const id = alias ? named(alias).find((c) => c.type === 'identifier') ?? alias : undefined;
        if (t && id && id.type === 'identifier') f.locals.set(id.text, t);
        break;
      }
      case 'lambda': {
        const b = n.childForFieldName('body');
        if (b) this.visit(b, scope, f, depth + 1);
        return;
      }
      case 'attribute': {
        const base = this.attrChain(n, f);
        if (base) this.visit(base, scope, f, depth + 1);
        return;
      }
    }
    for (const c of named(n)) this.visit(c, scope, f, depth + 1);
  }

  /**
   * `self.cfg.port`, `conn.peer.host = …`: records which attributes the chain reads (or writes, for the last one)
   * and returns the expression it starts from when that is not a plain name (`make().x`), to visit it.
   */
  private attrChain(n: Node, f: FnCtx): Node | null {
    const path: string[] = [];
    let cur: Node | null = n;
    while (cur?.type === 'attribute') {
      const a = cur.childForFieldName('attribute');
      if (!a) return null;
      path.unshift(a.text);
      cur = cur.childForFieldName('object');
    }
    if (!cur) return null;
    if (cur.type !== 'identifier') return cur;
    const p = n.parent;
    const same = (x: Node | null) => !!x && x.startIndex === n.startIndex && x.endIndex === n.endIndex;
    const write = !!p && (p.type === 'assignment' || p.type === 'augmented_assignment') && same(p.childForFieldName('left'));
    const line = lineOf(n);
    if ((cur.text === 'self' || cur.text === 'cls') && f.selfClass) this.access.add(f.key, { self: true, path, write }, line);
    else {
      const type = f.locals.get(cur.text);
      if (type) this.access.add(f.key, { type, path, write }, line);
    }
    return null;
  }

  private klass(n: Node, scope: Scope, outer: FnCtx, depth: number, decorators?: string[]): void {
    const name = n.childForFieldName('name')?.text;
    if (!name) return;
    const bases: string[] = [];
    for (const b of named(n.childForFieldName('superclasses'))) {
      if (b.type === 'keyword_argument' || b.type === 'comment') continue;
      const d = dotted(b);
      if (d) bases.push(d.join('.'));
    }
    const key = this.keys.unique([...scope.names, name].join('.'));
    const ent: RawEntity = {
      key,
      kind: 'class',
      sub: 'class',
      name,
      scope: scope.names,
      scopeKinds: scope.kinds,
      parentKey: scope.parentKey,
      line: lineOf(n),
      endLine: endLineOf(n),
      isDefinition: true,
      bases: bases.length ? bases : undefined,
      flags: decorators?.length ? decorators.map((d) => '@' + d) : undefined,
      fields: {},
    };
    this.entities.push(ent);
    const inner: Scope = { names: [...scope.names, name], kinds: [...scope.kinds, 'class'], parentKey: key, cls: ent };
    const body = n.childForFieldName('body');
    // Class-body statements run at import time: attribute them to the enclosing code.
    for (const c of named(body)) {
      if (c.type === 'expression_statement') {
        const a = named(c)[0];
        // `x: Foo` / `x: Foo = ...` class attribute annotations
        if (a?.type === 'assignment') {
          const left = a.childForFieldName('left');
          const t = a.childForFieldName('type');
          if (left?.type === 'identifier' && t) {
            ent.fields![left.text] = t.text.replace(/^["']|["']$/g, '');
            addMember(ent, left.text, ent.fields![left.text]);
          }
        }
      }
      this.visit(c, inner, outer, depth + 1);
    }
  }

  private fn(n: Node, scope: Scope, _outer: FnCtx, depth: number, decorators?: string[]): void {
    const name = n.childForFieldName('name')?.text;
    if (!name) return;
    const inClass = scope.kinds[scope.kinds.length - 1] === 'class';
    const isStatic = !!decorators?.includes('staticmethod');
    const params = parseParams(n.childForFieldName('parameters'), inClass && !isStatic);
    const flags = new Set<string>();
    for (let i = 0; i < n.childCount; i++) if (n.child(i)?.type === 'async') flags.add('async');
    for (const d of decorators ?? []) {
      if (d === 'staticmethod' || d === 'classmethod' || d === 'property' || d.endsWith('abstractmethod')) {
        flags.add(d.replace(/^.*\./, ''));
      } else flags.add('@' + d);
    }
    // a body that only raises NotImplementedError (after an optional docstring) is a stub
    const stmts = named(n.childForFieldName('body')).filter((c) => c.type !== 'comment');
    const real = stmts.filter((c, i) => !(i === 0 && c.type === 'expression_statement' && named(c)[0]?.type === 'string'));
    if (real.length === 1 && real[0].type === 'raise_statement' && /\bNotImplementedError\b/.test(real[0].text)) flags.add('notImplemented');
    const key = this.keys.unique([...scope.names, name].join('.'));
    const ent: RawEntity = {
      key,
      kind: 'function',
      sub: inClass ? (name === '__init__' ? 'ctor' : 'method') : 'function',
      name,
      scope: scope.names,
      scopeKinds: scope.kinds,
      parentKey: scope.parentKey,
      line: lineOf(n.parent?.type === 'decorated_definition' ? n.parent : n),
      endLine: endLineOf(n),
      isDefinition: true,
      params,
      returns: clip(n.childForFieldName('return_type')?.text ?? '', 160) || undefined,
      rets: ownReturns(n.childForFieldName('body'), PY_RETURNS),
      flags: flags.size ? [...flags] : undefined,
    };
    this.entities.push(ent);
    const ctx: FnCtx = { key, locals: new Map(), selfClass: inClass ? scope.cls : undefined };
    for (const p of params) if (p.name && p.type) ctx.locals.set(p.name, p.type.replace(/^["']|["']$/g, ''));
    const inner: Scope = { names: [...scope.names, name], kinds: [...scope.kinds, 'function'], parentKey: key, cls: scope.cls };
    const body = n.childForFieldName('body');
    if (body) this.block(named(body), inner, ctx, depth + 1);
  }

  private assign(n: Node, f: FnCtx): void {
    const left = n.childForFieldName('left');
    const right = n.childForFieldName('right');
    const annot = n.childForFieldName('type');
    // `self.cfg = cfg` takes the type of the parameter or local it is given
    const t = annot ? annot.text.replace(/^["']|["']$/g, '') : constructedType(right) ?? (right?.type === 'identifier' ? f.locals.get(right.text) : undefined);
    if (!left) return;
    // every `self.x = …` is a member, typed when the value tells
    if (left.type === 'attribute' && f.selfClass) {
      const obj = left.childForFieldName('object');
      const attr = left.childForFieldName('attribute');
      if (obj?.text === 'self' && attr) addMember(f.selfClass, attr.text, t);
    }
    if (!t) return;
    if (left.type === 'identifier') f.locals.set(left.text, t);
    else if (left.type === 'attribute' && f.selfClass) {
      const obj = left.childForFieldName('object');
      const attr = left.childForFieldName('attribute');
      if (obj?.text === 'self' && attr) f.selfClass.fields![attr.text] = t;
    }
  }

  private call(n: Node, scope: Scope, f: FnCtx, depth: number): void {
    const fn = n.childForFieldName('function');
    const argList = n.childForFieldName('arguments');
    const all = named(argList).filter((a) => a.type !== 'comment');
    const pos = all.filter((a) => a.type !== 'keyword_argument' && a.type !== 'dictionary_splat' && a.type !== 'list_splat');
    const kw = new Map<string, Node>();
    for (const a of all) {
      if (a.type !== 'keyword_argument') continue;
      const k = a.childForFieldName('name')?.text;
      const v = a.childForFieldName('value');
      if (k && v) kw.set(k, v);
    }
    const line = lineOf(n);
    const args = argTexts(argList);
    const consumed = new Set<Node>();
    const spawn = (target: Node | undefined, via: string, isCall = false) => {
      if (!target) return;
      consumed.add(target);
      this.spawnRef(target, scope, f, line, via, depth, isCall);
    };

    if (fn?.type === 'identifier') {
      const name = fn.text;
      if ((name === 'Thread' || name === 'Process') && kw.has('target')) spawn(kw.get('target'), name);
      else if (name === 'Timer') spawn(kw.get('function') ?? pos[1], 'Timer');
      else if (name === 'start_new_thread') spawn(pos[0], '_thread.start_new_thread');
      else if (name === 'create_task' || name === 'ensure_future') spawn(pos[0], 'asyncio.' + name, true);
      else this.calls.push({ caller: f.key, form: 'plain', name, line, args });
    } else if (fn?.type === 'attribute') {
      const obj = fn.childForFieldName('object');
      const attr = fn.childForFieldName('attribute')?.text ?? '';
      const path = dotted(obj);
      const recvName = path?.[path.length - 1] ?? '';
      // Foo().method(): the receiver is a fresh Foo
      const recvType = path && path.length === 1 ? f.locals.get(path[0]) : !path && obj?.type === 'call' ? constructedType(obj) : undefined;
      const isExecutor = EXECUTOR_TYPES.test(recvType ?? '') || EXECUTOR_NAMES.test(recvName);
      if ((attr === 'Thread' || attr === 'Process') && kw.has('target')) spawn(kw.get('target'), `${path?.join('.') ?? ''}.${attr}`);
      else if (attr === 'Timer' && (path?.[0] === 'threading' || pos.length >= 2)) spawn(kw.get('function') ?? pos[1], 'threading.Timer');
      else if (attr === 'start_new_thread') spawn(pos[0], '_thread.start_new_thread');
      else if ((attr === 'create_task' || attr === 'ensure_future') && pos[0]) spawn(pos[0], 'asyncio.' + attr, true);
      else if (attr === 'gather' && path?.[0] === 'asyncio') for (const p of pos) spawn(p, 'asyncio.gather', true);
      else if (attr === 'run_in_executor' && pos[1]) spawn(pos[1], 'run_in_executor');
      else if (attr === 'to_thread' && path?.[0] === 'asyncio' && pos[0]) spawn(pos[0], 'asyncio.to_thread');
      else if ((attr === 'submit' || attr === 'apply_async') && pos[0] && (isExecutor || attr === 'apply_async')) spawn(pos[0], `${recvType ?? recvName}.${attr}`);
      else if ((attr === 'map' || attr === 'imap' || attr === 'imap_unordered' || attr === 'starmap') && isExecutor && pos[0]) {
        spawn(pos[0], `${recvType ?? recvName}.${attr}`);
      } else if (obj?.type === 'call' && obj.childForFieldName('function')?.text === 'super') {
        this.calls.push({ caller: f.key, form: 'super', name: attr, line, args });
      } else {
        this.calls.push({ caller: f.key, form: 'member', name: attr, qualifier: path ?? (recvType ? ['()'] : ['?']), receiverType: recvType, line, args });
      }
      if (obj && obj.type !== 'identifier') this.visit(obj, scope, f, depth + 1);
    } else if (fn) {
      this.visit(fn, scope, f, depth + 1);
    }
    for (const a of all) {
      if (consumed.has(a)) continue;
      if (a.type === 'keyword_argument') {
        const v = a.childForFieldName('value');
        if (v && !consumed.has(v)) this.visit(v, scope, f, depth + 1);
      } else this.visit(a, scope, f, depth + 1);
    }
  }

  /** A callable handed to a thread/task API: `worker`, `self.loop`, `lambda: ...`, `coro(x)`, `partial(f, ...)`. */
  private spawnRef(t: Node, scope: Scope, f: FnCtx, line: number, via: string, depth: number, isCall: boolean): void {
    let target = t;
    if (isCall || target.type === 'call') {
      if (target.type !== 'call') return;
      const callee = target.childForFieldName('function');
      if (callee && /(^|\.)partial$/.test(callee.text)) {
        const first = named(target.childForFieldName('arguments'))[0];
        if (first) this.spawnRef(first, scope, f, line, via, depth, false);
        return;
      }
      // the coroutine call itself: create_task(fetch(url)) spawns fetch
      const args = argTexts(target.childForFieldName('arguments'));
      for (const a of named(target.childForFieldName('arguments'))) this.visit(a, scope, f, depth + 1);
      if (!callee) return;
      target = callee;
      this.pushRef(target, f, line, via, args);
      return;
    }
    if (target.type === 'lambda') {
      const before = this.calls.length;
      const b = target.childForFieldName('body');
      if (b) this.visit(b, scope, f, depth + 1);
      for (let i = before; i < this.calls.length; i++) if (!this.calls[i].spawn) this.calls[i].spawn = via + ' (lambda)';
      return;
    }
    this.pushRef(target, f, line, via, undefined);
  }

  private pushRef(target: Node, f: FnCtx, line: number, via: string, args: string[] | undefined): void {
    const path = dotted(target);
    if (!path) return;
    if (path.length === 1) {
      this.calls.push({ caller: f.key, form: 'plain', name: path[0], line, args, spawn: via });
    } else {
      const q = path.slice(0, -1);
      this.calls.push({
        caller: f.key,
        form: 'member',
        name: path[path.length - 1],
        qualifier: q,
        receiverType: q.length === 1 ? f.locals.get(q[0]) : undefined,
        line,
        args,
        spawn: via,
      });
    }
  }
}

/** A data member for display: first sighting fixes its place, a later one may add the type. */
function addMember(cls: RawEntity, name: string, type?: string): void {
  const list = (cls.members ??= []);
  const had = list.find((m) => m.name === name);
  if (!had) list.push({ name, type: type || undefined });
  else if (!had.type && type) had.type = type;
}
