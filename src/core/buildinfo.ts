/**
 * How the project itself builds a program, read from its build system instead of guessed:
 * compiler flags per source, libraries and linker options, and the directory it is linked in
 * (where `make run` would start it, so relative paths like ../../cfg resolve).
 *
 *   make    `make -nBwk`: a dry run of the default goal that prints every compiler, linker and
 *           `ar` command with the directory it runs in, without building anything
 *   CMake   compile_commands.json for the compile steps + CMakeFiles/<target>.dir/link.txt
 *
 * Commands are grouped into programs: an executable link plus the compile commands of the objects,
 * archives and workspace-built libraries it uses.
 *
 * Also knows which libraries usually provide symbols a failed link reports as undefined
 * (OpenSSL, Boost, libm, …), so Run & Trace can retry with them. Node-only.
 */
import * as fs from 'fs';
import * as path from 'path';
import { run, type CompileCommand } from './verify';

export interface BuildTarget {
  /** Program name (its file name). */
  name: string;
  from: 'make' | 'cmake';
  /** Directory the build links it in — where it is meant to run from. */
  dir: string;
  output: string;
  /** Compiler driver that links it. */
  linker: string;
  /** One compile command per source file that goes into the program. */
  units: CompileCommand[];
  /** Libraries and linker options (-L, -l, -Wl,…, library files, -pthread, …). */
  linkFlags: string[];
}

export interface Invocation {
  cwd: string;
  argv: string[];
}

const SOURCE = /\.(c|cc|cpp|cxx|c\+\+|C|m|mm)$/;
const OBJECT = /\.(o|obj|lo)$/;
const ARCHIVE = /\.a$/;
const SHARED = /\.(so(\.\d+)*|dylib)$/;
const COMPILER = /^(.*-)?(g\+\+|gcc|cc|c\+\+|clang|clang\+\+|icpx|icx)(-\d+(\.\d+)*)?(\.exe)?$/;
const WRAPPERS = new Set(['ccache', 'sccache', 'distcc', 'icecc']);
/** Options followed by a separate value. */
const WITH_VALUE = new Set(['-o', '-I', '-isystem', '-iquote', '-idirafter', '-include', '-imacros', '-D', '-U', '-x', '-MF', '-MT', '-MQ', '-L', '-l', '-Xlinker', '-T', '-isysroot', '-arch', '-target', '-framework', '-Xclang']);

// ---------------------------------------------------------------------------
// shell words
// ---------------------------------------------------------------------------

/** Splits one shell command line into commands (on && || ; |) and words (quotes and backslashes honoured). */
export function shellCommands(line: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let cur = '';
  let has = false;
  let q: '"' | "'" | '' = '';
  const word = () => {
    if (has) words.push(cur);
    cur = '';
    has = false;
  };
  const cmd = () => {
    word();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = '';
      else if (c === '\\' && q === '"' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      has = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (c === ' ' || c === '\t') word();
    else if (c === ';' || c === '|' || (c === '&' && line[i + 1] === '&')) {
      cmd();
      if (line[i + 1] === c) i++;
    } else if (c === '#' && !has) {
      break;
    } else {
      cur += c;
      has = true;
    }
  }
  cmd();
  return out;
}

/**
 * Compiler / archiver commands in `make -nw` output, each with the directory it runs in
 * ("Entering directory" lines and `cd dir &&` prefixes).
 */
export function parseMakeDryRun(text: string, startDir: string): Invocation[] {
  const out: Invocation[] = [];
  const dirs: string[] = [startDir];
  const logical = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  for (const raw of logical) {
    const line = raw.trim();
    if (!line) continue;
    const enter = /^\S*make(\[\d+\])?: Entering directory [`'‘"](.+?)['’"]$/.exec(line);
    if (enter) {
      dirs.push(enter[2]);
      continue;
    }
    if (/^\S*make(\[\d+\])?: Leaving directory/.test(line)) {
      if (dirs.length > 1) dirs.pop();
      continue;
    }
    if (/^\S*make(\[\d+\])?: /.test(line)) continue;
    let cwd = dirs[dirs.length - 1];
    for (const words of shellCommands(line)) {
      if (words[0] === 'cd' && words[1]) {
        cwd = path.resolve(cwd, words[1]);
        continue;
      }
      let argv = words;
      while (argv.length > 1 && (/^[A-Za-z_]\w*=/.test(argv[0]) || WRAPPERS.has(path.basename(argv[0])))) argv = argv.slice(1); // VAR=x ccache g++ …
      const tool = path.basename(argv[0] ?? '');
      if (COMPILER.test(tool) || tool === 'ar' || /-ar$/.test(tool)) out.push({ cwd, argv });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// commands → programs
// ---------------------------------------------------------------------------

interface Parsed {
  inv: Invocation;
  compileOnly: boolean;
  shared: boolean;
  output?: string;
  sources: string[];
  inputs: string[];
  compileFlags: string[];
  linkFlags: string[];
}

function parseCompiler(inv: Invocation): Parsed | undefined {
  const a = inv.argv;
  const abs = (p: string) => path.resolve(inv.cwd, p);
  const p: Parsed = { inv, compileOnly: false, shared: false, sources: [], inputs: [], compileFlags: [], linkFlags: [] };
  let lang = false;
  for (let i = 1; i < a.length; i++) {
    const x = a[i];
    if (x === '-E' || x === '-S' || x === '-M' || x === '-MM' || x === '--version' || x === '-dumpversion' || x === '-dumpmachine') return undefined;
    if (x === '-c') {
      p.compileOnly = true;
      continue;
    }
    if (x === '-o') {
      p.output = abs(a[++i] ?? '');
      continue;
    }
    if (/^-o[^-]/.test(x) && !/^-o(bjc|penmp)/.test(x)) {
      p.output = abs(x.slice(2));
      continue;
    }
    if (x === '-shared') {
      p.shared = true;
      p.linkFlags.push(x);
      continue;
    }
    if (x === '-MF' || x === '-MT' || x === '-MQ') {
      i++;
      continue;
    }
    if (/^-M{1,2}D?$/.test(x) || x === '-MP' || /^-M[FTQ]./.test(x)) continue;
    if (x === '-L' || x === '-l' || x === '-Xlinker' || x === '-T' || x === '-framework') {
      p.linkFlags.push(x, x === '-L' ? abs(a[i + 1] ?? '') : (a[i + 1] ?? ''));
      i++;
      continue;
    }
    if (x.startsWith('-L')) p.linkFlags.push('-L' + abs(x.slice(2)));
    else if (x.startsWith('-l') || x.startsWith('-Wl,') || x.startsWith('-static') || x === '-rdynamic' || x.startsWith('-fuse-ld=') || x.startsWith('-nostdlib') || x === '-pie' || x === '-no-pie')
      p.linkFlags.push(x);
    else if (x === '-pthread' || x.startsWith('-flto') || x.startsWith('--sysroot') || x === '-fopenmp' || /^-f(no-)?sanitize/.test(x) || x === '-m32' || x === '-m64') {
      p.compileFlags.push(x);
      p.linkFlags.push(x);
    } else if (x === '-x') {
      p.compileFlags.push(x, a[++i] ?? '');
      lang = a[i] !== 'none';
    } else if (WITH_VALUE.has(x)) {
      const v = a[++i] ?? '';
      p.compileFlags.push(x, x === '-I' || x === '-isystem' || x === '-iquote' || x === '-idirafter' ? abs(v) : v);
    } else if (/^-(I|isystem|iquote|idirafter)./.test(x)) {
      const m = /^-(I|isystem|iquote|idirafter)(.*)$/.exec(x)!;
      p.compileFlags.push(`-${m[1]}`, abs(m[2]));
    } else if (x.startsWith('-')) p.compileFlags.push(x);
    else if (SOURCE.test(x) || (lang && !OBJECT.test(x) && !ARCHIVE.test(x) && !SHARED.test(x))) p.sources.push(abs(x));
    else if (OBJECT.test(x) || ARCHIVE.test(x) || SHARED.test(x)) p.inputs.push(abs(x));
  }
  return p;
}

/** Groups compile, archive and link commands into runnable programs. */
export function collectTargets(invs: Invocation[], from: BuildTarget['from']): BuildTarget[] {
  const unitOf = new Map<string, CompileCommand>(); // object → its compile command
  const archives = new Map<string, string[]>(); // archive → members
  const links: Parsed[] = [];
  const libs = new Map<string, Parsed>(); // shared library built here → its link
  const unit = (p: Parsed, src: string): CompileCommand => ({ file: src, directory: p.inv.cwd, args: [p.inv.argv[0], ...p.compileFlags, src] });

  for (const inv of invs) {
    const tool = path.basename(inv.argv[0]);
    if (tool === 'ar' || /-ar$/.test(tool)) {
      // ar rcs libx.a a.o b.o   (CMake: ar qc libx.a …)
      const rest = inv.argv.slice(1).filter((x) => !x.startsWith('-'));
      const lib = rest.find((x) => ARCHIVE.test(x));
      if (!lib) continue;
      const key = path.resolve(inv.cwd, lib);
      archives.set(key, [...(archives.get(key) ?? []), ...rest.filter((x) => OBJECT.test(x)).map((x) => path.resolve(inv.cwd, x))]);
      continue;
    }
    if (!COMPILER.test(tool)) continue; // ranlib, …
    const p = parseCompiler(inv);
    if (!p) continue;
    if (p.compileOnly) {
      // without -o, gcc writes <name>.o into the current directory
      const objOf = (s: string) => path.join(p.inv.cwd, path.basename(s).replace(/\.[^.]+$/, '.o'));
      if (p.sources.length === 1) unitOf.set(p.output ?? objOf(p.sources[0]), unit(p, p.sources[0]));
      else for (const s of p.sources) unitOf.set(objOf(s), unit(p, s));
      continue;
    }
    if (!p.output) p.output = path.join(inv.cwd, 'a.out');
    if (p.shared) libs.set(p.output, p);
    else links.push(p);
  }

  /** A library this project builds itself, by -l name: its shared-library link or its archive path. */
  const ownLib = (name: string, dirs: string[]): string | undefined => {
    const near = (out: string) => !dirs.length || dirs.includes(path.dirname(out));
    for (const out of libs.keys()) {
      const base = path.basename(out);
      if ((base === `lib${name}.so` || base.startsWith(`lib${name}.so.`) || base === `lib${name}.dylib`) && near(out)) return out;
    }
    for (const out of archives.keys()) if (path.basename(out) === `lib${name}.a` && near(out)) return out;
    return undefined;
  };

  const out: BuildTarget[] = [];
  for (const l of links) {
    const units = new Map<string, CompileCommand>();
    const linkFlags: string[] = [];
    const seen = new Set<string>();
    /** Pull an object, archive or shared library into the program as source units; false = keep it as a link input. */
    const absorb = (file: string): boolean => {
      const u = unitOf.get(file);
      if (u) {
        units.set(u.file, u);
        return true;
      }
      if (seen.has(file)) return true;
      if (archives.has(file)) {
        const members = archives.get(file)!.map((m) => unitOf.get(m));
        if (!members.every(Boolean)) return false;
        seen.add(file);
        for (const u2 of members) units.set(u2!.file, u2!);
        return true;
      }
      if (libs.has(file)) {
        seen.add(file);
        addInputs(libs.get(file)!);
        return true;
      }
      return false;
    };
    const addInputs = (p: Parsed) => {
      for (const s of p.sources) units.set(s, unit(p, s));
      for (const i of p.inputs) if (!absorb(i)) linkFlags.push(i);
    };
    addInputs(l);
    const dirs: string[] = [];
    for (let i = 0; i < l.linkFlags.length; i++) {
      const f = l.linkFlags[i];
      if (f === '-L') dirs.push(l.linkFlags[i + 1]);
      else if (f.startsWith('-L')) dirs.push(f.slice(2));
    }
    for (let i = 0; i < l.linkFlags.length; i++) {
      const f = l.linkFlags[i];
      if (f === '-shared') continue;
      const name = f === '-l' ? l.linkFlags[i + 1] : f.startsWith('-l') ? f.slice(2) : undefined;
      const own = name ? ownLib(name, dirs) : undefined;
      if (own && absorb(own)) {
        if (f === '-l') i++;
        continue;
      }
      linkFlags.push(f);
    }
    if (!units.size) continue;
    out.push({ name: path.basename(l.output!), from, dir: l.inv.cwd, output: l.output!, linker: l.inv.argv[0], units: [...units.values()], linkFlags });
  }
  return out;
}

// ---------------------------------------------------------------------------
// readers
// ---------------------------------------------------------------------------

const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'];

/** Programs built by the makefile in `dir` (dry run of its default goal). */
export async function readMakeTargets(dir: string, o: { make?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ targets: BuildTarget[]; error?: string }> {
  if (!MAKEFILES.some((f) => fs.existsSync(path.join(dir, f)))) return { targets: [] };
  const r = await run(o.make ?? 'make', ['-nBwk'], { cwd: dir, timeoutMs: o.timeoutMs ?? 20_000, signal: o.signal, env: { ...process.env, LC_ALL: 'C', MAKEFLAGS: '' } });
  if (r.error) return { targets: [], error: r.error };
  return { targets: collectTargets(parseMakeDryRun(r.stdout, dir), 'make'), error: r.code === 0 ? undefined : r.stderr.trim().split('\n').pop() };
}

/** Programs CMake links: CMakeFiles/<target>.dir/link.txt under the build directory, compile steps from compile_commands.json. */
export function readCMakeTargets(buildDir: string, compileCommands: CompileCommand[]): BuildTarget[] {
  const invs: Invocation[] = compileCommands.map((c) => ({ cwd: c.directory, argv: c.args }));
  const stack = [buildDir];
  let budget = 4000;
  while (stack.length && budget-- > 0) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = path.join(d, e.name);
      if (e.name.endsWith('.dir') && path.basename(d) === 'CMakeFiles') {
        const link = path.join(sub, 'link.txt');
        if (!fs.existsSync(link)) continue;
        const binDir = path.dirname(d); // commands run in the target's binary directory
        for (const line of fs.readFileSync(link, 'utf8').split(/\r?\n/)) {
          for (const words of shellCommands(line)) if (words.length) invs.push({ cwd: binDir, argv: words });
        }
      } else if (!e.name.startsWith('.') && e.name !== 'Testing') stack.push(sub);
    }
  }
  return collectTargets(invs, 'cmake');
}

/** The CMake build directory (the one with CMakeCache.txt) that a compile_commands.json belongs to. */
export function cmakeBuildDir(compileCommands: CompileCommand[]): string | undefined {
  const seen = new Set<string>();
  for (const c of compileCommands) {
    for (let d = path.resolve(c.directory); !seen.has(d); d = path.dirname(d)) {
      seen.add(d);
      if (fs.existsSync(path.join(d, 'CMakeCache.txt'))) return d;
      if (path.dirname(d) === d) break;
    }
  }
  return undefined;
}

/** Programs of the workspace: CMake (when there is a compile_commands.json from CMake) or the root makefile. */
export async function readBuildTargets(
  root: string,
  o: { compileCommands?: CompileCommand[]; make?: string; signal?: AbortSignal } = {},
): Promise<{ targets: BuildTarget[]; from?: BuildTarget['from']; error?: string }> {
  const buildDir = o.compileCommands?.length ? cmakeBuildDir(o.compileCommands) : undefined;
  if (buildDir) {
    const targets = readCMakeTargets(buildDir, o.compileCommands!);
    if (targets.length) return { targets, from: 'cmake' };
  }
  const m = await readMakeTargets(root, o);
  return { targets: m.targets, from: m.targets.length ? 'make' : undefined, error: m.error };
}

/** One compile command per source file across the programs (the first program that builds it wins). */
export function compileCommandsOf(targets: BuildTarget[]): CompileCommand[] {
  const seen = new Map<string, CompileCommand>();
  for (const t of targets) for (const u of t.units) if (!seen.has(path.resolve(u.directory, u.file))) seen.set(path.resolve(u.directory, u.file), { ...u, file: path.resolve(u.directory, u.file) });
  return [...seen.values()];
}

/** Programs that compile `file` (absolute). */
export function targetsFor(targets: BuildTarget[], file: string): BuildTarget[] {
  const f = path.resolve(file);
  return targets.filter((t) => t.units.some((u) => path.resolve(u.directory, u.file) === f));
}

// ---------------------------------------------------------------------------
// libraries behind undefined symbols
// ---------------------------------------------------------------------------

interface LibRule {
  re: RegExp;
  label: string;
  /** -l names, in link order. */
  libs: string[];
  /** Extra driver flags instead of / besides libraries. */
  flags?: string[];
}

const LIB_RULES: LibRule[] = [
  { re: /^(SSL|TLS|DTLS|SSLv23)_|^OPENSSL_init_ssl$/, label: 'OpenSSL (libssl)', libs: ['ssl', 'crypto'] },
  {
    re: /^(ERR|EVP|BIO|X509\w*|PEM|RSA|EC|ECDSA|ECDH|BN|OPENSSL|OSSL|CRYPTO|ASN1|HMAC|SHA\d*|MD5|RAND|DH|DSA|PKCS\d*|GENERAL_NAMES?|OBJ|i2d|d2i|CMAC|AES|CONF|ENGINE|UI)_/,
    label: 'OpenSSL (libcrypto)',
    libs: ['crypto'],
  },
  { re: /^OQS_/, label: 'liboqs', libs: ['oqs', 'crypto'] },
  { re: /^boost::json::/, label: 'Boost.JSON', libs: ['boost_json'] },
  { re: /^boost::system::/, label: 'Boost.System', libs: ['boost_system'] },
  { re: /^boost::filesystem::/, label: 'Boost.Filesystem', libs: ['boost_filesystem'] },
  { re: /^boost::program_options::/, label: 'Boost.ProgramOptions', libs: ['boost_program_options'] },
  { re: /^boost::(this_thread|thread|detail::thread)/, label: 'Boost.Thread', libs: ['boost_thread'] },
  { re: /^boost::log(_v2\w*)?::/, label: 'Boost.Log', libs: ['boost_log', 'boost_log_setup', 'boost_thread'] },
  { re: /^boost::(re_detail\w*|regex|basic_regex)/, label: 'Boost.Regex', libs: ['boost_regex'] },
  { re: /^boost::(serialization|archive)::/, label: 'Boost.Serialization', libs: ['boost_serialization'] },
  { re: /^boost::chrono::/, label: 'Boost.Chrono', libs: ['boost_chrono'] },
  { re: /^boost::urls::/, label: 'Boost.URL', libs: ['boost_url'] },
  { re: /^boost::iostreams::/, label: 'Boost.Iostreams', libs: ['boost_iostreams'] },
  { re: /^boost::(context|detail::fcontext)|^(jump|make|ontop)_fcontext$/, label: 'Boost.Context', libs: ['boost_context'] },
  { re: /^boost::coroutines?::/, label: 'Boost.Coroutine', libs: ['boost_coroutine', 'boost_context'] },
  { re: /^boost::timer::/, label: 'Boost.Timer', libs: ['boost_timer'] },
  { re: /^boost::locale::/, label: 'Boost.Locale', libs: ['boost_locale'] },
  { re: /^boost::unit_test::/, label: 'Boost.Test', libs: ['boost_unit_test_framework'] },
  { re: /^soci::/, label: 'SOCI', libs: ['soci_core'] },
  { re: /^pthread_/, label: 'POSIX threads', libs: [], flags: ['-pthread'] },
  { re: /^(dlopen|dlsym|dlclose|dlerror|dladdr)$/, label: 'libdl', libs: ['dl'] },
  { re: /^(clock_gettime|clock_nanosleep|shm_open|shm_unlink|timer_create|timer_settime|mq_\w+)$/, label: 'librt', libs: ['rt'] },
  {
    re: /^(sqrt|cbrt|pow|exp2?|expm1|log(2|10|1p)?|sin|cos|tan|asin|acos|atan2?|sinh|cosh|tanh|floor|ceil|fmod|round|l?l?round|trunc|hypot|fabs|fmin|fmax|erf|erfc|lgamma|tgamma)[fl]?$/,
    label: 'libm',
    libs: ['m'],
  },
  { re: /^(omp_|GOMP_|__kmpc_)/, label: 'OpenMP', libs: [], flags: ['-fopenmp'] },
  { re: /^curl_/, label: 'libcurl', libs: ['curl'] },
  { re: /^sqlite3_/, label: 'SQLite', libs: ['sqlite3'] },
  { re: /^(mysql|mariadb)_/, label: 'MySQL/MariaDB client', libs: ['mariadb'] },
  { re: /^PQ[a-z]\w*$/, label: 'libpq', libs: ['pq'] },
  {
    re: /^(deflate(Init2?_|End|Reset|Bound|Params)?|inflate(Init2?_|End|Reset)?|compress(2|Bound)?|uncompress2?|crc32(_z|_combine)?|adler32(_z|_combine)?|gz(open|dopen|close|read|write|printf|gets|puts|eof|error|seek|tell|flush))$/,
    label: 'zlib',
    libs: ['z'],
  },
  { re: /^ZSTD_/, label: 'zstd', libs: ['zstd'] },
  { re: /^LZ4_/, label: 'LZ4', libs: ['lz4'] },
  { re: /^lzma_/, label: 'liblzma', libs: ['lzma'] },
  { re: /^BZ2_/, label: 'bzip2', libs: ['bz2'] },
  { re: /^uuid_/, label: 'libuuid', libs: ['uuid'] },
  { re: /^pcap_/, label: 'libpcap', libs: ['pcap'] },
  { re: /^ssh_/, label: 'libssh', libs: ['ssh'] },
  { re: /^gnutls_/, label: 'GnuTLS', libs: ['gnutls'] },
  { re: /^mbedtls_/, label: 'Mbed TLS', libs: ['mbedtls', 'mbedx509', 'mbedcrypto'] },
  { re: /^sodium_|^crypto_(box|sign|secretbox|aead|kx|generichash|pwhash)/, label: 'libsodium', libs: ['sodium'] },
  { re: /^(event_|evhttp_|bufferevent_|evbuffer_)/, label: 'libevent', libs: ['event'] },
  { re: /^uv_/, label: 'libuv', libs: ['uv'] },
  { re: /^zmq_/, label: 'ZeroMQ', libs: ['zmq'] },
  { re: /^(xml|html)[A-Z]\w*$/, label: 'libxml2', libs: ['xml2'] },
  { re: /^png_/, label: 'libpng', libs: ['png'] },
  { re: /^(initscr|endwin|mvprintw|wrefresh|newwin|getch|cbreak|noecho|keypad)$/, label: 'ncurses', libs: ['ncurses'] },
  { re: /^(readline|add_history)$/, label: 'GNU Readline', libs: ['readline'] },
  { re: /^fmt::/, label: '{fmt}', libs: ['fmt'] },
  { re: /^spdlog::/, label: 'spdlog', libs: ['spdlog', 'fmt'] },
  { re: /^YAML::/, label: 'yaml-cpp', libs: ['yaml-cpp'] },
  { re: /^google::protobuf::/, label: 'Protocol Buffers', libs: ['protobuf'] },
  { re: /^grpc::|^grpc_/, label: 'gRPC', libs: ['grpc++', 'grpc', 'gpr'] },
  { re: /^tbb::/, label: 'oneTBB', libs: ['tbb'] },
  { re: /^(testing|::testing)::/, label: 'GoogleTest', libs: ['gtest', 'gtest_main'] },
];

export interface LibraryGuess {
  label: string;
  libs: string[];
  flags: string[];
  /** A few of the undefined symbols that pointed here. */
  symbols: string[];
  /** How many undefined symbols pointed here. */
  count: number;
}

/** Libraries that usually define these symbols (demangled C++ names or C names), most-referenced first. */
export function guessLibraries(symbols: string[]): LibraryGuess[] {
  const by = new Map<string, LibraryGuess>();
  for (const s of symbols) {
    const name = s.replace(/^(non-virtual thunk to|typeinfo for|vtable for|guard variable for)\s+/, '').trim();
    const rule = LIB_RULES.find((r) => r.re.test(name));
    if (!rule) continue;
    const g = by.get(rule.label) ?? by.set(rule.label, { label: rule.label, libs: rule.libs, flags: rule.flags ?? [], symbols: [], count: 0 }).get(rule.label)!;
    g.count++;
    if (g.symbols.length < 3) g.symbols.push(name.replace(/\(.*$/, ''));
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

/** Link flags for the guesses, libraries in a safe order (libssl before libcrypto), without what is already there. */
export function libraryFlags(guesses: LibraryGuess[], existing: string[]): string[] {
  const have = new Set(existing);
  const out: string[] = [];
  const order = guesses.flatMap((g) => g.libs);
  // dependants first: a library that others need (crypto, context, fmt) goes last
  const last = new Set(['crypto', 'context', 'fmt', 'gpr', 'thread', 'boost_thread', 'boost_context', 'm']);
  const libs = [...new Set(order)].sort((a, b) => Number(last.has(a)) - Number(last.has(b)));
  for (const f of guesses.flatMap((g) => g.flags)) if (!have.has(f) && !out.includes(f)) out.push(f);
  for (const l of libs) if (!have.has('-l' + l)) out.push('-l' + l);
  return out;
}

/**
 * Folders a link takes libraries from (`-L`, `-Wl,-rpath` …), for running the program from here: a
 * library found there at link time may load others from the same folder (Boost.JSON → Boost.Container),
 * which a RUNPATH — what `-Wl,-rpath` writes on most distributions — does not cover for it. System
 * folders and folders that do not exist are left out; `$ORIGIN` is the folder the program is linked to.
 */
export function libraryDirs(flags: string[], origin?: string): string[] {
  const out: string[] = [];
  const add = (list: string | undefined) => {
    for (let d of (list ?? '').split(':')) {
      d = d.trim();
      if (origin) d = d.replace(/\$(\{ORIGIN\}|ORIGIN)/g, origin);
      if (!d || !path.isAbsolute(d) || d.includes('$')) continue;
      d = path.normalize(d).replace(/\/+$/, '') || '/';
      if (/^\/(usr\/)?lib(32|64)?(\/[^/]+-linux-[^/]+)?$/.test(d)) continue;
      if (!out.includes(d) && fs.existsSync(d)) out.push(d);
    }
  };
  let pending = false; // -Wl,-rpath -Wl,/dir
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f === '-L') add(flags[++i]);
    else if (f.startsWith('-L')) add(f.slice(2));
    else if (f === '-Xlinker') {
      const v = flags[++i] ?? '';
      if (pending) (add(v), (pending = false));
      else if (v === '-rpath' || v === '-R') pending = true;
      else if (/^--?rpath=/.test(v)) add(v.slice(v.indexOf('=') + 1));
    } else if (f.startsWith('-Wl,')) {
      const parts = f.slice(4).split(',');
      for (let j = 0; j < parts.length; j++) {
        const x = parts[j];
        if (pending) (add(x), (pending = false));
        else if (x === '-rpath' || x === '--rpath' || x === '-R') {
          if (j + 1 < parts.length) add(parts[++j]);
          else pending = true;
        } else if (/^--?rpath=/.test(x)) add(x.slice(x.indexOf('=') + 1));
        else if (/^-R\//.test(x)) add(x.slice(2));
      }
    }
  }
  return out;
}

/**
 * Directories outside the default search path that hold these libraries (e.g. /opt/boost-1.87/lib),
 * as -L / -rpath flags. Looks in /opt/*\/lib*, /usr/local/*\/lib*.
 */
export function libraryDirFlags(libs: string[], existing: string[]): string[] {
  const out: string[] = [];
  const known = new Set(existing.filter((f) => f.startsWith('-L')).map((f) => f.slice(2)));
  const roots = ['/opt', '/usr/local'];
  const dirs: string[] = [];
  for (const r of roots) {
    let subs: string[] = [];
    try {
      subs = fs.readdirSync(r);
    } catch {
      continue;
    }
    for (const s of subs) for (const lib of ['lib', 'lib64']) dirs.push(path.join(r, s, lib));
  }
  for (const l of libs) {
    for (const d of dirs) {
      if (known.has(d)) continue;
      if (['.so', '.a', '.dylib'].some((ext) => fs.existsSync(path.join(d, `lib${l}${ext}`)))) {
        known.add(d);
        out.push('-L' + d, `-Wl,-rpath,${d}`);
        break;
      }
    }
  }
  return out;
}
