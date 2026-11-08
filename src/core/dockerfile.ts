/**
 * Dockerfiles that copy the sources in (`COPY . .`, `COPY src/ /app/src/`, a `RUN --mount=type=bind`
 * of the context) and maybe build them while the image is built (`RUN make`): to trace those, the
 * image is built from the traced copy of the workspace. In every stage that builds after seeing the
 * sources, the CodeGraph folder and the compiler shims are inserted right before the first
 * instruction that sees them, so the layers above (base image, package installs) stay cached. It also
 * records where context files land in the image, to tell which sources a container has and to map
 * paths (Python roots, compiler errors) back to the workspace.
 */
import * as fs from 'fs';
import * as path from 'path';

interface Instruction {
  keyword: string;
  /** Text after the keyword, continuation lines joined. */
  args: string;
  /** First and last physical line (0-based). */
  first: number;
  last: number;
}

export interface DockerfileCopy {
  stage: number;
  /** Context-relative source ('' = the whole context): a folder, a file, or a pattern (`*.py`). */
  src: string;
  /** Absolute path in the image: where the folder's contents land, or the folder a file lands in. */
  dest: string;
  /** `src` is a file or a pattern, not a folder. */
  file?: boolean;
}

export interface DockerfileInfo {
  stages: number;
  /** Stages that see the context and then RUN something: where a build of the sources can happen. */
  buildStages: number[];
  copies: DockerfileCopy[];
  /** Instructions that take something from the build context (COPY, ADD, RUN --mount=type=bind). */
  contextCopies: number;
}

/** Instructions with their physical line ranges (continuations, comments and heredocs handled). */
export function parseDockerfile(text: string): Instruction[] {
  const lines = text.split(/\r?\n/);
  let escape = '\\';
  for (const l of lines) {
    const d = /^#\s*escape\s*=\s*(\S)\s*$/i.exec(l);
    if (d) escape = d[1];
    if (!/^#\s*\w+\s*=/.test(l)) break; // parser directives come first
  }
  const out: Instruction[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const first = i;
    let text = line;
    // continuation lines (comment lines inside are dropped, as Docker does)
    while (text.trimEnd().endsWith(escape) && i + 1 < lines.length) {
      text = text.trimEnd().slice(0, -1);
      i++;
      while (i < lines.length && /^\s*#/.test(lines[i])) i++;
      text += ' ' + (lines[i] ?? '');
    }
    // heredocs: RUN <<EOF … EOF
    for (const m of text.matchAll(/<<-?\s*["']?([A-Za-z_]\w*)["']?/g)) {
      const end = m[1];
      while (i + 1 < lines.length && lines[i + 1].trim() !== end) i++;
      if (i + 1 < lines.length) i++;
    }
    const m = /^\s*(\w+)\s*(.*)$/s.exec(text);
    if (m) out.push({ keyword: m[1].toUpperCase(), args: m[2].trim(), first, last: i });
  }
  return out;
}

/** Splits COPY/ADD arguments into flags, sources and destination (shell or JSON form). */
function copyArgs(args: string): { flags: string[]; srcs: string[]; dest: string } | undefined {
  let rest = args;
  const flags: string[] = [];
  for (;;) {
    const f = /^(--[\w-]+(=\S*)?)\s+/.exec(rest);
    if (!f) break;
    flags.push(f[1]);
    rest = rest.slice(f[0].length);
  }
  let parts: string[];
  if (rest.startsWith('[')) {
    try {
      parts = JSON.parse(rest) as string[];
    } catch {
      return undefined;
    }
  } else parts = rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return undefined;
  return { flags, srcs: parts.slice(0, -1), dest: parts[parts.length - 1] };
}

const isUrl = (s: string) => /^(https?|git|ssh):\/\/|^git@/.test(s);

/** The build context bind mounts of a RUN (`--mount=type=bind,…` without `from=`), in its leading flags. */
function contextMount(args: string, workdir: string): { src: string; dest: string }[] {
  const out: { src: string; dest: string }[] = [];
  const flags = /^(?:--[\w-]+(?:=\S*)?\s+)*/.exec(args)?.[0] ?? '';
  for (const m of flags.matchAll(/--mount=(\S+)/g)) {
    const kv = new Map(m[1].split(',').map((x) => [x.split('=')[0], x.slice(x.indexOf('=') + 1)] as [string, string]));
    if (kv.get('type') !== 'bind' || kv.has('from')) continue;
    const dest = kv.get('target') ?? kv.get('dst') ?? kv.get('destination');
    if (!dest) continue;
    out.push({ src: path.posix.normalize(kv.get('source') ?? kv.get('src') ?? '.').replace(/^\.\/?/, '').replace(/\/$/, ''), dest: path.posix.resolve(workdir, dest) });
  }
  return out;
}

/** What a COPY/ADD takes from the context (undefined: from another stage, a URL, or not parseable). */
function contextCopy(x: Instruction): { flags: string[]; srcs: string[]; dest: string } | undefined {
  if (x.keyword !== 'COPY' && x.keyword !== 'ADD') return undefined;
  const c = copyArgs(x.args);
  if (!c || c.flags.some((f) => f.startsWith('--from')) || c.srcs.some(isUrl)) return undefined;
  return c;
}

/**
 * Where a build of the sources can happen, and which context folders land where in the image.
 * `contextDir` (the build context on disk) tells folders from files.
 */
export function analyzeDockerfile(text: string, contextDir?: string): DockerfileInfo {
  const ins = parseDockerfile(text);
  let stage = -1;
  let workdir = '/';
  const copies: DockerfileCopy[] = [];
  const sawCopy = new Map<number, boolean>();
  const build = new Set<number>();
  let contextCopies = 0;
  for (const x of ins) {
    if (x.keyword === 'FROM') {
      stage++;
      workdir = '/';
      continue;
    }
    if (stage < 0) continue;
    if (x.keyword === 'WORKDIR') {
      const w = x.args.replace(/^["']|["']$/g, '');
      if (!w.includes('$')) workdir = path.posix.resolve(workdir, w);
      continue;
    }
    if (x.keyword === 'RUN') {
      const mounts = contextMount(x.args, workdir);
      for (const m of mounts) copies.push({ stage, src: m.src === '.' ? '' : m.src, dest: m.dest });
      if (mounts.length) contextCopies++;
      if (mounts.length || sawCopy.get(stage)) build.add(stage);
      continue;
    }
    const c = contextCopy(x);
    if (!c) continue;
    contextCopies++;
    sawCopy.set(stage, true);
    const intoDir = c.srcs.length > 1 || /\/$/.test(c.dest);
    const dest = path.posix.resolve(workdir, c.dest.includes('$') ? '.' : c.dest);
    for (const s of c.srcs) {
      if (s.includes('$')) continue;
      const rel = path.posix.normalize(s).replace(/^\.\/?/, '').replace(/\/$/, '');
      if (/[*?[]/.test(path.posix.dirname(rel))) continue;
      const pattern = /[*?[]/.test(rel);
      const isDir = !pattern && (rel === '' || rel === '.' || (contextDir ? safeIsDir(path.join(contextDir, rel)) : s.endsWith('/')));
      if (isDir) copies.push({ stage, src: rel === '.' ? '' : rel, dest });
      // a file (or pattern) copied into a folder; renamed files cannot be told apart
      else if (intoDir || pattern) copies.push({ stage, src: rel, dest, file: true });
    }
  }
  return { stages: stage + 1, buildStages: [...build], copies, contextCopies };
}

/** The copy that puts `rel` into the image (both relative to the same folder), if any. */
export function copiedBy(copies: DockerfileCopy[], rel: string): DockerfileCopy | undefined {
  return copies.find((c) => {
    if (!c.file) return c.src === '' || rel === c.src || rel.startsWith(c.src + '/');
    if (!/[*?[]/.test(c.src)) return rel === c.src;
    const re = new RegExp(
      '^' + c.src.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\[!/g, '[^') + '$',
    );
    return re.test(rel);
  });
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The Dockerfile with the CodeGraph folder (from the named build context `ctx`) and the compiler
 * shims inserted before the first context copy of every build stage.
 */
export function traceDockerfile(text: string, ctx: string, contextDir?: string): { text: string; stages: number } {
  const info = analyzeDockerfile(text, contextDir);
  const ins = parseDockerfile(text);
  const lines = text.split(/\r?\n/);
  const insertAt: number[] = [];
  let stage = -1;
  const done = new Set<number>();
  let workdir = '/';
  for (const x of ins) {
    if (x.keyword === 'FROM') {
      stage++;
      workdir = '/';
      continue;
    }
    if (x.keyword === 'WORKDIR' && !x.args.includes('$')) workdir = path.posix.resolve(workdir, x.args.replace(/^["']|["']$/g, ''));
    if (!info.buildStages.includes(stage) || done.has(stage)) continue;
    if (!contextCopy(x) && !(x.keyword === 'RUN' && contextMount(x.args, workdir).length)) continue;
    insertAt.push(x.first);
    done.add(stage);
  }
  const block = [
    '# CodeGraph Run & Trace: compilers wrapped from here on (this file is generated; the original is untouched)',
    `COPY --from=${ctx} / /codegraph/`,
    'RUN ["/bin/sh", "/codegraph/bin/cg-setup", "/tmp/codegraph-bin"]',
    'ENV CODE_GRAPH_SHIM_DIRS=/tmp/codegraph-bin:/codegraph/bin PATH="/tmp/codegraph-bin:/codegraph/bin:${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"',
  ];
  for (const at of [...insertAt].sort((a, b) => b - a)) lines.splice(at, 0, ...block);
  return { text: lines.join('\n'), stages: insertAt.length };
}
