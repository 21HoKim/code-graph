/**
 * C / C++ names as the compiler sees them, for the extractor.
 *
 * Code rarely spells library names in full: `using namespace std;`, `using std::thread;`,
 * `namespace io = boost::asio;`, `using Worker = std::thread;` all change what a written name means. `CppNames`
 * keeps those declarations per scope (file, namespace, block) while the extractor walks the file, and turns a
 * written name into the full names it can stand for. `CPP_LIBRARY` says what the extractor knows about a library
 * name; to teach it a new one, add a row there.
 */

/** What a library name does. */
export type LibKind =
  /** A thread object: constructing one runs its first argument on a new thread (`std::thread t(f, x)`). */
  | 'thread'
  /** A function that runs its first argument (after an optional launch policy) on another thread (`std::async`). */
  | 'task'
  /** A C function that starts a thread running its argument number `arg` (`pthread_create`). */
  | 'cthread'
  /** Creates an object of its template argument (`std::make_unique<T>(…)`). */
  | 'make'
  /** Wraps a callable; handed to a thread, the thread runs its first argument (`std::bind(&C::run, this)`). */
  | 'bind'
  /** A wrapper type: a variable of it is used as the type inside (`std::unique_ptr<T>`). */
  | 'wrapper'
  /** A container whose elements are its first template argument (`std::vector<T>`). */
  | 'seq'
  /** A container whose elements are its second template argument (`std::map<K, V>`). */
  | 'map';

export interface LibEntry {
  kind: LibKind;
  /** `cthread`: which argument is the function. */
  arg?: number;
}

const row = (kind: LibKind, names: string[], arg?: number): [string, LibEntry][] =>
  names.map((n) => [n, arg === undefined ? { kind } : { kind, arg }]);

/** Every library name the extractor understands, by full name. */
export const CPP_LIBRARY: ReadonlyMap<string, LibEntry> = new Map([
  ...row('thread', ['std::thread', 'std::jthread', 'boost::thread']),
  ...row('task', ['std::async']),
  ...row('cthread', ['pthread_create', 'CreateThread', '_beginthreadex'], 2),
  ...row('cthread', ['_beginthread'], 0),
  ...row('cthread', ['thrd_create'], 1),
  ...row('make', ['std::make_unique', 'std::make_shared', 'boost::make_shared', 'boost::make_unique']),
  ...row('bind', ['std::bind', 'boost::bind']),
  ...row('wrapper', [
    'std::unique_ptr', 'std::shared_ptr', 'std::weak_ptr', 'std::reference_wrapper', 'std::optional', 'std::atomic',
    'boost::shared_ptr', 'boost::weak_ptr', 'boost::scoped_ptr', 'boost::optional', 'boost::atomic',
  ]),
  ...row('seq', [
    'std::vector', 'std::deque', 'std::list', 'std::forward_list', 'std::array', 'std::set', 'std::unordered_set',
    'std::multiset', 'std::span', 'std::initializer_list', 'boost::container::vector', 'boost::container::deque',
  ]),
  ...row('map', ['std::map', 'std::unordered_map', 'std::multimap', 'std::unordered_multimap']),
]);

/**
 * A regex for the names of one kind, written in full or with the namespace left out (code that has a
 * `using namespace std;` somewhere the extractor cannot see): `^(?:(?:std|boost)::)?(?:vector|deque|…)`.
 */
export function libraryPattern(kinds: LibKind[], tail = ''): RegExp {
  const nss = new Set<string>();
  const shorts = new Set<string>();
  for (const [name, e] of CPP_LIBRARY) {
    if (!kinds.includes(e.kind)) continue;
    const parts = name.split('::');
    shorts.add(parts.pop()!);
    if (parts.length) nss.add(parts.join('::'));
  }
  const alt = (s: Set<string>) => [...s].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`^(?:(?:${alt(nss)})::)?(?:${alt(shorts)})${tail}`);
}

interface Frame {
  /** `using namespace X;` */
  namespaces: string[];
  /** `using X::y;` → y = X::y */
  names: Map<string, string>;
  /** `namespace A = B::C;` */
  nsAliases: Map<string, string>;
  /** `using T = X;`, `typedef X T;` → T = X (normalized, as `normCppType` gives it) */
  types: Map<string, string>;
}

const frame = (): Frame => ({ namespaces: [], names: new Map(), nsAliases: new Map(), types: new Map() });

export interface LibHit {
  /** The library name it stands for (`std::thread`). */
  name: string;
  entry: LibEntry;
}

export class CppNames {
  /** frames[0] is the file; then namespaces and blocks, innermost last. */
  private frames: Frame[] = [frame()];
  /** Names the file itself declares (functions, classes): those win over a library name reached by `using`. */
  private declared = new Set<string>();
  /** How many of the innermost frames are function bodies or blocks (the rest are the file and namespaces). */
  private blockDepth = 0;

  /** `cxx`: C++ (in C, a bare `thread` is never `std::thread`). */
  constructor(private cxx = true) {}

  enter(): void {
    this.frames.push(frame());
  }

  leave(): void {
    if (this.frames.length > 1) this.frames.pop();
  }

  /** A function body or a block: its `using` declarations end at its `}`. */
  enterBlock(): void {
    this.blockDepth++;
    this.enter();
  }
  leaveBlock(): void {
    this.blockDepth = Math.max(0, this.blockDepth - 1);
    this.leave();
  }

  declare(name: string): void {
    this.declared.add(name);
  }

  private get top(): Frame {
    return this.frames[this.frames.length - 1];
  }

  usingNamespace(ns: string): void {
    const full = this.expand(split(ns), true).join('::');
    if (full && !this.top.namespaces.includes(full)) this.top.namespaces.push(full);
  }

  /** `using X::y;` (a type or a function). */
  usingName(qualified: string): void {
    const parts = this.expand(split(qualified));
    if (parts.length > 1) this.top.names.set(parts[parts.length - 1], parts.join('::'));
  }

  namespaceAlias(alias: string, target: string): void {
    const parts = this.expand(split(target), true);
    if (alias && parts.length) this.top.nsAliases.set(alias, parts.join('::'));
  }

  /** `using T = X;` / `typedef X T;` with X normalized. */
  typeAlias(name: string, target: string): void {
    if (name && target && name !== target) this.top.types.set(name, target);
  }

  /**
   * The written name with a leading namespace alias replaced: `io::post` → `boost::asio::post`. A name of one part
   * is only a namespace when `isNamespace` says so (`using namespace io;`).
   */
  expand(parts: string[], isNamespace = false): string[] {
    let cur = parts.filter(Boolean);
    for (let guard = 0; guard < 4 && cur.length > (isNamespace ? 0 : 1); guard++) {
      const hit = this.lookup((f) => f.nsAliases.get(cur[0]));
      if (!hit) break;
      cur = [...split(hit), ...cur.slice(1)];
    }
    return cur;
  }

  /**
   * Every full name a written name can stand for, the most specific first: what a `using X::y;` or a type alias
   * makes of it, the name as written, then the name inside every `using namespace` in reach.
   */
  candidates(parts: string[], depth = 0): string[] {
    const p = this.expand(parts);
    if (!p.length) return [];
    const out: string[] = [];
    const add = (s: string) => {
      if (s && !out.includes(s)) out.push(s);
    };
    if (p.length === 1 && depth < 4) {
      const alias = this.lookup((f) => f.types.get(p[0]));
      if (alias) for (const c of this.candidates(split(alias), depth + 1)) add(c);
      const named = this.lookup((f) => f.names.get(p[0]));
      if (named) add(named);
    }
    add(p.join('::'));
    for (let i = this.frames.length - 1; i >= 0; i--) {
      for (const ns of this.frames[i].namespaces) add(ns + '::' + p.join('::'));
    }
    return out;
  }

  /** The library name a written name stands for, if any. A name the file declares itself is its own. */
  library(parts: string[]): LibHit | undefined {
    const p = this.expand(parts);
    if (!p.length) return undefined;
    const bare = p.length === 1;
    const aliased = bare && !!(this.lookup((f) => f.types.get(p[0])) ?? this.lookup((f) => f.names.get(p[0])));
    if (bare && !aliased && this.declared.has(p[0])) return undefined;
    for (const c of this.candidates(p)) {
      const entry = CPP_LIBRARY.get(c);
      if (entry) return { name: c, entry };
    }
    return undefined;
  }

  /**
   * A bare `thread` / `async` with no `using` in this file that makes it `std::…`: most likely the `std` one, reached
   * through a header's `using namespace std;`. Returns the name it is assumed to be, for the linker to confirm.
   */
  assumed(parts: string[], kinds: LibKind[]): LibHit | undefined {
    const p = this.expand(parts);
    if (!this.cxx || p.length !== 1 || this.declared.has(p[0])) return undefined;
    const name = 'std::' + p[0];
    const entry = CPP_LIBRARY.get(name);
    return entry && kinds.includes(entry.kind) ? { name, entry } : undefined;
  }

  /**
   * A normalized type name as the full name it stands for, for receiver inference: `Widget` after
   * `using ns::Widget;` → `ns::Widget`, `P` after `using P = net::Packet;` → `net::Packet`, `io::tcp` → `boost::asio::tcp`.
   */
  type(t: string): string {
    if (!t) return t;
    const p = this.expand(split(t));
    if (p.length === 1) {
      for (let guard = 0; guard < 4; guard++) {
        const alias = this.lookup((f) => f.types.get(p[0]));
        if (!alias) break;
        const next = this.expand(split(alias));
        if (next.length !== 1) return next.join('::');
        p[0] = next[0];
      }
      const named = this.lookup((f) => f.names.get(p[0]));
      if (named) return named;
    }
    return p.join('::');
  }

  /**
   * Full names a function call's name may mean that the linker cannot know from the file's `using namespace`
   * list: `using ns::f;` anywhere in reach, and `using namespace X;` inside a function or block.
   */
  scoped(parts: string[]): string[] | undefined {
    const p = this.expand(parts);
    if (!p.length) return undefined;
    const out: string[] = [];
    if (p.length === 1) {
      const named = this.lookup((f) => f.names.get(p[0]));
      if (named) out.push(named);
    }
    // only the block frames: the file's and namespaces' `using namespace` reach the linker as the file's list
    for (let i = this.frames.length - 1; i > this.frames.length - 1 - this.blockDepth && i > 0; i--) {
      for (const ns of this.frames[i].namespaces) {
        const s = ns + '::' + p.join('::');
        if (!out.includes(s)) out.push(s);
      }
    }
    return out.length ? out : undefined;
  }

  private lookup(get: (f: Frame) => string | undefined): string | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const v = get(this.frames[i]);
      if (v !== undefined) return v;
    }
    return undefined;
  }
}

function split(q: string): string[] {
  return q
    .replace(/\s+/g, '')
    .split('::')
    .filter(Boolean);
}
