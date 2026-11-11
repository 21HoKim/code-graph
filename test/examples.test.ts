/**
 * The feature examples (examples/<language>/features/<feature>/) say in their README what to look for. These tests
 * check the same things, so an example never promises what CodeGraph no longer does.
 */
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { AnalysisSession, walk } from '../src/core/analyze';
import { loadParsers } from '../src/core/extract';
import type { CodeGraph, Relation } from '../src/core/model';
import { ParsePool } from '../src/core/pool';
import { findEntries, runAndTrace } from '../src/core/runner';
import type { RunTrace } from '../src/core/trace';
import { detectToolchain } from '../src/core/verify';
import * as fs from 'node:fs';
import * as os from 'node:os';

const ROOT = path.resolve(__dirname, '..');
const WASM = path.join(ROOT, 'dist', 'wasm');
const tc = detectToolchain();
const ex = (lang: string, feature: string) => path.join(ROOT, 'examples', lang, 'features', feature);

async function open(dir: string): Promise<{ g: CodeGraph; session: AnalysisSession; files: ReturnType<typeof walk>['files'] }> {
  const session = new AnalysisSession(dir, new ParsePool(WASM, undefined, 0));
  const { files } = walk(dir);
  return { g: await session.analyze(files), session, files };
}

/** "kind from → to" by qualified names, e.g. `has(g, 'spawn', 'main', 'work')`. */
function find(g: CodeGraph, kind: string, from: string, to: string): Relation | undefined {
  const q = new Map(g.entities.map((e) => [e.id, e.qname]));
  return g.relations.find((r) => r.kind === kind && q.get(r.from) === from && q.get(r.to) === to);
}
function has(g: CodeGraph, kind: string, from: string, to: string): void {
  assert.ok(find(g, kind, from, to), `${kind} ${from} → ${to}`);
}

async function members(g: CodeGraph): Promise<(cls: string, member: string) => string[]> {
  const { MemberIndex } = await import('../src/webview/members');
  const mi = new MemberIndex(g);
  const q = (id: string) => g.entities.find((e) => e.id === id)!.qname;
  return (cls, member) => {
    const c = g.entities.find((e) => e.kind === 'class' && e.qname === cls)!;
    assert.ok(c, cls);
    return (mi.of(c.id).get(member) ?? []).map((s) => `${s.write ? 'W' : 'R'} ${q(s.fn)}`).sort();
  };
}

async function run(dir: string): Promise<{ tr: RunTrace; g: CodeGraph }> {
  const { g, session, files } = await open(dir);
  const entry = findEntries(g)[0];
  assert.ok(entry, `entry point in ${dir}`);
  const r = await runAndTrace({
    root: dir,
    graph: g,
    files: files.map((f) => ({ abs: f.abs, rel: f.rel, lang: g.files.find((x) => x.path === f.rel)!.lang })),
    entry,
    args: [],
    toolchain: tc,
    includePaths: session.includePaths,
    buildFlags: [],
    linkFlags: [],
    runtimeDir: path.join(ROOT, 'runtime'),
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-example-')),
    parsers: () => loadParsers(WASM),
    timeoutMs: 20000,
    maxEvents: 200000,
    values: true,
  });
  assert.ok(r.trace, r.notes.join('\n'));
  return { tr: r.trace!, g };
}

/** Wires only the run revealed (what the view adds with `augmentGraph`). */
async function runtimeWires(g: CodeGraph, tr: RunTrace): Promise<string[]> {
  const { augmentGraph } = await import('../src/webview/traceview');
  const q = new Map(g.entities.map((e) => [e.id, e.qname]));
  return augmentGraph(g, tr)
    .relations.filter((r) => r.via === 'runtime')
    .map((r) => `${r.kind} ${q.get(r.from)} → ${q.get(r.to)}`)
    .sort();
}

describe('examples: C', () => {
  it('calls', async () => {
    const { g } = await open(ex('c', 'calls'));
    for (const to of ['rect_make', 'rect_area', 'apply']) has(g, 'call', 'main', to);
    has(g, 'call', 'rect_make', 'clamp');
    assert.equal(find(g, 'call', 'main', 'square'), undefined, 'square is handed over, not called');
  });

  it('threads', async () => {
    const { g } = await open(ex('c', 'threads'));
    for (const to of ['reader', 'writer', 'ticker']) has(g, 'spawn', 'main', to);
  });

  it('structs', async () => {
    const { g } = await open(ex('c', 'structs'));
    const m = await members(g);
    assert.deepEqual(m('buffer', 'len'), ['R buf_len', 'W buf_init']);
    assert.deepEqual(m('pool', 'free'), ['W pool_init']);
    assert.deepEqual(m('pool', 'size'), ['R main', 'W pool_init']);
  });

  it('returns', async () => {
    const { g } = await open(ex('c', 'returns'));
    has(g, 'call', 'twice', 'base');
    for (const to of ['base', 'twice']) {
      has(g, 'call', 'pick', to);
      has(g, 'call', 'nested', to);
    }
  });

  it('problems', async () => {
    const { g } = await open(ex('c', 'problems'));
    has(g, 'call', 'sensor_read', 'calibrate');
    has(g, 'call', 'calibrate', 'clamp');
  });

  it('trace and failures', { skip: !tc.cc }, async () => {
    const t = await run(ex('c', 'trace'));
    assert.deepEqual(t.tr.threads.map((x) => x.name).sort(), ['main', 'worker #1', 'worker #2']);
    assert.ok(t.tr.threads.filter((x) => x.name !== 'main').every((x) => x.parent === 1));
    assert.ok(t.tr.objects.some((o) => o.threads.length > 1 && o.label.includes('counter')), 'the shared counter');
    assert.deepEqual(await runtimeWires(t.g, t.tr), ['call add → report']);
    const f = await run(ex('c', 'failures'));
    assert.equal(f.tr.exit.crash, 'SIGSEGV');
    assert.equal(f.tr.fns[f.tr.exceptions[0]?.fn]?.name, 'read_slot');
    const c = await run(ex('c', 'calls'));
    assert.deepEqual(await runtimeWires(c.g, c.tr), ['call apply → square']);
    const th = await run(ex('c', 'threads'));
    assert.equal(th.tr.threads.length, 5);
    assert.ok(th.tr.threads.filter((x) => x.id !== 1).every((x) => x.parent === 1 && th.tr.fns[x.by!]?.name === 'main'));
  });
});

describe('examples: C++', () => {
  it('calls', async () => {
    const { g } = await open(ex('cpp', 'calls'));
    for (const to of ['app::geo::Point', 'app::geo::Circle', 'app::geo::Square']) has(g, 'instantiate', 'main', to);
    has(g, 'call', 'main', 'app::geo::distance');
    has(g, 'call', 'main', 'checksum');
    has(g, 'call', 'area', 'app::geo::Shape::area');
    for (const c of ['Circle', 'Square']) has(g, 'inherit', `app::geo::${c}`, 'app::geo::Shape');
  });

  it('threads', async () => {
    const { g } = await open(ex('cpp', 'threads'));
    for (const to of ['work', 'jobs::sweep', 'load', 'legacy']) has(g, 'spawn', 'main', to);
    has(g, 'spawn', 'Server::Server', 'Server::rxLoop');
    has(g, 'spawn', 'Server', 'Server::txLoop');
    has(g, 'spawn', 'Server::start', 'Server::heartbeat');
    has(g, 'spawn', 'Server::start', 'Server::handle');
  });

  it('classes', async () => {
    const { g } = await open(ex('cpp', 'classes'));
    const m = await members(g);
    assert.deepEqual(m('net::Peer', 'port'), ['R main', 'W net::Link::open']);
    assert.deepEqual(m('net::Endpoint', 'sent_'), ['W net::Link::send']);
    assert.deepEqual(m('net::Link', 'open_'), ['R net::Link::send', 'W net::Link::open']);
    assert.ok(g.entities.find((e) => e.qname === 'net::Packet')?.aliases?.includes('Frame'));
    has(g, 'inherit', 'net::Link', 'net::Endpoint');
  });

  it('returns', async () => {
    const { g } = await open(ex('cpp', 'returns'));
    has(g, 'call', 'twice', 'base');
    for (const to of ['base', 'twice']) has(g, 'call', 'pick', to);
    for (const to of ['base', 'Box::grow', 'Box::amount']) has(g, 'call', 'chain', to);
    has(g, 'call', 'visit', 'base');
    assert.deepEqual(g.entities.find((e) => e.qname === 'visit')?.rets, [], "the lambda's and the local class's returns are their own");
  });

  it('trace and failures', { skip: !tc.cxx }, async () => {
    const t = await run(ex('cpp', 'trace'));
    assert.deepEqual(t.tr.threads.map((x) => x.name).sort(), ['consume', 'main', 'produce']);
    assert.ok(t.tr.objects.some((o) => o.threads.length > 1 && /^Queue\b/.test(o.label)), 'the shared queue');
    const wires = await runtimeWires(t.g, t.tr);
    assert.ok(wires.includes('call consume → Console::put'), wires.join(', '));
    assert.ok(wires.includes('call consume → count'), wires.join(', '));
    const f = await run(ex('cpp', 'failures'));
    const x = f.tr.exceptions[0];
    assert.equal(f.tr.fns[x?.fn]?.name, 'parse');
    assert.match(`${x?.type}: ${x?.msg}`, /invalid_argument.*empty field/);
    const th = await run(ex('cpp', 'threads'));
    const by = (entry: string) => {
      const t0 = th.tr.threads.find((x) => th.tr.fns[x.entry!]?.name === entry);
      return t0 && th.tr.fns[t0.by!]?.name;
    };
    assert.equal(by('Server::handle'), 'Server::start');
    assert.equal(by('jobs::sweep'), 'main');
  });
});

describe('examples: Python', () => {
  it('calls', async () => {
    const { g } = await open(ex('python', 'calls'));
    has(g, 'instantiate', 'main.main', 'shop.cart.Cart');
    has(g, 'call', 'main.summary', 'shop.pricing.discount');
    has(g, 'call', 'main.main', 'shop.pricing.tax');
    has(g, 'call', 'shop.cart.Cart.add', 'shop.cart.Basket.add');
    has(g, 'inherit', 'shop.cart.Cart', 'shop.cart.Basket');
  });

  it('threads', async () => {
    const { g } = await open(ex('python', 'threads'));
    for (const to of ['w1', 'w2', 'w3', 'tick', 'w4']) has(g, 'spawn', 'main.main', `main.${to}`);
    for (const to of ['fetch', 'w2']) has(g, 'spawn', 'main.gather_all', `main.${to}`);
  });

  it('classes', async () => {
    const { g } = await open(ex('python', 'classes'));
    const m = await members(g);
    assert.deepEqual(m('models.Peer', 'port'), ['R main.Link.connect', 'W models.Peer.__init__']);
    assert.ok(m('models.Config', 'peer').includes('W main.Link.retarget'));
    assert.deepEqual(m('main.Link', 'open'), ['R main.main', 'W main.Link.__init__', 'W main.Link.connect']);
  });

  it('returns', async () => {
    const { g } = await open(ex('python', 'returns'));
    for (const from of ['pick', 'numbers', 'later']) has(g, 'call', `main.${from}`, 'main.base');
    has(g, 'call', 'main.outer', 'main.base');
    has(g, 'call', 'main.outer.inner', 'main.pick');
    assert.deepEqual(g.entities.find((e) => e.qname === 'main.outer')?.rets, []);
  });

  it('trace and failures', { skip: !tc.python }, async () => {
    const t = await run(ex('python', 'trace'));
    assert.deepEqual(t.tr.threads.map((x) => x.name), ['MainThread', 'alice', 'bob']);
    assert.ok(t.tr.objects.some((o) => o.threads.length > 1 && o.label.includes('Ledger')), 'the shared ledger');
    assert.ok((await runtimeWires(t.g, t.tr)).includes('call main.work → main.on_total'));
    const f = await run(ex('python', 'failures'));
    const types = f.tr.exceptions.map((x) => `${x.type} in ${f.tr.fns[x.fn]?.name}`).sort();
    assert.ok(types.some((s) => /ZeroDivisionError in average/.test(s)), types.join(', '));
    assert.ok(types.some((s) => /IndexError in main/.test(s)), types.join(', '));
  });
});
