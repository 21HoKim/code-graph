/**
 * Where a class's objects live: as members of other classes, as parameters, as return values.
 *
 * Types are written as code writes them — `billing::Customer`, `Address`, `Aggregator`,
 * `std::vector<std::unique_ptr<Interface>>` — so each name in a type is looked up the way the language would:
 * from the scope it is written in outwards (inside class `shop::billing::Customer`, `Address` is
 * `shop::billing::Address` before `shop::Address` or `Address`), then, if nothing matches, as the one class
 * with that name. Two classes called `Address` in different namespaces stay apart.
 */
import type { CodeGraph, Entity } from '../core/model';

export interface TypeUse {
  /** The class holding it, or the function taking / returning it. */
  id: string;
  /** Member or parameter name, when there is one. */
  name?: string;
  /** The type as written. */
  type: string;
}

export interface TypeUsages {
  holders: TypeUse[];
  takers: TypeUse[];
  givers: TypeUse[];
}

const NAME = /(?:::)?[A-Za-z_]\w*(?:(?:::|\.)[A-Za-z_]\w*)*/g;

function sepOf(e: Entity): string {
  return e.lang === 'python' ? '.' : '::';
}

/** Scopes a name written inside `qname` is looked up in, innermost first, ending with the global one (''). */
export function scopesOf(qname: string, sep: string, includeSelf: boolean): string[] {
  const parts = qname.split(sep);
  const out: string[] = [];
  for (let n = includeSelf ? parts.length : parts.length - 1; n >= 0; n--) out.push(parts.slice(0, n).join(sep));
  return out;
}

/** Where a name is written: the scopes to look it up in (innermost first) and the file, for imports and includes. */
export interface Writer {
  scopes: string[];
  sep: string;
  file?: string;
}

/**
 * Index of classes by every name code may use for them: qualified name, and typedef aliases in the same scope.
 * Lookups follow the language: Python names go through the file's imports first, C/C++ names through the scopes;
 * when several classes still share the name (a `struct buffer` in two `.c` files), the one in the writing file
 * wins, then one in a file it includes, then one in a file including it.
 */
export class TypeIndex {
  private byQname = new Map<string, string[]>();
  private byName = new Map<string, string[]>();
  private entities = new Map<string, Entity>();
  private fileNames = new Map<string, Record<string, string>>();
  private includes = new Map<string, Set<string>>();
  private includedBy = new Map<string, Set<string>>();
  private closures = new Map<string, Set<string>>();

  constructor(g: CodeGraph) {
    const add = (m: Map<string, string[]>, k: string, id: string) => {
      const list = m.get(k) ?? [];
      if (!list.includes(id)) list.push(id);
      m.set(k, list);
    };
    for (const e of g.entities) {
      this.entities.set(e.id, e);
      if (e.kind !== 'class') continue;
      const sep = sepOf(e);
      const scope = e.qname.includes(sep) ? e.qname.slice(0, e.qname.lastIndexOf(sep)) : '';
      for (const n of [e.name, ...(e.aliases ?? [])]) {
        add(this.byQname, scope ? scope + sep + n : n, e.id);
        add(this.byName, n, e.id);
      }
    }
    for (const f of g.files) if (f.names) this.fileNames.set(f.path, f.names);
    for (const r of g.relations) {
      if (r.kind !== 'include') continue;
      const [a, b] = [r.from.slice(2), r.to.slice(2)];
      (this.includes.get(a) ?? this.includes.set(a, new Set()).get(a)!).add(b);
      (this.includedBy.get(b) ?? this.includedBy.set(b, new Set()).get(b)!).add(a);
    }
  }

  /** The class a name written by `w` refers to. */
  resolve(written: string, w: Writer): string | undefined {
    const { sep, file } = w;
    const name = written.replace(/^::/, '').split(/::|\./).join(sep);
    if (written.startsWith('::')) return this.pick(this.byQname.get(name), file);
    // Python: through the file's imports (`Config`, `AC` for `Config as AC`, `old.Config` for `import legacy as old`)
    const table = file ? this.fileNames.get(file) : undefined;
    if (table) {
      const parts = name.split(sep);
      for (let k = parts.length; k >= 1; k--) {
        const id = table[parts.slice(0, k).join(sep)];
        const e = id ? this.entities.get(id) : undefined;
        if (!e) continue;
        if (k === parts.length) return e.kind === 'class' ? e.id : undefined;
        return this.pick(this.byQname.get([e.qname, ...parts.slice(k)].join(sep)), file);
      }
    }
    for (const s of w.scopes) {
      const hit = this.pick(this.byQname.get(s ? s + sep + name : name), file);
      if (hit) return hit;
    }
    // not reachable from here by its scopes (a using-declaration, an unseen import): a class of that name
    return this.pick(this.byName.get(name.split(sep).pop()!), file);
  }

  /** One class of several with the same name: the writer's own file, then its includes, then its includers. */
  private pick(ids: string[] | undefined, file: string | undefined): string | undefined {
    if (!ids?.length) return undefined;
    if (ids.length === 1) return ids[0];
    if (!file) return undefined;
    const inc = this.closure(file);
    const tiers: ((f: string) => boolean)[] = [(f) => f === file, (f) => inc.has(f), (f) => !!this.includedBy.get(file)?.has(f)];
    for (const tier of tiers) {
      const hit = ids.filter((id) => tier(this.entities.get(id)?.def?.file ?? ''));
      if (hit.length === 1) return hit[0];
      if (hit.length) return undefined;
    }
    return undefined;
  }

  private closure(file: string): Set<string> {
    let seen = this.closures.get(file);
    if (seen) return seen;
    seen = new Set();
    const todo = [file];
    while (todo.length) for (const n of this.includes.get(todo.pop()!) ?? []) if (!seen.has(n)) (seen.add(n), todo.push(n));
    this.closures.set(file, seen);
    return seen;
  }

  /** The classes a type (as written) mentions. */
  classesIn(type: string, w: Writer): Set<string> {
    const out = new Set<string>();
    for (const m of type.matchAll(NAME)) {
      const id = this.resolve(m[0], w);
      if (id) out.add(id);
    }
    return out;
  }
}

/** Where an entity writes the types of its members (a class) or its parameters and return type (a function). */
export function writerOf(e: Entity): Writer {
  const sep = sepOf(e);
  return { scopes: scopesOf(e.qname, sep, e.kind === 'class'), sep, file: e.def?.file ?? e.decl?.file };
}

export function typeUsages(g: CodeGraph, target: Entity, index = new TypeIndex(g)): TypeUsages {
  const out: TypeUsages = { holders: [], takers: [], givers: [] };
  for (const x of g.entities) {
    if (x.id === target.id) continue;
    if (x.kind === 'class') {
      // member types are looked up from inside the class
      const w = writerOf(x);
      for (const f of x.fields ?? []) {
        if (f.type && index.classesIn(f.type, w).has(target.id)) out.holders.push({ id: x.id, name: f.name, type: f.type });
      }
    } else if (x.kind === 'function' && x.parent !== target.id) {
      // parameter and return types are looked up from the function's class / namespace
      const w = writerOf(x);
      const p = (x.params ?? []).find((pp) => pp.type && index.classesIn(pp.type, w).has(target.id));
      if (p) out.takers.push({ id: x.id, name: p.name, type: p.type! });
      if (x.returns && index.classesIn(x.returns, w).has(target.id)) out.givers.push({ id: x.id, type: x.returns });
    }
  }
  return out;
}
