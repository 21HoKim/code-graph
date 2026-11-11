/**
 * Linker: turns per-file facts into one CodeGraph.
 *
 * Resolution is static and heuristic (no compiler, no type checker), so every
 * relation carries a confidence:
 *   exact  – found by scoped name lookup (same class, namespace chain, imports)
 *   likely – needed a type inference step or a unique-by-name match
 *   guess  – several candidates, picked the nearest one
 * The view lets users hide guesses. A language-server pass can later upgrade
 * them (see docs/ROADMAP.md).
 */
import type {
  CallSite,
  CodeGraph,
  Confidence,
  Diagnostic,
  Entity,
  FileFacts,
  FileInfo,
  Loc,
  Param,
  RawCall,
  RawEntity,
  Relation,
  RelationKind,
} from './model';
import { COMMON_METHOD_NAMES } from './extract/common';

export interface LinkOptions {
  root: string;
  /** Extra include directories (workspace-relative) for #include resolution. */
  includePaths?: string[];
  /** Max call sites stored per relation. */
  maxSites?: number;
}

const PY_BUILTINS = new Set(
  (
    'print len range open isinstance issubclass super str int float list dict set tuple sorted enumerate zip map filter ' +
    'min max sum any all getattr setattr hasattr delattr type iter next repr abs round format id hash vars dir callable ' +
    'bytes bytearray memoryview object property staticmethod classmethod input ord chr divmod pow reversed slice ' +
    'frozenset complex bool exec eval compile globals locals breakpoint help NotImplementedError ValueError TypeError ' +
    'KeyError IndexError RuntimeError Exception OSError IOError StopIteration AttributeError AssertionError TimeoutError'
  ).split(' '),
);

/** Names that exist without being bound in the module (for the undefined-name check). */
const PY_BUILTIN_NAMES = new Set(
  (
    'abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex copyright ' +
    'credits delattr dict dir divmod enumerate eval exec exit filter float format frozenset getattr globals hasattr hash help ' +
    'hex id input int isinstance issubclass iter len license list locals map max memoryview min next object oct open ord pow ' +
    'print property quit range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip ' +
    '__import__ __build_class__ NotImplemented Ellipsis _ ' +
    'BaseException BaseExceptionGroup Exception ExceptionGroup ArithmeticError AssertionError AttributeError BlockingIOError ' +
    'BrokenPipeError BufferError BytesWarning ChildProcessError ConnectionAbortedError ConnectionError ConnectionRefusedError ' +
    'ConnectionResetError DeprecationWarning EOFError EncodingWarning EnvironmentError FileExistsError FileNotFoundError ' +
    'FloatingPointError FutureWarning GeneratorExit IOError ImportError ImportWarning IndentationError IndexError ' +
    'InterruptedError IsADirectoryError KeyError KeyboardInterrupt LookupError MemoryError ModuleNotFoundError NameError ' +
    'NotADirectoryError NotImplementedError OSError OverflowError PendingDeprecationWarning PermissionError ProcessLookupError ' +
    'PythonFinalizationError RecursionError ReferenceError ResourceWarning RuntimeError RuntimeWarning StopAsyncIteration ' +
    'StopIteration SyntaxError SyntaxWarning SystemError SystemExit TabError TimeoutError TypeError UnboundLocalError ' +
    'UnicodeDecodeError UnicodeEncodeError UnicodeError UnicodeTranslateError UnicodeWarning UserWarning ValueError Warning ' +
    'ZeroDivisionError WindowsError reveal_type reveal_locals'
  ).split(' '),
);

const CONF_RANK: Record<Confidence, number> = { exact: 3, likely: 2, guess: 1 };

interface Target {
  to: Entity;
  conf: Confidence;
}

interface FnRec {
  facts: FileFacts;
  raw: RawEntity;
  qname: string;
  parent?: Entity;
  sub: string;
}

interface PyBinding {
  /** Module entity id; undefined = external (unresolved) module. */
  module?: string;
  member?: string;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function stemOf(p: string): string {
  const b = p.slice(p.lastIndexOf('/') + 1);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
}

function joinNorm(a: string, b: string): string {
  const out: string[] = [];
  for (const part of (a ? a + '/' + b : b).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function sigOf(r: RawEntity): string {
  return (r.params ?? [])
    .map((p) => (p.type ?? '').replace(/\b(const|volatile)\b/g, '').replace(/\s+/g, ''))
    .join(',');
}

export function link(all: FileFacts[], opts: LinkOptions): CodeGraph {
  return new Linker(all, opts).run();
}

class Linker {
  private t0 = Date.now();
  private entities = new Map<string, Entity>();
  private rawToEntity = new Map<string, Entity>();
  private relations = new Map<string, Relation>();
  private files: FileInfo[] = [];
  private filePaths = new Set<string>();
  private cc: FileFacts[] = [];
  private py: FileFacts[] = [];
  private warnings: string[] = [];
  private diags: Diagnostic[] = [];
  private factsByPath = new Map<string, FileFacts>();
  private callSites = 0;
  private resolved = 0;
  private unresolved = 0;
  private maxSites: number;

  // C-family indices
  private ccClassByQname = new Map<string, Entity[]>();
  private ccClassesByName = new Map<string, Entity[]>();
  private ccFnByQname = new Map<string, Entity[]>();
  private ccFnsByName = new Map<string, Entity[]>();
  private ccMethodsByName = new Map<string, Entity[]>();
  private members = new Map<string, Map<string, Entity[]>>(); // parent id -> name -> children
  private basesOf = new Map<string, string[]>();
  private fieldsOf = new Map<string, Record<string, string>>();
  private classRaw = new Map<string, { raw: RawEntity; facts: FileFacts }>();
  private includesOf = new Map<string, Set<string>>();
  private namespaces = new Set<string>();

  // Python indices
  private pyModuleOfFile = new Map<string, Entity>();
  private pyModuleByQname = new Map<string, Entity[]>();
  private pyImports = new Map<string, Map<string, PyBinding>>();
  private pyWildcards = new Map<string, string[]>();
  private pyClassesByName = new Map<string, Entity[]>();
  private pyFnsByName = new Map<string, Entity[]>();
  private pyMethodsByName = new Map<string, Entity[]>();

  constructor(
    private all: FileFacts[],
    private opts: LinkOptions,
  ) {
    this.maxSites = opts.maxSites ?? 12;
  }

  run(): CodeGraph {
    let parseMs = 0;
    for (const f of this.all) {
      parseMs += f.parseMs;
      this.files.push({ id: 'f:' + f.path, path: f.path, lang: f.lang, lines: f.lines });
      this.filePaths.add(f.path);
      this.factsByPath.set(f.path, f);
      if (f.error) this.warnings.push(`${f.path}: ${f.error.split('\n')[0]}`);
      for (const se of f.syntaxErrors ?? []) {
        // tree-sitter positions are approximate, so these stay at file level; the compiler/python check is authoritative
        this.diags.push({
          file: f.path,
          line: se.line,
          endLine: se.endLine,
          severity: f.lang === 'python' ? 'error' : 'warning',
          source: 'syntax',
          message: `${se.message} (lines ${se.line}–${se.endLine})`,
          target: 'f:' + f.path,
        });
      }
      (f.lang === 'python' ? this.py : this.cc).push(f);
    }
    this.ccEntities();
    this.ccIncludes();
    this.ccTypedefs();
    this.pyEntities();
    this.pyImportTables();
    this.pyNameTables();
    this.inheritance();
    this.calls();
    this.memberUses();
    this.markEntries();
    this.incomplete();

    const entities = [...this.entities.values()];
    const relations = [...this.relations.values()];
    relations.forEach((r, i) => (r.id = 'r' + i));
    return {
      schema: 1,
      root: this.opts.root,
      generatedAt: new Date().toISOString(),
      files: this.files.sort((a, b) => a.path.localeCompare(b.path)),
      entities,
      relations,
      stats: {
        files: this.files.length,
        entities: entities.length,
        functions: entities.filter((e) => e.kind === 'function').length,
        classes: entities.filter((e) => e.kind === 'class').length,
        relations: relations.length,
        callSites: this.callSites,
        resolvedCalls: this.resolved,
        unresolvedCalls: this.unresolved,
        parseMs,
        linkMs: Date.now() - this.t0,
      },
      diagnostics: this.diags.length ? this.diags : undefined,
      warnings: this.warnings.length ? this.warnings.slice(0, 200) : undefined,
    };
  }

  /** Program entry points: C/C++ main(), Python modules with a __main__ guard (or __main__.py). */
  private markEntries(): void {
    const flag = (e: Entity) => (e.flags = [...new Set([...(e.flags ?? []), 'entry'])]);
    for (const e of this.entities.values()) {
      if (e.kind === 'function' && e.lang !== 'python' && e.def && !this.parentOf(e) && /^(main|wmain|WinMain|wWinMain)$/.test(e.name)) flag(e);
      if (e.kind === 'namespace' && e.sub === 'module' && e.def) {
        const f = this.factsByPath.get(e.def.file);
        if (f?.mainGuard || e.def.file.endsWith('__main__.py')) flag(e);
      }
    }
  }

  /** Called code that cannot run: declared-never-defined (C/C++), NotImplementedError stubs (Python). */
  private incomplete(): void {
    const callers = new Map<string, Relation[]>();
    for (const r of this.relations.values()) {
      if ((r.kind === 'call' || r.kind === 'spawn') && r.conf !== 'guess') push(callers, r.to, r);
    }
    const subclasses = new Map<string, string[]>();
    for (const [cls, bases] of this.basesOf) for (const b of bases) push(subclasses, b, cls);
    const overridden = (cls: Entity, name: string): boolean => {
      const seen = new Set<string>();
      const queue = [...(subclasses.get(cls.id) ?? [])];
      while (queue.length) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        if (this.members.get(id)?.get(name)?.some((m) => m.kind === 'function')) return true;
        queue.push(...(subclasses.get(id) ?? []));
      }
      return false;
    };
    for (const e of this.entities.values()) {
      if (e.kind !== 'function') continue;
      const inc = callers.get(e.id);
      if (!inc?.length) continue;
      const by = this.entities.get(inc[0].from)?.qname ?? inc[0].from;
      if (e.lang !== 'python' && e.flags?.includes('decl') && !e.flags.includes('abstract') && e.decl) {
        this.diags.push({
          file: e.decl.file,
          line: e.decl.line,
          severity: 'error',
          source: 'incomplete',
          message: `'${e.qname}' is declared but never defined in the workspace (link error unless a library provides it) — called by ${by}`,
          target: e.id,
        });
      } else if (e.lang === 'python' && e.flags?.includes('notImplemented') && !e.flags.includes('abstractmethod') && e.def) {
        const cls = this.parentOf(e);
        if (cls?.kind === 'class' && overridden(cls, e.name)) continue;
        this.diags.push({
          file: e.def.file,
          line: e.def.line,
          severity: 'error',
          source: 'incomplete',
          message: `'${e.qname}' is not implemented (raises NotImplementedError) but is called by ${by}`,
          target: e.id,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private add(e: Entity): Entity {
    let id = e.id;
    for (let i = 2; this.entities.has(id); i++) id = `${e.id}#${i}`;
    e.id = id;
    this.entities.set(id, e);
    if (e.parent) {
      let m = this.members.get(e.parent);
      if (!m) this.members.set(e.parent, (m = new Map()));
      push(m, e.name, e);
    }
    return e;
  }

  private rawKey(f: FileFacts, key: string): string {
    return f.path + '\u0000' + key;
  }

  private loc(f: FileFacts, r: RawEntity): Loc {
    return { file: f.path, line: r.line, endLine: r.endLine };
  }

  private parentOf(e: Entity | undefined): Entity | undefined {
    return e?.parent ? this.entities.get(e.parent) : undefined;
  }

  private enclosingClass(e: Entity | undefined): Entity | undefined {
    for (let p = e && e.kind === 'class' ? e : this.parentOf(e); p; p = this.parentOf(p)) if (p.kind === 'class') return p;
    return undefined;
  }

  private nsParts(e: Entity | undefined): string[] {
    for (let p = this.parentOf(e); p; p = this.parentOf(p)) if (p.kind === 'namespace') return p.qname.split('::');
    return [];
  }

  /** Prefer candidates near `from`: same file > header/source pair > included > same dir. */
  private nearest(cands: Entity[], from: FileFacts): Entity {
    if (cands.length === 1) return cands[0];
    const inc = this.includesOf.get(from.path);
    const dir = dirOf(from.path);
    const stem = stemOf(from.path);
    let best = cands[0];
    let bestScore = -1;
    for (const c of cands) {
      const f = c.def?.file ?? c.decl?.file ?? '';
      const d = c.decl?.file ?? '';
      let s = 0;
      if (f === from.path || d === from.path) s += 8;
      if (stemOf(f) === stem || stemOf(d) === stem) s += 4;
      if (inc && (inc.has(f) || inc.has(d))) s += 3;
      if (dirOf(f) === dir) s += 1;
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    return best;
  }

  private pickOverload(list: Entity[], args: string[] | undefined, from: FileFacts): Entity {
    if (list.length === 1) return list[0];
    const n = args?.length ?? 0;
    const same = list.filter((e) => (e.params?.length ?? 0) === n);
    return this.nearest(same.length ? same : list, from);
  }

  private addRelation(kind: RelationKind, from: string, to: string, conf: Confidence, site?: CallSite, via?: string): void {
    const key = `${kind}|${from}|${to}`;
    let r = this.relations.get(key);
    if (!r) {
      r = { id: '', kind, from, to, conf, count: 0 };
      if (via) r.via = via;
      this.relations.set(key, r);
    }
    r.count++;
    if (CONF_RANK[conf] > CONF_RANK[r.conf]) r.conf = conf;
    if (site) {
      r.sites ??= [];
      if (r.sites.length < this.maxSites) r.sites.push(site);
    }
  }

  // -------------------------------------------------------------------------
  // C / C++
  // -------------------------------------------------------------------------

  private nsEntity(parts: string[], f: FileFacts): Entity | undefined {
    if (!parts.length) return undefined;
    const q = parts.join('::');
    const anon = parts.includes('(anonymous)');
    const id = anon ? `cc:ns:${q}@${f.path}` : `cc:ns:${q}`;
    const ex = this.entities.get(id);
    if (ex) return ex;
    const parent = this.nsEntity(parts.slice(0, -1), f);
    this.namespaces.add(q);
    return this.add({
      id,
      kind: 'namespace',
      sub: 'namespace',
      name: parts[parts.length - 1],
      qname: q,
      lang: f.lang,
      parent: parent?.id,
    });
  }

  private nsPrefixParts(r: RawEntity): string[] {
    const out: string[] = [];
    for (let i = 0; i < r.scope.length; i++) {
      if (r.scopeKinds[i] !== 'namespace') break;
      out.push(r.scope[i]);
    }
    return out;
  }

  private ccEntities(): void {
    // namespaces first, so out-of-line qualifiers (`void helper::flush()`) can be told apart from classes
    for (const f of this.cc) for (const r of f.entities) this.nsEntity(this.nsPrefixParts(r), f);
    // classes ---------------------------------------------------------------
    const classGroups = new Map<string, { f: FileFacts; r: RawEntity }[]>();
    for (const f of this.cc) {
      for (const r of f.entities) {
        if (r.kind !== 'class') continue;
        const q = [...r.scope, ...(r.qualifier ?? []), r.name].join('::');
        const local = r.scope.includes('(anonymous)');
        push(classGroups, local ? `${q}@${f.path}` : q, { f, r });
      }
    }
    for (const [gk, recs] of classGroups) {
      recs.forEach(({ f, r }, i) => {
        const q = [...r.scope, ...(r.qualifier ?? []), r.name].join('::');
        const id = recs.length === 1 ? `cc:${gk}` : `cc:${q}@${f.path}${i ? '#' + i : ''}`;
        const parentRaw = r.parentKey ? this.rawToEntity.get(this.rawKey(f, r.parentKey)) : undefined;
        const parent = parentRaw ?? this.nsEntity(this.nsPrefixParts(r), f);
        const e = this.add({
          id,
          kind: 'class',
          sub: r.sub,
          name: r.name,
          qname: q,
          lang: f.lang,
          parent: parent?.id,
          def: this.loc(f, r),
          flags: r.flags,
        });
        this.rawToEntity.set(this.rawKey(f, r.key), e);
        push(this.ccClassByQname, q, e);
        push(this.ccClassesByName, r.name, e);
        this.classRaw.set(e.id, { raw: r, facts: f });
        if (r.fields) this.fieldsOf.set(e.id, r.fields);
        e.fields = r.members?.length ? r.members : r.fields ? memberList(r.fields) : undefined;
        if (r.aliases?.length) e.aliases = r.aliases;
      });
    }

    // functions -------------------------------------------------------------
    const groups = new Map<string, FnRec[]>();
    for (const f of this.cc) {
      for (const r of f.entities) {
        if (r.kind !== 'function') continue;
        const rec = this.ccFnRec(f, r);
        const isMember = rec.parent?.kind === 'class';
        const local = !isMember && (!!r.flags?.includes('static') || r.scope.includes('(anonymous)'));
        push(groups, local ? `${rec.qname}@${f.path}` : rec.qname, rec);
      }
    }
    for (const [gk, recs] of groups) this.ccFnGroup(gk, recs);
  }

  private ccFnRec(f: FileFacts, r: RawEntity): FnRec {
    let parent: Entity | undefined;
    let scope = r.scope;
    if (r.parentKey) {
      parent = this.rawToEntity.get(this.rawKey(f, r.parentKey));
      if (parent) scope = parent.qname.split('::');
    } else if (r.qualifier?.length) {
      const res = this.resolveQualifierCc(r.scope, r.qualifier, f);
      parent = res.parent;
      scope = res.scope;
    } else {
      parent = this.nsEntity(this.nsPrefixParts(r), f);
    }
    let sub = r.sub ?? 'function';
    if (parent?.kind === 'class') {
      if (r.name === parent.name) sub = 'ctor';
      else if (r.name.startsWith('~')) sub = 'dtor';
      else sub = 'method';
    } else if (sub === 'method' || sub === 'ctor' || sub === 'dtor') sub = 'function';
    return { facts: f, raw: r, qname: [...scope, r.name].join('::'), parent, sub };
  }

  /** `void Router::start()` inside `namespace net {}` -> class net::Router. */
  private resolveQualifierCc(scope: string[], qualifier: string[], f: FileFacts): { parent?: Entity; scope: string[] } {
    const tryQ = (parts: string[]): { parent?: Entity; scope: string[] } | undefined => {
      const q = parts.join('::');
      const cls = this.ccClassByQname.get(q);
      if (cls?.length) {
        const c = this.nearest(cls, f);
        return { parent: c, scope: c.qname.split('::') };
      }
      if (this.namespaces.has(q)) return { parent: this.nsEntity(parts, f), scope: parts };
      return undefined;
    };
    for (let k = scope.length; k >= 0; k--) {
      const r = tryQ([...scope.slice(0, k), ...qualifier]);
      if (r) return r;
    }
    for (const u of f.usingNamespaces) {
      const r = tryQ([...u.split('::'), ...qualifier]);
      if (r) return r;
    }
    const suffix = '::' + qualifier.join('::');
    const cands = (this.ccClassesByName.get(qualifier[qualifier.length - 1]) ?? []).filter((c) => c.qname.endsWith(suffix));
    if (cands.length) {
      const c = this.nearest(cands, f);
      return { parent: c, scope: c.qname.split('::') };
    }
    const parts = [...scope, ...qualifier];
    return { parent: this.nsEntity(parts.slice(0, scope.length), f), scope: parts };
  }

  private ccFnGroup(gk: string, recs: FnRec[]): void {
    const defs = recs.filter((r) => r.raw.isDefinition);
    const decls = recs.filter((r) => !r.raw.isDefinition);
    const bySig = new Map<string, FnRec[]>();
    for (const d of defs) push(bySig, sigOf(d.raw), d);
    const overloaded = bySig.size > 1;
    type Cluster = { id: string; def?: FnRec; decls: FnRec[] };
    const clusters: Cluster[] = [];
    for (const [s, ds] of bySig) {
      const base = overloaded ? `cc:${gk}(${s})` : `cc:${gk}`;
      if (ds.length === 1) clusters.push({ id: base, def: ds[0], decls: [] });
      else ds.forEach((d, i) => clusters.push({ id: `${base}@${d.facts.path}${i ? '#' + i : ''}`, def: d, decls: [] }));
    }
    for (const dc of decls) {
      const s = sigOf(dc.raw);
      const arity = dc.raw.params?.length ?? 0;
      let target = clusters.find((c) => c.def && sigOf(c.def.raw) === s);
      if (!target) {
        const sameArity = clusters.filter((c) => c.def && (c.def.raw.params?.length ?? 0) === arity);
        if (sameArity.length === 1) target = sameArity[0];
      }
      if (!target && !overloaded && clusters.length === 1 && clusters[0].def) target = clusters[0];
      if (!target) {
        target = clusters.find((c) => !c.def && sigOf(c.decls[0].raw) === s);
        if (!target) {
          target = { id: clusters.length ? `cc:${gk}(${s})` : `cc:${gk}`, decls: [] };
          clusters.push(target);
        }
      }
      target.decls.push(dc);
    }
    for (const c of clusters) {
      const primary = c.def ?? c.decls[0];
      const flags = new Set<string>();
      for (const r of [primary, ...c.decls]) for (const fl of r.raw.flags ?? []) flags.add(fl);
      if (!c.def) flags.add('decl');
      const withNames = [c.def, ...c.decls].find((r) => r?.raw.params?.some((p) => p.name));
      const e = this.add({
        id: c.id,
        kind: 'function',
        sub: primary.sub,
        name: primary.raw.name,
        qname: primary.qname,
        lang: primary.facts.lang,
        parent: (c.def?.parent ?? c.decls.find((d) => d.parent)?.parent)?.id,
        def: c.def ? this.loc(c.def.facts, c.def.raw) : undefined,
        decl: c.decls[0] ? this.loc(c.decls[0].facts, c.decls[0].raw) : undefined,
        params: (withNames ?? primary).raw.params,
        returns: c.def?.raw.returns ?? c.decls[0]?.raw.returns,
        rets: c.def?.raw.rets,
        flags: flags.size ? [...flags] : undefined,
      });
      for (const r of [c.def, ...c.decls]) if (r) this.rawToEntity.set(this.rawKey(r.facts, r.raw.key), e);
      push(this.ccFnByQname, e.qname, e);
      push(this.ccFnsByName, e.name, e);
      if (this.parentOf(e)?.kind === 'class') push(this.ccMethodsByName, e.name, e);
    }
  }

  /**
   * Typedef and `using` names become aliases of the class they name, so a type written with them is found:
   * `typedef struct buffer buffer_t;` in a header, `struct buffer {…}` in a source. When several classes have that
   * name, the one in the same file wins, then one in a file it includes, then one in a file that includes it.
   */
  private ccTypedefs(): void {
    const includes = new Map<string, Set<string>>();
    const includedBy = new Map<string, Set<string>>();
    for (const r of this.relations.values()) {
      if (r.kind !== 'include') continue;
      const [a, b] = [r.from.slice(2), r.to.slice(2)];
      (includes.get(a) ?? includes.set(a, new Set()).get(a)!).add(b);
      (includedBy.get(b) ?? includedBy.set(b, new Set()).get(b)!).add(a);
    }
    const closure = (file: string): Set<string> => {
      const seen = new Set<string>();
      const todo = [file];
      while (todo.length) for (const n of includes.get(todo.pop()!) ?? []) if (!seen.has(n)) (seen.add(n), todo.push(n));
      return seen;
    };
    for (const f of this.cc) {
      for (const td of f.typedefs ?? []) {
        const parts = td.target.split('::');
        const suffix = '::' + td.target;
        const cands = (this.ccClassesByName.get(parts[parts.length - 1]) ?? []).filter((c) => parts.length === 1 || ('::' + c.qname).endsWith(suffix));
        if (!cands.length) continue;
        const inc = closure(f.path);
        const tiers: ((file: string) => boolean)[] = [(x) => x === f.path, (x) => inc.has(x), (x) => !!includedBy.get(f.path)?.has(x)];
        let pick = cands.length === 1 ? cands : [];
        for (const tier of tiers) {
          const hit = cands.filter((c) => tier(c.def?.file ?? ''));
          if (hit.length) {
            pick = hit;
            break;
          }
        }
        for (const c of pick) if (c.name !== td.name && !c.aliases?.includes(td.name)) (c.aliases ??= []).push(td.name);
      }
    }
  }

  private ccIncludes(): void {
    const byBase = new Map<string, string[]>();
    for (const p of this.filePaths) push(byBase, p.slice(p.lastIndexOf('/') + 1), p);
    const incDirs = this.opts.includePaths ?? [];
    for (const f of this.cc) {
      const set = new Set<string>();
      for (const inc of f.includes) {
        const target = this.resolveInclude(f.path, inc.path, inc.system, incDirs, byBase);
        if (!target) {
          if (!inc.system) {
            this.diags.push({ file: f.path, line: inc.line, severity: 'warning', source: 'compiler', message: `#include "${inc.path}" not found in the workspace` });
          }
          continue;
        }
        set.add(target);
        this.addRelation('include', 'f:' + f.path, 'f:' + target, 'exact', { file: f.path, line: inc.line });
      }
      this.includesOf.set(f.path, set);
    }
  }

  private resolveInclude(from: string, inc: string, system: boolean, incDirs: string[], byBase: Map<string, string[]>): string | undefined {
    if (!system) {
      const rel = joinNorm(dirOf(from), inc);
      if (this.filePaths.has(rel)) return rel;
    }
    for (const d of incDirs) {
      const p = joinNorm(d, inc);
      if (this.filePaths.has(p)) return p;
    }
    const base = inc.slice(inc.lastIndexOf('/') + 1);
    const cands = (byBase.get(base) ?? []).filter((p) => p === inc || p.endsWith('/' + inc));
    if (!cands.length) return undefined;
    if (cands.length === 1) return cands[0];
    // longest common directory prefix with the includer
    let best = cands[0];
    let bestLen = -1;
    for (const c of cands) {
      let i = 0;
      while (i < c.length && i < from.length && c[i] === from[i]) i++;
      if (i > bestLen) {
        best = c;
        bestLen = i;
      }
    }
    return best;
  }

  private findClassCc(parts: string[], nsParts: string[], f: FileFacts, cls?: Entity): Target | undefined {
    if (!parts.length || parts[0] === 'std') return undefined;
    const name = parts.join('::');
    if (cls && parts.length === 1) {
      const nested = this.ccClassByQname.get(cls.qname + '::' + name);
      if (nested?.length) return { to: this.nearest(nested, f), conf: 'exact' };
      if (cls.name === name) return { to: cls, conf: 'exact' };
    }
    for (let k = nsParts.length; k >= 0; k--) {
      const cs = this.ccClassByQname.get([...nsParts.slice(0, k), ...parts].join('::'));
      if (cs?.length) return { to: this.nearest(cs, f), conf: 'exact' };
    }
    for (const u of f.usingNamespaces) {
      const cs = this.ccClassByQname.get(u + '::' + name);
      if (cs?.length) return { to: this.nearest(cs, f), conf: 'exact' };
    }
    const suffix = '::' + name;
    const cs = (this.ccClassesByName.get(parts[parts.length - 1]) ?? []).filter((c) => c.qname === name || c.qname.endsWith(suffix));
    if (cs.length === 1) return { to: cs[0], conf: 'likely' };
    if (cs.length > 1) return { to: this.nearest(cs, f), conf: 'guess' };
    return undefined;
  }

  private walkClasses(start: Entity, visit: (c: Entity) => boolean): void {
    const seen = new Set<string>();
    const queue = [start.id];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const c = this.entities.get(id);
      if (!c) continue;
      if (visit(c)) return;
      queue.push(...(this.basesOf.get(id) ?? []));
    }
  }

  private findMethod(cls: Entity, name: string): Entity[] | undefined {
    let found: Entity[] | undefined;
    this.walkClasses(cls, (c) => {
      const ms = this.members.get(c.id)?.get(name)?.filter((e) => e.kind === 'function');
      if (ms?.length) {
        found = ms;
        return true;
      }
      return false;
    });
    return found;
  }

  private fieldType(cls: Entity | undefined, field: string): string | undefined {
    if (!cls) return undefined;
    let t: string | undefined;
    this.walkClasses(cls, (c) => {
      const v = this.fieldsOf.get(c.id)?.[field];
      if (v) {
        t = v;
        return true;
      }
      return false;
    });
    return t;
  }

  private resolveCc(caller: Entity, c: RawCall, f: FileFacts): Target | undefined {
    const cls = this.enclosingClass(caller);
    const ns = this.nsParts(caller);
    switch (c.form) {
      case 'new':
        return this.findClassCc(c.qualifier ? [...c.qualifier, c.name] : [c.name], ns, f, cls);
      case 'plain': {
        if (cls) {
          const m = this.findMethod(cls, c.name);
          if (m) return { to: this.pickOverload(m, c.args, f), conf: 'exact' };
        }
        for (let k = ns.length; k >= 0; k--) {
          const fs = this.ccFnByQname.get([...ns.slice(0, k), c.name].join('::'));
          if (fs?.length) return { to: this.pickOverload(fs, c.args, f), conf: 'exact' };
          // members of an anonymous namespace are visible in the enclosing one (same TU only)
          const anon = this.ccFnByQname.get([...ns.slice(0, k), '(anonymous)', c.name].join('::'))?.filter((e) => e.def?.file === f.path);
          if (anon?.length) return { to: this.pickOverload(anon, c.args, f), conf: 'exact' };
        }
        for (const u of f.usingNamespaces) {
          const fs = this.ccFnByQname.get(u + '::' + c.name);
          if (fs?.length) return { to: this.pickOverload(fs, c.args, f), conf: 'exact' };
        }
        const asClass = this.ccClassByQname.get([...ns, c.name].join('::')) ?? this.ccClassByQname.get(c.name);
        if (asClass?.length) return { to: this.nearest(asClass, f), conf: 'likely' };
        const cands = (this.ccFnsByName.get(c.name) ?? []).filter((e) => this.parentOf(e)?.kind !== 'class');
        if (cands.length === 1) return { to: cands[0], conf: 'likely' };
        if (cands.length > 1) return { to: this.nearest(cands, f), conf: 'guess' };
        return undefined;
      }
      case 'qualified': {
        const q = c.qualifier ?? [];
        if (q[0] === 'std' || q[0] === 'boost') return undefined;
        for (let k = ns.length; k >= 0; k--) {
          const fs = this.ccFnByQname.get([...ns.slice(0, k), ...q, c.name].join('::'));
          if (fs?.length) return { to: this.pickOverload(fs, c.args, f), conf: 'exact' };
        }
        for (const u of f.usingNamespaces) {
          const fs = this.ccFnByQname.get([u, ...q, c.name].join('::'));
          if (fs?.length) return { to: this.pickOverload(fs, c.args, f), conf: 'exact' };
        }
        const owner = this.findClassCc(q, ns, f, cls);
        if (owner) {
          const m = this.findMethod(owner.to, c.name);
          if (m) return { to: this.pickOverload(m, c.args, f), conf: owner.conf };
        }
        const suffix = '::' + [...q, c.name].join('::');
        const cands = (this.ccFnsByName.get(c.name) ?? []).filter((e) => e.qname.endsWith(suffix));
        if (cands.length === 1) return { to: cands[0], conf: 'likely' };
        if (cands.length > 1) return { to: this.nearest(cands, f), conf: 'guess' };
        return undefined;
      }
      case 'member': {
        const q = c.qualifier ?? ['?'];
        let recv: Entity | undefined;
        let typed = false;
        let conf: Confidence = 'exact';
        if (q.length === 1 && q[0] === 'this') recv = cls;
        else if (q[0] !== '?') {
          let t = q[0] === 'this' ? this.fieldType(cls, q[1]) : c.receiverType ?? this.fieldType(cls, q[0]);
          if (t?.startsWith('[]')) t = this.fieldType(cls, t.slice(2) + '[]');
          if (t) {
            typed = true;
            const r = this.findClassCc(t.split('::'), ns, f, cls);
            recv = r?.to;
            conf = r?.conf === 'exact' ? 'likely' : 'guess';
          }
        }
        if (recv) {
          const m = this.findMethod(recv, c.name);
          if (m) return { to: this.pickOverload(m, c.args, f), conf };
          return undefined;
        }
        if (typed || COMMON_METHOD_NAMES.has(c.name)) return undefined; // known non-workspace type
        const ms = this.ccMethodsByName.get(c.name) ?? [];
        if (ms.length === 1) return { to: ms[0], conf: 'guess' };
        return undefined;
      }
      default:
        return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Python
  // -------------------------------------------------------------------------

  private pyEntities(): void {
    const pkgDirs = new Set<string>();
    for (const f of this.py) if (f.path.endsWith('/__init__.py') || f.path === '__init__.py') pkgDirs.add(dirOf(f.path));
    const pkgEntity = (dir: string): Entity | undefined => {
      if (!pkgDirs.has(dir) || dir === '') return undefined;
      const id = 'py:pkg:' + dir;
      const ex = this.entities.get(id);
      if (ex) return ex;
      const parent = pkgEntity(dirOf(dir));
      const name = dir.slice(dir.lastIndexOf('/') + 1);
      return this.add({
        id,
        kind: 'namespace',
        sub: 'package',
        name,
        qname: parent ? parent.qname + '.' + name : name,
        lang: 'python',
        parent: parent?.id,
        def: this.filePaths.has(dir + '/__init__.py') ? { file: dir + '/__init__.py', line: 1, endLine: 1 } : undefined,
      });
    };
    for (const f of this.py) {
      const dir = dirOf(f.path);
      const pkg = pkgEntity(dir);
      const stem = stemOf(f.path);
      const qname = stem === '__init__' && pkg ? pkg.qname : pkg ? pkg.qname + '.' + stem : stem;
      const mod = this.add({
        id: 'py:mod:' + f.path,
        kind: 'namespace',
        sub: 'module',
        name: stem,
        qname,
        lang: 'python',
        parent: pkg?.id,
        def: { file: f.path, line: 1, endLine: f.lines },
      });
      this.pyModuleOfFile.set(f.path, mod);
      push(this.pyModuleByQname, qname, mod);
      for (const r of f.entities) {
        const parent = r.parentKey ? this.rawToEntity.get(this.rawKey(f, r.parentKey)) : mod;
        const e = this.add({
          id: `py:${f.path}:${r.key}`,
          kind: r.kind,
          sub: r.sub,
          name: r.name,
          qname: qname + '.' + [...r.scope, r.name].join('.'),
          lang: 'python',
          parent: (parent ?? mod).id,
          def: this.loc(f, r),
          params: r.params,
          returns: r.returns,
          rets: r.rets,
          flags: r.flags,
        });
        this.rawToEntity.set(this.rawKey(f, r.key), e);
        if (e.kind === 'class') {
          push(this.pyClassesByName, e.name, e);
          this.classRaw.set(e.id, { raw: r, facts: f });
          if (r.fields) this.fieldsOf.set(e.id, r.fields);
        e.fields = r.members?.length ? r.members : r.fields ? memberList(r.fields) : undefined;
        if (r.aliases?.length) e.aliases = r.aliases;
        } else if (e.kind === 'function') {
          push(this.pyFnsByName, e.name, e);
          if (this.parentOf(e)?.kind === 'class') push(this.pyMethodsByName, e.name, e);
        }
      }
    }
  }

  private resolvePyModule(from: string, module: string, level: number): Entity | undefined {
    const cur = this.pyModuleOfFile.get(from);
    let parts: string[];
    if (level > 0) {
      const curParts = cur ? cur.qname.split('.') : [];
      const pkg = from.endsWith('__init__.py') ? curParts : curParts.slice(0, -1);
      const base = pkg.slice(0, Math.max(0, pkg.length - (level - 1)));
      parts = [...base, ...(module ? module.split('.') : [])];
    } else parts = module.split('.');
    const q = parts.join('.');
    if (!q) return undefined;
    const exact = this.pyModuleByQname.get(q);
    if (exact?.length) return exact.length === 1 ? exact[0] : this.nearestModule(exact, from);
    const suffix = '.' + q;
    const cands: Entity[] = [];
    for (const [mq, ms] of this.pyModuleByQname) if (mq.endsWith(suffix)) cands.push(...ms);
    if (cands.length) return this.nearestModule(cands, from);
    return undefined;
  }

  private nearestModule(cands: Entity[], from: string): Entity {
    let best = cands[0];
    let bestLen = -1;
    for (const c of cands) {
      const p = c.def?.file ?? '';
      let i = 0;
      while (i < p.length && i < from.length && p[i] === from[i]) i++;
      if (i > bestLen) {
        best = c;
        bestLen = i;
      }
    }
    return best;
  }

  private pyImportTables(): void {
    for (const f of this.py) {
      const binds = new Map<string, PyBinding>();
      const wild: string[] = [];
      const importRel = (m: Entity | undefined, line: number) => {
        if (m?.def && m.def.file !== f.path) this.addRelation('import', 'f:' + f.path, 'f:' + m.def.file, 'exact', { file: f.path, line });
      };
      for (const imp of f.imports) {
        if (!imp.names) {
          // import a.b.c [as x]
          const m = this.resolvePyModule(f.path, imp.module, 0);
          importRel(m, imp.line);
          if (imp.alias) binds.set(imp.alias, { module: m?.id });
          else {
            binds.set(imp.module, { module: m?.id });
            const top = imp.module.split('.')[0];
            if (!binds.has(top)) binds.set(top, { module: this.resolvePyModule(f.path, top, 0)?.id });
          }
          continue;
        }
        const m = imp.module || imp.level ? this.resolvePyModule(f.path, imp.module, imp.level) : undefined;
        if (imp.level > 0 && imp.module && !m) {
          this.diags.push({
            file: f.path,
            line: imp.line,
            severity: 'error',
            source: 'python',
            message: `cannot resolve relative import '${'.'.repeat(imp.level)}${imp.module}'`,
          });
        }
        for (const { name, alias } of imp.names) {
          if (name === '*') {
            if (m) wild.push(m.id);
            importRel(m, imp.line);
            continue;
          }
          const local = alias ?? name;
          if (m && this.members.get(m.id)?.has(name)) {
            binds.set(local, { module: m.id, member: name });
            importRel(m, imp.line);
            continue;
          }
          const sub = this.resolvePyModule(f.path, imp.module ? imp.module + '.' + name : name, imp.level);
          if (sub) {
            binds.set(local, { module: sub.id });
            importRel(sub, imp.line);
          } else {
            binds.set(local, { module: m?.id, member: m ? name : undefined });
            importRel(m, imp.line);
          }
        }
      }
      this.pyImports.set(f.path, binds);
      if (wild.length) this.pyWildcards.set(f.path, wild);
    }
  }

  /** Members each function reads and writes, as the extractor saw them; which class they belong to is worked out
   *  by the view (webview/members.ts), with the same type lookup as the class panel. */
  private memberUses(): void {
    const bases = new Map<string, string[]>();
    for (const r of this.relations.values()) if (r.kind === 'inherit') push(bases, r.from, r.to);
    const hasField = (cls: string, name: string, depth = 0): boolean =>
      !!this.fieldsOf.get(cls)?.[name] || (depth < 6 && (bases.get(cls) ?? []).some((b) => hasField(b, name, depth + 1)));
    for (const f of [...this.cc, ...this.py]) {
      for (const a of f.accesses ?? []) {
        const e = this.rawToEntity.get(this.rawKey(f, a.fn));
        if (e?.kind !== 'function') continue;
        const { fn: _fn, ...use } = a;
        if (use.implicit) {
          // a bare name: keep it only when the method's class (or a base) has a member by that name
          const cls = this.enclosingClass(e);
          if (!cls || !hasField(cls.id, use.path[0])) continue;
          delete use.implicit;
        }
        (e.uses ??= []).push(use);
      }
    }
  }

  /** Python: what each file's imported names are (classes and modules only), for type names written with them. */
  private pyNameTables(): void {
    const infos = new Map(this.files.map((x) => [x.path, x]));
    for (const f of this.py) {
      const info = infos.get(f.path);
      if (!info) continue;
      const names: Record<string, string> = {};
      for (const name of this.pyImports.get(f.path)?.keys() ?? []) {
        const { ent } = this.resolvePyDotted(name.split('.'), f.path);
        if (ent && (ent.kind === 'class' || ent.kind === 'namespace')) names[name] = ent.id;
      }
      if (Object.keys(names).length) info.names = names;
    }
  }

  private memberOf(owner: Entity, name: string, depth = 0): Entity | undefined {
    const hit = this.members.get(owner.id)?.get(name);
    if (hit?.length) return hit[hit.length - 1];
    if (owner.sub === 'module' || owner.sub === 'package') {
      const sub = this.pyModuleByQname.get(owner.qname + '.' + name);
      if (sub?.length) return sub[0];
      // re-export: `from .runner import Runner` inside pipeline/__init__.py
      const file = owner.sub === 'module' ? owner.def?.file : owner.def?.file;
      const b = file && depth < 6 ? this.pyImports.get(file)?.get(name) : undefined;
      if (b?.module) {
        const m = this.entities.get(b.module);
        if (m) return b.member ? this.memberOf(m, b.member, depth + 1) : m;
      }
    }
    return undefined;
  }

  /** Name visible at module level of `file`: definitions, imports, wildcard imports. */
  private resolvePyName(name: string, file: string): { ent?: Entity; external?: boolean } {
    const mod = this.pyModuleOfFile.get(file);
    if (mod) {
      const own = this.memberOf(mod, name);
      if (own && own.sub !== 'module') return { ent: own };
    }
    const b = this.pyImports.get(file)?.get(name);
    if (b) {
      if (!b.module) return { external: true };
      const m = this.entities.get(b.module);
      if (!m) return { external: true };
      if (!b.member) return { ent: m };
      const mem = this.memberOf(m, b.member);
      return mem ? { ent: mem } : { external: true };
    }
    for (const w of this.pyWildcards.get(file) ?? []) {
      const m = this.entities.get(w);
      const mem = m && this.memberOf(m, name);
      if (mem) return { ent: mem };
    }
    return {};
  }

  private resolvePyDotted(parts: string[], file: string): { ent?: Entity; external?: boolean } {
    const binds = this.pyImports.get(file);
    for (let k = parts.length; k >= 1; k--) {
      let start: { ent?: Entity; external?: boolean };
      if (k === 1) start = this.resolvePyName(parts[0], file);
      else {
        const b = binds?.get(parts.slice(0, k).join('.'));
        if (!b) continue;
        start = b.module ? { ent: this.entities.get(b.module) } : { external: true };
      }
      if (!start.ent) return start;
      let ent: Entity | undefined = start.ent;
      for (let i = k; i < parts.length && ent; i++) ent = this.memberOf(ent, parts[i]);
      return { ent };
    }
    return {};
  }

  private findMethodPy(cls: Entity, name: string): Entity | undefined {
    const ms = this.findMethod(cls, name);
    return ms?.length ? ms[ms.length - 1] : undefined;
  }

  private resolvePy(caller: Entity, c: RawCall, f: FileFacts): Target | undefined {
    const cls = this.enclosingClass(caller);
    switch (c.form) {
      case 'plain': {
        for (let s: Entity | undefined = caller; s; s = this.parentOf(s)) {
          if (s.kind === 'class') continue; // class scope is not visible from methods
          const hit = this.members.get(s.id)?.get(c.name);
          if (hit?.length) {
            const t = hit[hit.length - 1];
            if (t.kind !== 'namespace') return { to: t, conf: 'exact' };
          }
          if (s.sub === 'module') break;
        }
        const r = this.resolvePyName(c.name, f.path);
        if (r.ent && r.ent.kind !== 'namespace') return { to: r.ent, conf: 'exact' };
        if (r.external || PY_BUILTINS.has(c.name)) return undefined;
        const cands = [...(this.pyFnsByName.get(c.name) ?? []).filter((e) => e.sub === 'function'), ...(this.pyClassesByName.get(c.name) ?? [])];
        if (cands.length === 1) return { to: cands[0], conf: 'guess' };
        return undefined;
      }
      case 'super': {
        if (!cls) return undefined;
        for (const b of this.basesOf.get(cls.id) ?? []) {
          const base = this.entities.get(b);
          const m = base && this.findMethodPy(base, c.name);
          if (m) return { to: m, conf: 'exact' };
        }
        return undefined;
      }
      case 'member': {
        const q = c.qualifier ?? ['?'];
        if ((q[0] === 'self' || q[0] === 'cls') && cls) {
          if (q.length === 1) {
            const m = this.findMethodPy(cls, c.name);
            return m ? { to: m, conf: 'exact' } : undefined;
          }
          if (q.length === 2) {
            const t = this.fieldType(cls, q[1]);
            if (!t) return undefined;
            const tc = this.resolvePyDotted(t.split('.'), f.path).ent;
            const m = tc?.kind === 'class' ? this.findMethodPy(tc, c.name) : undefined;
            return m ? { to: m, conf: 'likely' } : undefined;
          }
          return undefined;
        }
        if (q.length === 1 && c.receiverType) {
          const tc = this.resolvePyDotted(c.receiverType.split('.'), f.path).ent;
          if (tc?.kind === 'class') {
            const m = this.findMethodPy(tc, c.name);
            return m ? { to: m, conf: 'likely' } : undefined;
          }
          return undefined;
        }
        if (q[0] !== '?') {
          const owner = this.resolvePyDotted(q, f.path);
          if (owner.ent) {
            const m = owner.ent.kind === 'class' ? this.findMethodPy(owner.ent, c.name) : this.memberOf(owner.ent, c.name);
            if (m && m.kind !== 'namespace') return { to: m, conf: 'exact' };
            return undefined;
          }
          if (owner.external) return undefined;
        }
        if (COMMON_METHOD_NAMES.has(c.name) || c.name.startsWith('__')) return undefined;
        const ms = this.pyMethodsByName.get(c.name) ?? [];
        if (ms.length === 1) return { to: ms[0], conf: 'guess' };
        return undefined;
      }
      default:
        return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Inheritance + calls
  // -------------------------------------------------------------------------

  private inheritance(): void {
    for (const [id, { raw, facts }] of this.classRaw) {
      const cls = this.entities.get(id)!;
      const out: string[] = [];
      for (const b of raw.bases ?? []) {
        let t: Target | undefined;
        if (facts.lang === 'python') {
          const r = this.resolvePyDotted(b.split('.'), facts.path).ent;
          if (r?.kind === 'class' && r.id !== id) t = { to: r, conf: 'exact' };
        } else {
          t = this.findClassCc(b.split('::'), this.nsParts(cls), facts);
          if (t?.to.id === id) t = undefined;
        }
        if (!t) continue;
        out.push(t.to.id);
        this.addRelation('inherit', id, t.to.id, t.conf, { file: facts.path, line: raw.line });
      }
      if (out.length) this.basesOf.set(id, out);
    }
  }

  private calls(): void {
    for (const f of this.all) {
      const isPy = f.lang === 'python';
      const mod = isPy ? this.pyModuleOfFile.get(f.path) : undefined;
      for (const c of f.calls) {
        const caller = c.caller ? this.rawToEntity.get(this.rawKey(f, c.caller)) : mod;
        if (!caller) continue;
        this.callSites++;
        const t = isPy ? this.resolvePy(caller, c, f) : this.resolveCc(caller, c, f);
        if (!t) {
          this.unresolved++;
          if (isPy && c.form === 'plain' && !f.wildcardImport && f.boundNames && !PY_BUILTIN_NAMES.has(c.name) && !f.boundNames.includes(c.name)) {
            this.diags.push({ file: f.path, line: c.line, severity: 'error', source: 'python', message: `name '${c.name}' is not defined` });
          }
          continue;
        }
        let conf = t.conf;
        if (c.spawn && c.spawnRecv) {
          // container-based spawn: confirm the container really holds threads
          const cls = this.enclosingClass(caller);
          const field = c.spawnRecv.replace(/^this\./, '');
          const ft = this.fieldType(cls, field);
          if (ft !== undefined && !this.fieldType(cls, field + '#raw')) {
            this.unresolved++;
            continue;
          }
          if (ft === undefined) conf = 'guess';
        }
        this.resolved++;
        const kind: RelationKind = c.spawn ? 'spawn' : c.instantiate || t.to.kind === 'class' ? 'instantiate' : 'call';
        if (kind === 'spawn') {
          const fl = new Set(t.to.flags ?? []);
          fl.add('threadEntry');
          t.to.flags = [...fl];
        }
        this.addRelation(kind, caller.id, t.to.id, conf, { file: f.path, line: c.line, args: c.args }, c.spawn);
      }
    }
  }
}

/** Data members for display: the receiver-inference helpers (`x[]`, `x#raw`) left out. */
function memberList(fields: Record<string, string>): Param[] | undefined {
  const out = Object.entries(fields)
    .filter(([k]) => !k.endsWith('[]') && !k.includes('#'))
    .map(([name, type]) => ({ name, type: fields[name + '[]'] ? `${type}<${fields[name + '[]']}>` : type }));
  return out.length ? out : undefined;
}
