import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { AnalysisSession, walk } from '../src/core/analyze';
import { composeOverride, effectiveCommand, findComposeFile, mirrorWorkspace, runComposeTrace, tracedServices, writeCodegraphDir, type ComposeProject } from '../src/core/compose';
import { loadParsers } from '../src/core/extract';
import { instrumentSources } from '../src/core/instrument';
import type { CodeGraph } from '../src/core/model';
import { ParsePool } from '../src/core/pool';
import { mergeTraces, parseTrace, type RunTrace } from '../src/core/trace';
import { detectToolchain } from '../src/core/verify';

const ROOT = path.resolve(__dirname, '..');
const WASM = path.join(ROOT, 'dist', 'wasm');
const PAIR = path.join(ROOT, 'samples', 'net-pair');
const tc = detectToolchain();
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `cc-compose-${name}-`));
const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
const composeCli = has('docker', ['compose', 'version']);
const dockerUp = composeCli && has('docker', ['info']);

async function analyze(dir: string) {
  const session = new AnalysisSession(dir, new ParsePool(WASM, undefined, 0));
  const { files } = walk(dir);
  const g = await session.analyze(files);
  return { g, files: files.map((f) => ({ abs: f.abs, rel: f.rel, lang: g.files.find((x) => x.path === f.rel)!.lang })) };
}

const project: ComposeProject = {
  name: 'pair',
  services: {
    'node-b': { command: ['sh', '-c', 'make node-b && exec ../build/node-b'], volumes: [{ type: 'bind', source: PAIR, target: '/app' }], working_dir: '/app/src' },
    'node-a': { command: ['sh', '-c', 'make node-a && exec ../build/node-a'], volumes: [{ type: 'bind', source: PAIR, target: '/app' }] },
    db: { image: 'mariadb:11', volumes: [{ type: 'volume', source: 'data', target: '/var/lib/mysql' }] },
  },
};

describe('Compose: plan', () => {
  it('finds the compose file and the services that mount the workspace', () => {
    assert.equal(findComposeFile(PAIR), path.join(PAIR, 'compose.yaml'));
    assert.deepEqual(
      tracedServices(project, PAIR).map((s) => [s.name, s.mounts]),
      [
        ['node-b', [{ rel: '', target: '/app' }]],
        ['node-a', [{ rel: '', target: '/app' }]],
      ],
    );
    assert.deepEqual(
      tracedServices(project, PAIR, ['node-a']).map((s) => s.name),
      ['node-a'],
    );
  });

  it('combines entrypoint and command the way Docker does', () => {
    assert.deepEqual(effectiveCommand({ command: ['make', 'run'] }, { Entrypoint: ['/init'], Cmd: ['bash'] }), ['/init', 'make', 'run']);
    assert.deepEqual(effectiveCommand({ entrypoint: ['/x'] }, { Entrypoint: ['/init'], Cmd: ['bash'] }), ['/x']);
    assert.deepEqual(effectiveCommand({}, { Entrypoint: null, Cmd: ['bash'] }), ['bash']);
    assert.equal(effectiveCommand({}, {}), undefined);
  });

  it('writes an override Compose accepts: the traced copy replaces the workspace mount', { skip: !composeCli }, () => {
    const dir = tmp('override');
    const plan = tracedServices(project, PAIR).map((s) => ({ ...s, command: project.services[s.name].command! }));
    const ov = composeOverride(plan, { mirror: path.join(dir, 'src'), codegraph: path.join(dir, 'cg'), maxEvents: 1000, values: true });
    const file = path.join(dir, 'override.yaml');
    fs.writeFileSync(file, JSON.stringify(ov));
    const r = spawnSync('docker', ['compose', '-f', path.join(PAIR, 'compose.yaml'), '-f', file, 'config', '--format', 'json'], { cwd: PAIR, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const merged = JSON.parse(r.stdout) as ComposeProject;
    const b = merged.services['node-b'];
    assert.deepEqual(
      b.volumes!.map((v) => [v.source, v.target]),
      [
        [path.join(dir, 'src'), '/app'],
        [path.join(dir, 'cg'), '/codegraph'],
      ],
    );
    assert.deepEqual(b.entrypoint, ['/codegraph/bin/cg-run']);
    assert.deepEqual(b.command, ['sh', '-c', 'make node-b && exec ../build/node-b']);
    assert.equal(b.environment!.CODE_GRAPH_TRACE, '/codegraph/trace/node-b/{pid}.jsonl');
    assert.ok((merged.services['node-a'] as Record<string, unknown>).depends_on, 'the rest of the service is kept');
  });
});

describe('Compose: what runs inside the container', { skip: !(tc.cc && tc.cxx && has('make', ['--version'])) }, () => {
  it('builds with the project makefile through the shims and traces every program it starts', async () => {
    const { g, files } = await analyze(PAIR);
    const dir = tmp('shim');
    const mirror = path.join(dir, 'src');
    const cg = path.join(dir, 'codegraph');
    mirrorWorkspace(PAIR, mirror);
    const native = files.filter((f): f is { abs: string; rel: string; lang: 'c' | 'cpp' } => f.lang !== 'python');
    const inst = instrumentSources({ files: native, outDir: mirror, graph: g, parsers: await loadParsers(WASM) });
    writeCodegraphDir(cg, path.join(ROOT, 'runtime'), inst.fns.length, ['node-a', 'node-b'], cg);
    const env = { ...process.env, PATH: `${cg}/bin:${process.env.PATH}` };
    // the service command, as the container would run it (make calls plain `g++`)
    const mk = spawnSync(path.join(cg, 'bin', 'cg-run'), ['sh', '-c', 'make node-a node-b'], { cwd: path.join(mirror, 'src'), env, encoding: 'utf8' });
    assert.equal(mk.status, 0, mk.stderr);
    const run = (node: string) =>
      new Promise<void>((resolve) => {
        const p = require('node:child_process').spawn(`../build/${node}`, [], {
          cwd: path.join(mirror, 'src'),
          env: { ...env, CODE_GRAPH_TRACE: path.join(cg, 'trace', node, '{pid}.jsonl') },
          stdio: 'ignore',
        });
        const t = setTimeout(() => p.kill('SIGTERM'), 4000);
        p.on('close', () => (clearTimeout(t), resolve()));
      });
    await Promise.all([run('node-b'), new Promise((r) => setTimeout(r, 200)).then(() => run('node-a'))]);
    const parts: { name: string; trace: RunTrace }[] = [];
    for (const node of ['node-a', 'node-b']) {
      const traces = fs.readdirSync(path.join(cg, 'trace', node));
      assert.equal(traces.length, 1, `${node} wrote one trace`);
      const tr = parseTrace(fs.readFileSync(path.join(cg, 'trace', node, traces[0]), 'utf8'), g, { fns: inst.fns });
      assert.equal(tr.exe, node);
      assert.ok(tr.clock?.mono && tr.clock.wall, 'clock anchors in the header');
      assert.equal(traces[0], `${tr.pid}.jsonl`);
      parts.push({ name: node, trace: tr });
    }
    const m = mergeTraces(parts, g, { command: 'test' });
    const ran = new Set(m.spans.fn.map((f) => m.fns[f]?.id ?? ''));
    assert.ok([...ran].some((id) => id.endsWith('Client::run')) && [...ran].some((id) => id.endsWith('Server::run')), 'both roles ran');
    assert.ok(m.threads.some((t) => t.name.startsWith('node-a · ')) && m.threads.some((t) => t.name.startsWith('node-b · ')));
  });
});

// Real containers: slow (builds the sample image), so only where asked for (CI sets it).
describe('Compose: Run & Trace with Docker', { skip: !(dockerUp && process.env.CODE_GRAPH_DOCKER_TEST === '1') }, () => {
  it('traces both nodes of the sample in their containers, on one timeline', async () => {
    const { g, files } = await analyze(PAIR);
    const lines: string[] = [];
    const r = await runComposeTrace({
      root: PAIR,
      graph: g as CodeGraph,
      files,
      composeFile: path.join(PAIR, 'compose.yaml'),
      runtimeDir: path.join(ROOT, 'runtime'),
      workDir: tmp('docker'),
      parsers: () => loadParsers(WASM),
      timeoutMs: 30_000,
      startTimeoutMs: 600_000,
      maxEvents: 200_000,
      values: true,
      log: (l) => lines.push(l),
    });
    assert.ok(r.ok, [...r.notes, ...lines.slice(-40)].join('\n'));
    const tr = r.trace!;
    assert.deepEqual(tr.procs?.map((p) => p.name).sort(), ['node-a', 'node-b']);
    assert.equal(tr.procs?.find((p) => p.name === 'node-a')?.exit.code, 0, lines.slice(-30).join('\n'));
    const ran = new Set(tr.spans.fn.map((f) => tr.fns[f]?.id ?? ''));
    for (const fn of ['Client::run', 'Client::readAcks', 'Server::serve', 'Message::verify']) assert.ok([...ran].some((id) => id.endsWith(fn)), fn);
    assert.ok(tr.threads.length >= 4, 'main and a worker thread in each container');
  });
});
