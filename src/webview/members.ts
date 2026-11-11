/**
 * Where each member of a class is read and written in code.
 *
 * Functions carry the member chains their bodies use (`Entity.uses`, from the extractors): the base is `this` /
 * `self`, or a parameter or local of a known type, followed by member names (`cfg.link.peer.port`). Each step is
 * looked up in the class it has reached — its own members first, then its base classes — and the next class is
 * the member's type, looked up the way `usage.ts` looks up any type name (scopes, imports, includes). A chain stops
 * where a type is not known (`auto`, templates, a container element); what it reached so far still counts.
 * Every step on the way is read; the last one is written when the code assigns to it, increments it or takes its
 * address.
 */
import type { CodeGraph, Entity, MemberUse, Param } from '../core/model';
import { TypeIndex, writerOf } from './usage';

export interface MemberSite {
  /** The function using the member. */
  fn: string;
  write: boolean;
  /** 1-based lines in the function's file. */
  lines: number[];
}

export class MemberIndex {
  /** class id → member name → sites */
  private byClass = new Map<string, Map<string, MemberSite[]>>();
  private entities = new Map<string, Entity>();
  private bases = new Map<string, string[]>();
  private fieldType = new Map<string, string | undefined>();

  constructor(g: CodeGraph, private index = new TypeIndex(g)) {
    for (const e of g.entities) this.entities.set(e.id, e);
    for (const r of g.relations) if (r.kind === 'inherit') (this.bases.get(r.from) ?? this.bases.set(r.from, []).get(r.from)!).push(r.to);
    for (const e of g.entities) if (e.kind === 'function' && e.uses) for (const u of e.uses) this.walk(e, u);
  }

  /** Member name → where it is used, for one class. */
  of(cls: string): Map<string, MemberSite[]> {
    return this.byClass.get(cls) ?? new Map();
  }

  private walk(fn: Entity, u: MemberUse): void {
    let cur = u.self ? this.classOf(fn) : u.type ? this.typeOf(u.type, fn) : undefined;
    for (let i = 0; i < u.path.length && cur; i++) {
      const hit = this.member(cur, u.path[i]);
      if (!hit) return; // a method, or a bare name that is not a member after all
      this.add(hit.owner, u.path[i], fn.id, !!u.write && i === u.path.length - 1, u.lines);
      cur = hit.field.type ? this.memberClass(hit.owner, hit.field) : undefined;
    }
  }

  /** The class a function runs in: its parent class, or the class of an enclosing function (a lambda's method). */
  private classOf(fn: Entity): string | undefined {
    for (let p = fn.parent ? this.entities.get(fn.parent) : undefined, k = 0; p && k < 8; p = p.parent ? this.entities.get(p.parent) : undefined, k++) {
      if (p.kind === 'class') return p.id;
    }
    return undefined;
  }

  private typeOf(type: string, writer: Entity): string | undefined {
    return [...this.index.classesIn(type, writerOf(writer))][0];
  }

  /** The class a member's type names, looked up from inside the class holding it. */
  private memberClass(owner: string, f: Param): string | undefined {
    const key = owner + '\u0001' + f.name;
    if (!this.fieldType.has(key)) {
      const e = this.entities.get(owner);
      this.fieldType.set(key, e && f.type ? this.typeOf(f.type, e) : undefined);
    }
    return this.fieldType.get(key);
  }

  /** A data member called `name` of `cls` or of one of its base classes. */
  private member(cls: string, name: string, depth = 0): { owner: string; field: Param } | undefined {
    const field = this.entities.get(cls)?.fields?.find((f) => f.name === name);
    if (field) return { owner: cls, field };
    if (depth > 5) return undefined;
    for (const b of this.bases.get(cls) ?? []) {
      const hit = this.member(b, name, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }

  private add(cls: string, name: string, fn: string, write: boolean, lines: number[]): void {
    const members = this.byClass.get(cls) ?? this.byClass.set(cls, new Map()).get(cls)!;
    const sites = members.get(name) ?? members.set(name, []).get(name)!;
    const same = sites.find((s) => s.fn === fn && s.write === write);
    if (same) {
      for (const l of lines) if (!same.lines.includes(l)) same.lines.push(l);
      same.lines.sort((a, b) => a - b);
    } else sites.push({ fn, write, lines: [...lines] });
  }
}
