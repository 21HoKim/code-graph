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

/** Index of classes by every name code may use for them: qualified name, and typedef aliases in the same scope. */
export class TypeIndex {
  private byQname = new Map<string, string>();
  private byName = new Map<string, string[]>();

  constructor(g: CodeGraph) {
    for (const e of g.entities) {
      if (e.kind !== 'class') continue;
      const sep = sepOf(e);
      const scope = e.qname.includes(sep) ? e.qname.slice(0, e.qname.lastIndexOf(sep)) : '';
      for (const n of [e.name, ...(e.aliases ?? [])]) {
        this.byQname.set(scope ? scope + sep + n : n, e.id);
        const list = this.byName.get(n) ?? [];
        if (!list.includes(e.id)) list.push(e.id);
        this.byName.set(n, list);
      }
    }
  }

  /** The class a name written in `scopes` (innermost first) refers to. */
  resolve(written: string, scopes: string[], sep: string): string | undefined {
    const name = written.replace(/^::/, '').split(/::|\./).join(sep);
    if (written.startsWith('::')) return this.byQname.get(name);
    for (const s of scopes) {
      const hit = this.byQname.get(s ? s + sep + name : name);
      if (hit) return hit;
    }
    // not reachable from here by its scopes (a using-declaration, an import): the only class of that name
    const last = name.split(sep).pop()!;
    const all = this.byName.get(last);
    return all?.length === 1 ? all[0] : undefined;
  }

  /** The classes a type (as written) mentions. */
  classesIn(type: string, scopes: string[], sep: string): Set<string> {
    const out = new Set<string>();
    for (const m of type.matchAll(NAME)) {
      const id = this.resolve(m[0], scopes, sep);
      if (id) out.add(id);
    }
    return out;
  }
}

export function typeUsages(g: CodeGraph, target: Entity, index = new TypeIndex(g)): TypeUsages {
  const out: TypeUsages = { holders: [], takers: [], givers: [] };
  for (const x of g.entities) {
    if (x.id === target.id) continue;
    const sep = sepOf(x);
    if (x.kind === 'class') {
      // member types are looked up from inside the class
      const scopes = scopesOf(x.qname, sep, true);
      for (const f of x.fields ?? []) {
        if (f.type && index.classesIn(f.type, scopes, sep).has(target.id)) out.holders.push({ id: x.id, name: f.name, type: f.type });
      }
    } else if (x.kind === 'function' && x.parent !== target.id) {
      // parameter and return types are looked up from the function's class / namespace
      const scopes = scopesOf(x.qname, sep, false);
      const p = (x.params ?? []).find((pp) => pp.type && index.classesIn(pp.type, scopes, sep).has(target.id));
      if (p) out.takers.push({ id: x.id, name: p.name, type: p.type! });
      if (x.returns && index.classesIn(x.returns, scopes, sep).has(target.id)) out.givers.push({ id: x.id, type: x.returns });
    }
  }
  return out;
}
