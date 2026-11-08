import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { AnalysisSession, walk } from '../src/core/analyze';
import {
  composeOverride,
  containerPaths,
  effectiveCommand,
  findComposeFiles,
  planServices,
  runComposeTrace,
  type ComposeProject,
  type ComposeRunInput,
  type SourceFile,
} from '../src/core/compose';
import { loadParsers } from '../src/core/extract';
import type { LiveUpdate } from '../src/core/live';
import { instrumentSources } from '../src/core/instrument';
import { mirrorWorkspace } from '../src/core/mirror';
import type { CodeGraph } from '../src/core/model';
import { ParsePool } from '../src/core/pool';
import { writeCodegraphDir } from '../src/core/shims';
import { mergeTraces, parseTrace, type RunTrace } from '../src/core/trace';
import { detectToolchain } from '../src/core/verify';

const ROOT = path.resolve(__dirname, '..');
const WASM = path.join(ROOT, 'dist', 'wasm');
const PAIR = path.join(ROOT, 'samples', 'net-pair');
const PIPE = path.join(ROOT, 'samples', 'py-pipeline');
const tc = detectToolchain();
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `cc-compose-${name}-`));
const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
const composeCli = has('docker', ['compose', 'version']);
const dockerUp = composeCli && has('docker', ['info']);
const python = ['python3', 'python'].find((p) => has(p, ['-c', 'import sys; assert sys.version_info >= (3, 8)']));

async function analyze(dir: string) {
  const session = new AnalysisSession(dir, new ParsePool(WASM, undefined, 0));
  const { files } = walk(dir);
  const g = await session.analyze(files);
  return { g, files: files.map((f) => ({ abs: f.abs, rel: f.rel, lang: g.files.find((x) => x.path === f.rel)!.lang })) };
}

const sourcesOf = (dir: string): SourceFile[] =>
  walk(dir).files.map((f) => ({ rel: f.rel, lang: /\.py$/.test(f.rel) ? 'python' : /\.c$/.test(f.rel) ? 'c' : 'cpp' }));

const project: ComposeProject = {
  name: 'pair',
  services: {
    'node-b': { command: ['sh', '-c', 'make node-b && exec ../build/node-b'], volumes: [{ type: 'bind', source: PAIR, target: '/app' }], working_dir: '/app/src' },
    'node-a': { command: ['sh', '-c', 'make node-a && exec ../build/node-a'], volumes: [{ type: 'bind', source: PAIR, target: '/app' }] },
    baked: { build: { context: PAIR, dockerfile: 'docker/Dockerfile.image' }, command: ['./node-b'] },
    // a toolchain image (no COPY) with nothing mounted: nothing of the workspace inside
    tools: { build: { context: PAIR, dockerfile: 'docker/Dockerfile' } },
    // mounts only the config folder: no sources, runs as it is
    conf: { image: 'busybox', volumes: [{ type: 'bind', source: path.join(PAIR, 'cfg'), target: '/etc/pair' }] },
    db: { image: 'mariadb:11', volumes: [{ type: 'volume', source: 'data', target: '/var/lib/mysql' }] },
  },
};

describe('Compose: plan', () => {
  it('reads the compose files Compose would read', () => {
    assert.deepEqual(findComposeFiles(PAIR), [path.join(PAIR, 'compose.yaml')]);
    assert.deepEqual(findComposeFiles(PAIR, ['compose.image.yaml']), [path.join(PAIR, 'compose.image.yaml')]);
    assert.deepEqual(findComposeFiles(PAIR, ['nope.yaml']), []);
    const dir = tmp('files');
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
    fs.writeFileSync(path.join(dir, 'docker-compose.override.yml'), 'services: {}\n');
    assert.deepEqual(findComposeFiles(dir), [path.join(dir, 'docker-compose.yml'), path.join(dir, 'docker-compose.override.yml')]);
  });

  it('traces the services whose containers see workspace sources, mounted or copied in', () => {
    const { plans, skipped } = planServices(project, PAIR, { sources: sourcesOf(PAIR) });
    assert.deepEqual(
      plans.map((p) => [p.name, p.mounts.map((m) => `${m.rel || '.'}→${m.target}`), !!p.image, p.native, p.python]),
      [
        ['node-b', ['.→/app'], false, true, false],
        ['node-a', ['.→/app'], false, true, false],
        ['baked', [], true, true, false],
      ],
    );
    assert.deepEqual(skipped, []);
    const baked = plans.find((p) => p.name === 'baked')!;
    assert.equal(baked.image!.builds, true, 'compiles in its Dockerfile');
    assert.ok(baked.image!.tag.startsWith('codegraph-trace/pair-baked'));
    assert.ok(baked.roots.some((r) => r.rel === 'src' && r.target === '/src/src'), JSON.stringify(baked.roots));
    assert.deepEqual(
      planServices(project, PAIR, { only: ['node-a'] }).plans.map((s) => s.name),
      ['node-a'],
    );
  });

  it('takes what .codegraph.json says: source paths, pre-builds, services it has to explain', () => {
    const { plans, skipped } = planServices(project, PAIR, {
      sources: sourcesOf(PAIR),
      config: { sourcePath: { tools: '/work' }, build: { tools: 'make -C /work/src all' }, env: { tools: { CXX: 'g++' } }, services: ['db', 'conf', 'tools'] },
    });
    const tools = plans.find((p) => p.name === 'tools')!;
    assert.deepEqual(tools.mounts, [{ rel: '', target: '/work' }]);
    assert.equal(tools.prebuild, 'make -C /work/src all');
    assert.deepEqual(tools.env, { CXX: 'g++' });
    assert.deepEqual(skipped.map((s) => s.name).sort(), ['conf', 'db']);
    assert.match(skipped.find((s) => s.name === 'db')!.why, /sourcePath/);
  });

  it('combines entrypoint and command the way Docker does', () => {
    assert.deepEqual(effectiveCommand({ command: ['make', 'run'] }, { Entrypoint: ['/init'], Cmd: ['bash'] }), ['/init', 'make', 'run']);
    assert.deepEqual(effectiveCommand({ entrypoint: ['/x'] }, { Entrypoint: ['/init'], Cmd: ['bash'] }), ['/x']);
    assert.deepEqual(effectiveCommand({}, { Entrypoint: null, Cmd: ['bash'] }), ['bash']);
    assert.equal(effectiveCommand({}, {}), undefined);
  });

  it('maps container paths of Python traces back to the workspace', () => {
    const one = containerPaths('/work', [{ rel: '', target: '/work' }]);
    assert.equal(one('pipeline/runner.py'), 'pipeline/runner.py');
    const several = containerPaths('/', [
      { rel: '', target: '/src/' },
      { rel: 'src', target: '/src/src' },
    ]);
    assert.equal(several('src/src/link.cpp'), 'src/link.cpp');
    assert.equal(several('src/makefile'), 'makefile');
    assert.equal(several('opt/other.py'), 'opt/other.py');
  });

  it('writes an override Compose accepts: the traced copy replaces the mount, traced images are rebuilt', { skip: !composeCli }, () => {
    const dir = tmp('override');
    const mirror = path.join(dir, 'src');
    fs.mkdirSync(mirror);
    const merged = (file: string, plans: ReturnType<typeof planServices>['plans']) => {
      for (const p of plans) p.command = effectiveCommand(project.services[p.name] ?? {}, { Cmd: ['./node-b'] });
      const ov = composeOverride(plans, { mirror, codegraph: path.join(dir, 'cg'), maxEvents: 1000, values: true });
      const out = path.join(dir, 'override.json');
      fs.writeFileSync(out, JSON.stringify(ov));
      const r = spawnSync('docker', ['compose', '-f', path.join(PAIR, file), '-f', out, 'config', '--format', 'json'], { cwd: PAIR, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout) as ComposeProject;
    };
    const mounted = merged('compose.yaml', planServices({ name: 'net-pair', services: { 'node-b': project.services['node-b'], 'node-a': project.services['node-a'] } }, PAIR).plans);
    const b = mounted.services['node-b'];
    assert.deepEqual(
      b.volumes!.map((v) => [v.source, v.target]),
      [
        [mirror, '/app'],
        [path.join(dir, 'cg'), '/codegraph'],
      ],
    );
    assert.deepEqual(b.entrypoint, ['/codegraph/bin/cg-run']);
    assert.deepEqual(b.command, ['sh', '-c', 'make node-b && exec ../build/node-b']);
    assert.equal(b.environment!.CODE_GRAPH_TRACE, '/codegraph/trace/node-b/{host}-{pid}.jsonl');
    assert.equal(b.environment!.CODE_GRAPH_PY_ROOTS, '/app');
    assert.ok((mounted.services['node-a'] as Record<string, unknown>).depends_on, 'the rest of the service is kept');

    const image = { name: 'net-pair', services: { 'node-b': { build: { context: PAIR, dockerfile: 'docker/Dockerfile.image' }, command: ['./node-b'] } } };
    const baked = merged('compose.image.yaml', planServices(image, PAIR, { sources: sourcesOf(PAIR) }).plans).services['node-b'] as ComposeProject['services'][string] & {
      build: Record<string, unknown>;
    };
    assert.equal(baked.image, 'codegraph-trace/net-pair-node-b:latest');
    assert.equal(baked.build.context, mirror);
    assert.equal(baked.build.dockerfile, '.codegraph.Dockerfile');
    assert.deepEqual(baked.build.additional_contexts, { codegraph_trace: path.join(dir, 'cg') });
    assert.deepEqual(baked.entrypoint, ['/codegraph/bin/cg-run']);
  });
});

describe('Compose: what runs inside the container', () => {
  it('wraps exactly the compilers and interpreters that are there', () => {
    const dir = tmp('setup');
    const cg = path.join(dir, 'cg');
    writeCodegraphDir(cg, path.join(ROOT, 'runtime'), 1, ['svc'], cg);
    const bin = path.join(dir, 'fakebin');
    fs.mkdirSync(bin);
    const names = ['gcc', 'g++-12', 'x86_64-linux-gnu-gcc-13', 'aarch64-linux-gnu-g++', 'clang++-17', 'cc', 'python3.12', 'python3', 'gcc-ar', 'x86_64-linux-gnu-gcc-ar-13', 'ccache', 'clang-format', 'python3-config', 'make'];
    for (const n of names) fs.writeFileSync(path.join(bin, n), '#!/bin/sh\n', { mode: 0o755 });
    // the tools the script itself needs, and nothing else
    const tools = path.join(dir, 'tools');
    fs.mkdirSync(tools);
    for (const t of ['mkdir', 'ln', 'cp']) fs.symlinkSync(spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim(), path.join(tools, t));
    const shims = path.join(dir, 'shims');
    const r = spawnSync('/bin/sh', [path.join(cg, 'bin', 'cg-setup'), shims], { env: { PATH: `${bin}:${tools}` }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(shims).sort(), ['aarch64-linux-gnu-g++', 'cc', 'clang++-17', 'g++-12', 'gcc', 'python3', 'python3.12', 'x86_64-linux-gnu-gcc-13']);
    assert.equal(fs.readlinkSync(path.join(shims, 'g++-12')), path.join(cg, 'bin', 'cg-cc'));
    assert.equal(fs.readlinkSync(path.join(shims, 'python3.12')), path.join(cg, 'bin', 'cg-py'));
  });

  it('wraps a compiler given by full path in CC / CXX', { skip: !tc.cxx }, () => {
    const dir = tmp('cxx');
    const cg = path.join(dir, 'cg');
    writeCodegraphDir(cg, path.join(ROOT, 'runtime'), 1, ['svc'], cg);
    const real = spawnSync('sh', ['-c', `command -v ${tc.cxx}`], { encoding: 'utf8' }).stdout.trim();
    const home = path.join(dir, 'shims');
    const r = spawnSync(path.join(cg, 'bin', 'cg-run'), ['sh', '-c', 'echo "$CXX"; command -v "$CXX"'], {
      env: { ...process.env, CXX: real, CODE_GRAPH_SHIM_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), [path.basename(real), path.join(home, path.basename(real))]);
  });

  it('writes -rpath as an RPATH, so libraries found there load theirs from there too', { skip: !(tc.cc && process.platform === 'linux') }, () => {
    const dir = tmp('rpath');
    const lib = path.join(dir, 'lib');
    fs.mkdirSync(lib);
    fs.writeFileSync(path.join(lib, 'b.c'), 'int b(void) { return 7; }\n');
    fs.writeFileSync(path.join(lib, 'a.c'), 'int b(void);\nint a(void) { return b() + 1; }\n');
    fs.writeFileSync(path.join(dir, 'main.c'), '#include <stdio.h>\nint a(void);\nint main(void) { printf("a=%d\\n", a()); return 0; }\n');
    const cg = path.join(dir, 'cg');
    writeCodegraphDir(cg, path.join(ROOT, 'runtime'), 1, ['svc'], cg);
    const env: NodeJS.ProcessEnv = { ...process.env, CODE_GRAPH_SHIM_HOME: path.join(dir, 'shims') };
    delete env.LD_LIBRARY_PATH;
    const sh = (cmd: string) => spawnSync(path.join(cg, 'bin', 'cg-run'), ['sh', '-c', cmd], { cwd: dir, env, encoding: 'utf8' });
    const b = sh(`cd lib && cc -shared -fPIC -o libb.so b.c && cc -shared -fPIC -o liba.so a.c -L. -lb && cd .. && cc -o app main.c -Llib -Wl,-rpath,${lib} -la`);
    assert.equal(b.status, 0, b.stderr);
    const r = spawnSync(path.join(dir, 'app'), [], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'a=8');
  });

  it('builds with the project makefile through the shims and traces every program it starts', { skip: !(tc.cc && tc.cxx && has('make', ['--version'])) }, async () => {
    const { g, files } = await analyze(PAIR);
    const dir = tmp('shim');
    const mirror = path.join(dir, 'src');
    const cg = path.join(dir, 'codegraph');
    mirrorWorkspace(PAIR, mirror);
    const native = files.filter((f): f is { abs: string; rel: string; lang: 'c' | 'cpp' } => f.lang !== 'python');
    const inst = instrumentSources({ files: native, outDir: mirror, graph: g, parsers: await loadParsers(WASM) });
    writeCodegraphDir(cg, path.join(ROOT, 'runtime'), inst.fns.length, ['node-a', 'node-b'], cg);
    const env = { ...process.env, CODE_GRAPH_SHIM_HOME: path.join(dir, 'shims'), CODE_GRAPH_SERVICE: 'node-a' };
    // the service command, as the container would run it (make calls plain `g++`)
    const mk = spawnSync(path.join(cg, 'bin', 'cg-run'), ['sh', '-c', 'make node-a node-b'], { cwd: path.join(mirror, 'src'), env, encoding: 'utf8' });
    assert.equal(mk.status, 0, mk.stderr);
    assert.ok(fs.existsSync(path.join(cg, 'trace', 'node-a', '.compiled')), 'the shim saw the compiles');
    const run = (node: string) =>
      new Promise<void>((resolve) => {
        const p = spawn(`../build/${node}`, [], {
          cwd: path.join(mirror, 'src'),
          env: { ...process.env, CODE_GRAPH_TRACE: path.join(cg, 'trace', node, '{host}-{pid}.jsonl') },
          stdio: 'ignore',
        });
        const t = setTimeout(() => p.kill('SIGTERM'), 4000);
        p.on('close', () => (clearTimeout(t), resolve()));
      });
    await Promise.all([run('node-b'), new Promise((r) => setTimeout(r, 200)).then(() => run('node-a'))]);
    const parts: { name: string; trace: RunTrace }[] = [];
    for (const node of ['node-a', 'node-b']) {
      const traces = fs.readdirSync(path.join(cg, 'trace', node)).filter((f) => f.endsWith('.jsonl'));
      assert.equal(traces.length, 1, `${node} wrote one trace`);
      const tr = parseTrace(fs.readFileSync(path.join(cg, 'trace', node, traces[0]), 'utf8'), g, { fns: inst.fns });
      assert.equal(tr.exe, node);
      assert.ok(tr.clock?.mono && tr.clock.wall, 'clock anchors in the header');
      assert.match(traces[0], new RegExp(`^.+-${tr.pid}\\.jsonl$`));
      parts.push({ name: node, trace: tr });
    }
    const m = mergeTraces(parts, g, { command: 'test' });
    const ran = new Set(m.spans.fn.map((f) => m.fns[f]?.id ?? ''));
    assert.ok([...ran].some((id) => id.endsWith('Client::run')) && [...ran].some((id) => id.endsWith('Server::run')), 'both roles ran');
    assert.ok(m.threads.some((t) => t.name.startsWith('node-a · ')) && m.threads.some((t) => t.name.startsWith('node-b · ')));
  });

  it('traces Python however it is started: through the shim, by full path, never twice', { skip: !python }, async () => {
    const { g } = await analyze(PIPE);
    const dir = tmp('py');
    const work = path.join(dir, 'work');
    mirrorWorkspace(PIPE, work);
    const cg = path.join(dir, 'codegraph');
    writeCodegraphDir(cg, path.join(ROOT, 'runtime'), 1, ['shim', 'full', 'other'], cg);
    const real = spawnSync('sh', ['-c', `command -v ${python}`], { encoding: 'utf8' }).stdout.trim();
    const runIn = (svc: string, cmd: string[]) =>
      spawnSync(path.join(cg, 'bin', 'cg-run'), cmd, {
        cwd: work,
        env: {
          ...process.env,
          CODE_GRAPH_SHIM_HOME: path.join(dir, 'shims'),
          CODE_GRAPH_TRACE: path.join(cg, 'trace', svc, '{host}-{pid}.jsonl'),
          CODE_GRAPH_PY_ROOTS: work,
          CODE_GRAPH_SERVICE: svc,
        },
        encoding: 'utf8',
        timeout: 60_000,
      });
    for (const [svc, cmd] of [
      ['shim', [python!, 'main.py', '--seconds', '0.3']],
      ['full', [real, 'main.py', '--seconds', '0.3']],
      ['other', [python!, '-c', 'import json; print(json.dumps([1]))']],
    ] as [string, string[]][]) {
      const r = runIn(svc, cmd);
      assert.equal(r.status, 0, `${svc}: ${r.stderr}`);
    }
    for (const svc of ['shim', 'full']) {
      const traces = fs.readdirSync(path.join(cg, 'trace', svc)).filter((f) => f.endsWith('.jsonl'));
      assert.equal(traces.length, 1, `${svc}: one trace (${traces.join(', ')})`);
      const text = fs.readFileSync(path.join(cg, 'trace', svc, traces[0]), 'utf8');
      const head = JSON.parse(text.slice(0, text.indexOf('\n')));
      const tr = parseTrace(text, g, { mapFile: containerPaths(head.root, [{ rel: '', target: work }]) });
      const ran = new Set(tr.spans.fn.map((f) => tr.fns[f]?.id ?? ''));
      for (const fn of ['Runner.start', 'SensorSource.read', 'detect_spikes']) assert.ok([...ran].some((id) => id.endsWith(fn)), `${svc}: ${fn} ran`);
      assert.ok(tr.threads.length >= 3, `${svc}: the pump and worker threads`);
    }
    assert.deepEqual(fs.readdirSync(path.join(cg, 'trace', 'other')), [], 'no trace for Python that never ran workspace code');
  });
});

// Real containers: slow (builds the sample images), so only where asked for (CI sets it).
describe('Compose: Run & Trace with Docker', { skip: !(dockerUp && process.env.CODE_GRAPH_DOCKER_TEST === '1') }, () => {
  const traceIt = async (root: string, composeFiles: string[], extra: Partial<ComposeRunInput> = {}) => {
    const { g, files } = await analyze(root);
    const lines: string[] = [];
    const r = await runComposeTrace({
      root,
      graph: g as CodeGraph,
      files,
      composeFiles,
      runtimeDir: path.join(ROOT, 'runtime'),
      workDir: tmp('docker'),
      parsers: () => loadParsers(WASM),
      timeoutMs: 30_000,
      startTimeoutMs: 600_000,
      maxEvents: 200_000,
      values: true,
      log: (l) => lines.push(l),
      ...extra,
    });
    assert.ok(r.ok, [...r.notes, ...lines.slice(-60)].join('\n'));
    return { r, tr: r.trace!, lines };
  };
  const ranFns = (tr: RunTrace) => new Set(tr.spans.fn.map((f) => tr.fns[f]?.id ?? ''));

  it('traces both nodes of the sample in their containers, on one timeline (workspace mounted, built at start)', async () => {
    const updates: LiveUpdate[] = [];
    const { tr, lines } = await traceIt(PAIR, [path.join(PAIR, 'compose.yaml')], { live: (u) => updates.push(u) });
    // followed live while it ran: both containers' threads, where they were
    const procs = new Set(updates.flatMap((u) => u.threads.map((t) => t.proc)));
    assert.ok(procs.has('node-a') && procs.has('node-b'), `live updates from both containers (${[...procs].join(', ')}, ${updates.length} updates)`);
    assert.ok(updates.some((u) => u.stacks.some((st) => st.fns.length)), 'stacks while it ran');
    assert.deepEqual(tr.procs?.map((p) => p.name).sort(), ['node-a', 'node-b']);
    assert.equal(tr.procs?.find((p) => p.name === 'node-a')?.exit.code, 0, lines.slice(-30).join('\n'));
    const ran = ranFns(tr);
    for (const fn of ['Client::run', 'Client::readAcks', 'Server::serve', 'Message::verify']) assert.ok([...ran].some((id) => id.endsWith(fn)), fn);
    assert.ok(tr.threads.length >= 4, 'main and a worker thread in each container');
  });

  it('traces programs compiled while the image is built (multi-stage Dockerfile, nothing mounted)', async () => {
    const { tr, lines } = await traceIt(PAIR, [path.join(PAIR, 'compose.image.yaml')]);
    assert.deepEqual(tr.procs?.map((p) => p.name).sort(), ['node-a', 'node-b']);
    assert.equal(tr.procs?.find((p) => p.name === 'node-a')?.exit.code, 0, lines.slice(-30).join('\n'));
    const ran = ranFns(tr);
    for (const fn of ['Client::run', 'Server::serve']) assert.ok([...ran].some((id) => id.endsWith(fn)), fn);
  });

  it('traces a Python service, started by name or by full path; services without workspace code run as they are', async () => {
    const { tr } = await traceIt(PIPE, [path.join(PIPE, 'compose.yaml')]);
    assert.deepEqual(tr.procs?.map((p) => p.name), ['pipeline']);
    assert.ok([...ranFns(tr)].some((id) => id.endsWith('Runner.start')));

    const dir = tmp('pyfull');
    const file = path.join(dir, 'compose.yaml');
    fs.writeFileSync(
      file,
      JSON.stringify({
        services: {
          app: {
            image: 'python:3.12-slim',
            volumes: [{ type: 'bind', source: PIPE, target: '/srv/app' }],
            working_dir: '/srv/app',
            command: ['/usr/local/bin/python', 'main.py', '--seconds', '1'],
          },
          helper: { image: 'python:3.12-slim', command: ['python', '-c', 'print("helper ran")'] },
        },
      }),
    );
    const { r, tr: full, lines } = await traceIt(PIPE, [file]);
    assert.deepEqual(full.procs?.map((p) => p.name), ['app']);
    assert.ok([...ranFns(full)].some((id) => id.endsWith('SensorSource.read')));
    assert.ok(lines.some((l) => l.includes('helper ran')), 'the helper still ran');
    assert.ok(!r.notes.some((n) => n.startsWith('helper')), r.notes.join('\n'));
  });
});
