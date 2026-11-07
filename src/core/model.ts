/**
 * CodeCurrent semantic model.
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
  warnings?: string[];
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
  flags?: string[];
  /** Base classes as written ('util::Logger', 'Base'). */
  bases?: string[];
  /** Member name -> type name, used to infer receivers of member calls. */
  fields?: Record<string, string>;
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
