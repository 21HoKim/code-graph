/**
 * `.codegraph.json` — what CodeGraph cannot find out by itself about a project, written down by its
 * users: which program to run and how it is built, which compose files and services, commands to run
 * in a container first. Comments and trailing commas are allowed. Every key is optional; a key set here
 * wins over the matching VS Code setting. Node-only; also read by the CLI.
 */
import * as fs from 'fs';
import * as path from 'path';

export const CONFIG_FILE = '.codegraph.json';

export interface ProjectConfig {
  run?: {
    /** Workspace-relative file with main(), or a Python script / package. */
    entry?: string;
    /** Program to run when the makefile / CMake builds the entry into several. */
    target?: string;
    args?: string[];
    /** Directory to run in (workspace-relative). */
    cwd?: string;
    env?: Record<string, string>;
    /**
     * Shell command that builds the program, for build systems CodeGraph does not read (scripts,
     * Meson, Bazel…). It runs in a traced copy of the workspace with the compilers wrapped.
     */
    build?: string;
    /** What `build` produces (workspace-relative path). */
    program?: string;
    buildFlags?: string[];
    linkFlags?: string[];
    timeoutSeconds?: number;
  };
  compose?: {
    /** Compose files, in order (default: compose.yaml + compose.override.yaml, as `docker compose` does). */
    files?: string | string[];
    profiles?: string[];
    /** Services to trace (default: every service whose code CodeGraph can reach). */
    services?: string[];
    /** Per service: a command run in its container before its own command (images that only run a prebuilt program). */
    build?: Record<string, string>;
    /** Per service: where the workspace is inside its container, when it is neither mounted nor copied in by the Dockerfile. */
    sourcePath?: Record<string, string>;
    /** Per service: extra environment for the traced run (e.g. CXX=g++-12). */
    env?: Record<string, Record<string, string>>;
    timeoutSeconds?: number;
    startTimeoutSeconds?: number;
  };
}

/** JSON with // and /* *\/ comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  // 1. comments out (strings kept as they are)
  let out = '';
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      out += ' ';
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // 2. trailing commas out
  let json = '';
  for (let i = 0; i < out.length; ) {
    const c = out[i];
    if (c === '"') {
      const end = stringEnd(out, i);
      json += out.slice(i, end);
      i = end;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === '}' || out[j] === ']') {
        i++;
        continue;
      }
    }
    json += c;
    i++;
  }
  return JSON.parse(json);
}

/** Index just past the string literal starting at `i`. */
function stringEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
  return Math.min(text.length, j + 1);
}

/** Reads `.codegraph.json` at the workspace root (an empty config when there is none). */
export function loadProjectConfig(root: string): { config: ProjectConfig; file?: string; error?: string } {
  const file = path.join(root, CONFIG_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { config: {} };
  }
  try {
    const v = parseJsonc(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { config: {}, file, error: `${CONFIG_FILE}: expected an object` };
    return { config: v as ProjectConfig, file };
  } catch (e) {
    return { config: {}, file, error: `${CONFIG_FILE}: ${String((e as Error).message ?? e)}` };
  }
}

/** compose.files as a list. */
export function composeFilesOf(c: ProjectConfig): string[] | undefined {
  const f = c.compose?.files;
  if (f === undefined) return undefined;
  return (Array.isArray(f) ? f : [f]).filter((x) => typeof x === 'string' && x);
}

/**
 * A starting `.codegraph.json`: every key explained and commented out, with what CodeGraph detected
 * as the example values — creating the file changes nothing until a line is uncommented.
 */
export function starterConfig(d: {
  entries: string[];
  targets: { entry: string; names: string[] }[];
  composeFiles: string[];
  services: string[];
}): string {
  const q = JSON.stringify;
  const entry = d.entries[0];
  const t = d.targets.find((x) => x.entry === entry)?.names ?? [];
  const svc = d.services[0] ?? 'server';
  const few = (xs: string[]) => (xs.length > 3 ? [...xs.slice(0, 3), '…'] : xs).join(', ');
  const pad = (code: string, note: string) => `    // ${code.padEnd(Math.max(36, code.length + 2))}// ${note}`;
  const lines = [
    '// CodeGraph project settings: only what CodeGraph cannot find out by itself.',
    '// Uncomment what you need; a key here wins over the matching VS Code setting.',
    '{',
    '  // Run & Trace on this machine',
    '  "run": {',
    pad(`"entry": ${q(entry ?? 'src/main.cpp')},`, d.entries.length > 1 ? `what to run (found: ${few(d.entries)})` : 'file with main(), or the Python script'),
    pad(`"target": ${q(t[0] ?? 'app')},`, t.length > 1 ? `the build makes ${few(t)} from it: which one` : 'when the build makes several programs from it'),
    pad('"args": ["--port", "7000"],', 'program arguments'),
    pad('"cwd": "src",', 'where to run it (default: where the build puts it)'),
    pad('"env": { "LOG_LEVEL": "debug" },', 'extra environment'),
    '    // a build CodeGraph does not read by itself (a script, Meson, Bazel…) runs in a traced',
    '    // copy of the workspace with every compiler wrapped; then `program` is started',
    pad('"build": "./build.sh",', 'build command'),
    pad('"program": "out/app",', 'what it builds (workspace-relative)'),
    pad('"buildFlags": ["-DDEBUG"],', 'extra compile flags'),
    pad('"linkFlags": ["-lssl", "-lcrypto"],', 'extra libraries'),
    pad('"timeoutSeconds": 20', 'stop the program after this long'),
    '  },',
    '',
    '  // Run & Trace with Docker Compose',
    '  "compose": {',
    pad(`"files": ${q(d.composeFiles.length ? d.composeFiles : ['compose.yaml'])},`, 'compose files, in order'),
    pad('"profiles": ["test"],', 'profiles to enable'),
    pad(`"services": ${q(d.services.length ? d.services : ['server', 'client'])},`, 'which to trace (default: all that have your code)'),
    '    // a container that only runs a program built elsewhere: build it first, in the container',
    pad(`"build": { ${q(svc)}: "make -C /app" },`, 'per service: run before its command'),
    '    // code where CodeGraph cannot see it (not mounted, not copied in by the Dockerfile)',
    pad(`"sourcePath": { ${q(svc)}: "/srv/app" },`, 'per service: where the workspace is'),
    pad(`"env": { ${q(svc)}: { "CXX": "g++-12" } },`, 'per service: extra environment'),
    pad('"timeoutSeconds": 20,', 'how long the programs run'),
    pad('"startTimeoutSeconds": 600', 'time for image and in-container builds'),
    '  }',
    '}',
    '',
  ];
  return lines.join('\n');
}
