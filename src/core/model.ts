/**
 * CodeGraph semantic model.
 *
 * Everything the analyzer knows about a workspace is expressed with these
 * language-agnostic, JSON-serializable types. The webview never sees syntax
 * trees: it only receives a CodeGraph and projects it to a view.
 *
 * Layers:
 *   FileFacts  (per file, produced by an extractor, cacheable)
 *        │  link()
 *        ▼
 *   CodeGraph  (whole workspace: entities + resolved relations)
 *        │  buildTree()/project()  (webview)
 *        ▼
 *   View graph (abstraction level, aggregation, layout, flow)
 */

export type Lang = 'c' | 'cpp' | 'python';
export type EntityKind = 'namespace' | 'class' | 'function';
export type RelationKind = 'call' | 'spawn' | 'instantiate' | 'inherit' | 'include' | 'import';
export type Confidence = 'exact' | 'likely' | 'guess';

/** Workspace-relative POSIX path + 1-based inclusive line range. */
export interface Loc {
  file: string;
  line: number;
  endLine: number;
}

export interface Param {
  name?: string;
  type?: string;
}

export interface FileInfo {
  /** 'f:' + path */
  id: string;
  path: string;
  lang: Lang;
  lines: number;
  /** Python: names the file's imports bind to workspace classes and modules (`Config`, `AC`, `x`) → entity id. */
  names?: Record<string, string>;
}

export interface Entity {
  /** Stable id, e.g. 'cc:net::Router::route' or 'py:pipeline/runner.py:Runner.start' */
  id: string;
  kind: EntityKind;
  /** class: class|struct|union ; function: function|method|ctor|dtor|decl ; namespace: namespace|package|module */
  sub?: string;
  name: string;
  /** Human readable qualified name: net::Router::route, pipeline.runner.Runner.start */
  qname: string;
  lang: Lang;
  /** Logical parent entity (namespace / class / enclosing function). */
  parent?: string;
  /** Declaration (prototype / header) location. */
  decl?: Loc;
  /** Definition (body) location. */
  def?: Loc;
  params?: Param[];
  returns?: string;
  /** Functions with a body: the members it reads and writes (see `MemberUse`). */
  uses?: MemberUse[];
  /** Functions with a body: the lines of its own `return` statements (`yield` in Python), not those of lambdas,
   *  nested functions or local classes inside it. Empty when it runs to the end. */
  rets?: number[];
  /** Classes: data members, typed as written (Python attributes may have no type). */
  fields?: Param[];
  /** Classes: other names of the same type (C typedef names). */
  aliases?: string[];
  /** static, virtual, override, async, template, threadEntry, abstract, property ... */
  flags?: string[];
}

export interface CallSite {
  file: string;
  line: number;
  /** Argument expressions as written (truncated). This is the "data on the wire". */
  args?: string[];
}

export interface Relation {
  id: string;
  kind: RelationKind;
  /** Entity id, or file id ('f:...') for include/import. */
  from: string;
  to: string;
  conf: Confidence;
  count: number;
  sites?: CallSite[];
  /** For spawn: the API used (std::thread, pthread_create, threading.Thread, ...). */
  via?: string;
}

export interface GraphStats {
  files: number;
  entities: number;
  functions: number;
  classes: number;
  relations: number;
  callSites: number;
  resolvedCalls: number;
  unresolvedCalls: number;
  parseMs: number;
  linkMs: number;
}

export interface CodeGraph {
  schema: 1;
  root: string;
  generatedAt: string;
  files: FileInfo[];
  entities: Entity[];
  relations: Relation[];
  stats: GraphStats;
  /** Problems found without running a compiler: parse failures, missing implementations, undefined names. */
  diagnostics?: Diagnostic[];
  /** Result of a real compile check, when the producer ran one (CLI `--verify`, exported graphs). */
  compile?: { diagnostics: Diagnostic[]; info: VerifyInfo };
  warnings?: string[];
}

export interface VerifyInfo {
  cChecked: boolean;
  pyChecked: boolean;
  checkedC: number;
  checkedPython: number;
  notes: string[];
  ms: number;
}

// ---------------------------------------------------------------------------
// Problems (static checks, compiler, editor, runtime)
// ---------------------------------------------------------------------------

export type Severity = 'error' | 'warning';

/**
 * syntax     tree-sitter could not parse (coarse, file level)
 * compiler   gcc / clang -fsyntax-only, or a real build
 * linker     undefined references from a real build
 * python     compile() / undefined names / unresolvable relative imports
 * incomplete declared-but-never-defined, or raises NotImplementedError and is called
 * editor     diagnostics from the user's language servers (clangd, Pylance, …)
 * runtime    uncaught exception or crash during Run & Trace
 */
export type DiagSource = 'syntax' | 'compiler' | 'linker' | 'python' | 'incomplete' | 'editor' | 'runtime';

export interface Diagnostic {
  file: string;
  line: number;
  col?: number;
  endLine?: number;
  severity: Severity;
  source: DiagSource;
  message: string;
  /** Entity id or file id ('f:...') the problem belongs to — filled by attachDiagnostics(). */
  target?: string;
}

// ---------------------------------------------------------------------------
// Per-file facts (extractor output). Intentionally unresolved: names are kept
// as written so that a file can be re-extracted alone and re-linked cheaply.
// ---------------------------------------------------------------------------

export type ScopeKind = 'namespace' | 'class' | 'function';

export interface RawEntity {
  /** Unique within the file. */
  key: string;
  kind: EntityKind;
  sub?: string;
  name: string;
  /** Lexical scope as written: namespaces / classes / functions enclosing the symbol. */
  scope: string[];
  scopeKinds: ScopeKind[];
  /** Out-of-line qualifier, e.g. `void Router::start()` -> ['Router']. Resolved by the linker. */
  qualifier?: string[];
  /** Key of the lexically enclosing RawEntity in the same file (class / function), if any. */
  parentKey?: string;
  line: number;
  endLine: number;
  isDefinition: boolean;
  params?: Param[];
  returns?: string;
  /** Definitions: lines of the function's own `return` / `co_return` / `yield` statements (see `ownReturns`). */
  rets?: number[];
  flags?: string[];
  /** Base classes as written ('util::Logger', 'Base'). */
  bases?: string[];
  /** Member name -> type name, used to infer receivers of member calls. */
  fields?: Record<string, string>;
  /** Data members for display, in declaration order, typed as written (`int*`, `char[16]`; Python: maybe untyped). */
  members?: Param[];
  /** Other names of the type: C `typedef struct ringbuf {…} ringbuf_t;` → ['ringbuf_t']. */
  aliases?: string[];
}

export type CallForm = 'plain' | 'qualified' | 'member' | 'super' | 'new';

export interface RawCall {
  /** RawEntity.key of the enclosing function; '' = file/module level code. */
  caller: string;
  form: CallForm;
  name: string;
  /** qualified: ['net','helper'] ; member: receiver path (['self'], ['this'], ['q_'], ['os','path']) */
  qualifier?: string[];
  /** Type of the receiver, if the extractor could infer it locally. */
  receiverType?: string;
  line: number;
  args?: string[];
  /** Function reference handed to a thread / task API instead of a direct call. */
  spawn?: string;
  /** For container-based spawns (`workers_.emplace_back(&C::run, this)`) the receiver, so the
   *  linker can confirm via the field's declared type that it really holds threads. */
  spawnRecv?: string;
  /** Object construction (new T, T x(...), make_unique<T>, Python Class()). */
  instantiate?: boolean;
  /** C/C++: full names the call's name may mean through `using ns::f;` or a `using namespace` inside the function,
   *  which the file's `usingNamespaces` do not cover; tried before the name is looked up elsewhere. */
  usingNames?: string[];
  /** C/C++ spawn through a bare library name the file never brings in (`thread(f)` with no `using namespace std;`):
   *  the name it is taken for (`std::thread`). The linker keeps it when an included header has that `using`. */
  assumed?: string;
}

export interface RawInclude {
  path: string;
  system: boolean;
  line: number;
}

export interface RawImport {
  /** Dotted module path as written (without leading dots). */
  module: string;
  /** Relative import level (number of leading dots). */
  level: number;
  /** from-import names; undefined for `import x` */
  names?: { name: string; alias?: string }[];
  /** `import a.b as c` */
  alias?: string;
  line: number;
}

/**
 * A function reading or writing a member: `cfg.link.peer`, `p->len = 0`, `self.port`, or a bare `port_` inside a
 * method. Which class each step belongs to is worked out later, from the types of the base and of each member.
 */
export interface MemberUse {
  /** The base is the object the method runs on (`this`, `self`, or a bare member name inside a method). */
  self?: boolean;
  /** Type of the base variable as known in the function (a parameter or local), when it is not `self`. */
  type?: string;
  /** Member names from the base on: `cfg.link.peer` → ['link', 'peer']; a bare `port_` → ['port_']. */
  path: string[];
  /** The last member is assigned, incremented or has its address taken. */
  write?: boolean;
  /** A bare name inside a method: only a member if the class has one by that name. */
  implicit?: boolean;
  /** Lines it is written on (the first few). */
  lines: number[];
}

export interface RawAccess extends MemberUse {
  /** RawEntity.key of the function. */
  fn: string;
}

export interface RawTypedef {
  /** The new name. */
  name: string;
  /** The type it names, as written without `struct`/`class` (`buffer`, `net::Packet`). */
  target: string;
  /** Namespaces / classes it is written in. */
  scope: string[];
  line: number;
}

export interface FileFacts {
  path: string;
  lang: Lang;
  lines: number;
  hash: string;
  entities: RawEntity[];
  calls: RawCall[];
  includes: RawInclude[];
  imports: RawImport[];
  usingNamespaces: string[];
  parseMs: number;
  error?: string;
  /** Regions tree-sitter could not parse (imprecise: error recovery can swallow neighbouring code). */
  syntaxErrors?: { line: number; endLine: number; message: string }[];
  /** Members read and written in function bodies. */
  accesses?: RawAccess[];
  /** C/C++: `typedef struct buffer buffer_t;`, `typedef Foo Bar;`, `using Bar = Foo;` — other names of a class
   *  that may be defined in another file. */
  typedefs?: RawTypedef[];
  /** Python: every name bound anywhere in the module (defs, assignments, params, imports, …). */
  boundNames?: string[];
  /** Python: `from x import *` present, so unbound names cannot be judged. */
  wildcardImport?: boolean;
  /** Python: has `if __name__ == "__main__":` — a program entry point. */
  mainGuard?: boolean;
}

export const SOURCE_EXTENSIONS: Record<string, Lang | 'header'> = {
  '.c': 'c',
  '.h': 'header',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.c++': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.h++': 'cpp',
  '.ipp': 'cpp',
  '.inl': 'cpp',
  '.py': 'python',
  '.pyi': 'python',
};

export function langFamily(lang: Lang): 'cc' | 'py' {
  return lang === 'python' ? 'py' : 'cc';
}
