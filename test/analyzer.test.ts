import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { AnalysisSession, walk } from '../src/core/analyze';
import type { CodeGraph, Relation } from '../src/core/model';
import { ParsePool } from '../src/core/pool';

const ROOT = path.resolve(__dirname, '..');
const WASM = path.join(ROOT, 'dist', 'wasm');
const WORKER = path.join(ROOT, 'dist', 'parseWorker.js');

async function analyze(dir: string, workers = 0): Promise<CodeGraph> {
  const pool = new ParsePool(WASM, WORKER, workers);
  const session = new AnalysisSession(dir, pool);
  const g = await session.analyze(walk(dir).files);
  pool.dispose();
  return g;
}

function rel(g: CodeGraph, kind: string, from: string, to: string): Relation | undefined {
  return g.relations.find((r) => r.kind === kind && r.from === from && r.to === to);
}

describe('C++ router sample', () => {
  let g: CodeGraph;
  before(async () => {
    g = await analyze(path.join(ROOT, 'samples', 'cpp-router'), 2);
  });

  it('merges header declarations with out-of-line definitions', () => {
    const start = g.entities.find((e) => e.id === 'cc:net::Router::start');
    assert.ok(start, 'Router::start exists');
    assert.equal(start.def?.file, 'src/net/router.cpp');
    assert.equal(start.decl?.file, 'include/net/router.h');
    assert.equal(start.parent, 'cc:net::Router');
    assert.equal(start.sub, 'method');
  });

  it('detects std::thread and vector<thread>::emplace_back spawns', () => {
    assert.ok(rel(g, 'spawn', 'cc:net::Router::start', 'cc:net::Router::rxLoop'));
    assert.ok(rel(g, 'spawn', 'cc:net::Router::start', 'cc:net::Router::txLoop'));
    const rx = g.entities.find((e) => e.id === 'cc:net::Router::rxLoop')!;
    assert.ok(rx.flags?.includes('threadEntry'));
  });

  it('infers container element types for member calls', () => {
    // ifaces_[port]->send(pkt) with std::vector<std::unique_ptr<Interface>> ifaces_
    assert.ok(rel(g, 'call', 'cc:net::Router::route', 'cc:net::Interface::send'));
    // table_.lookup(...) through a field of type RouteTable
    assert.ok(rel(g, 'call', 'cc:net::Router::route', 'cc:net::RouteTable::lookup'));
  });

  it('records inheritance, includes and object creation', () => {
    assert.ok(rel(g, 'inherit', 'cc:net::EthInterface', 'cc:net::Interface'));
    assert.ok(rel(g, 'include', 'f:src/main.cpp', 'f:include/net/router.h'));
    assert.ok(rel(g, 'instantiate', 'cc:main', 'cc:net::Router'));
    assert.ok(rel(g, 'instantiate', 'cc:main', 'cc:net::EthInterface'));
  });

  it('links C++ to C through extern "C" headers', () => {
    const r = rel(g, 'call', 'cc:net::Packet::checksum', 'cc:crc32');
    assert.ok(r, 'checksum -> crc32');
    assert.equal(g.entities.find((e) => e.id === 'cc:crc32')?.lang, 'c');
  });

  it('keeps internal-linkage functions file-local', () => {
    assert.ok(g.entities.some((e) => e.id === 'cc:build_table@src/crc/crc32.c'));
    const r = rel(g, 'call', 'cc:util::log', 'cc:util::(anonymous)::writeLine@src/util/log.cpp');
    assert.equal(r?.conf, 'exact');
  });

  it('stores argument expressions as the data on the wire', () => {
    const r = rel(g, 'call', 'cc:net::Router::txLoop', 'cc:net::PacketQueue::pop');
    assert.deepEqual(r?.sites?.[0]?.args, ['pkt', '100']);
  });
});

describe('Python pipeline sample', () => {
  let g: CodeGraph;
  before(async () => {
    g = await analyze(path.join(ROOT, 'samples', 'py-pipeline'));
  });
  const id = (p: string) => `py:${p}`;

  it('resolves classes re-exported from a package __init__', () => {
    assert.ok(rel(g, 'instantiate', id('main.py:main'), id('pipeline/runner.py:Runner')));
    assert.ok(rel(g, 'call', id('main.py:main'), id('pipeline/runner.py:Runner.start')));
  });

  it('detects threading.Thread targets and executor.submit', () => {
    assert.ok(rel(g, 'spawn', id('pipeline/runner.py:Runner.start'), id('pipeline/runner.py:Runner._pump')));
    assert.ok(rel(g, 'spawn', id('pipeline/runner.py:Runner.start'), id('pipeline/runner.py:Runner._dispatch')));
    assert.ok(rel(g, 'spawn', id('pipeline/runner.py:Runner._dispatch'), id('pipeline/runner.py:process_frame')));
  });

  it('types self attributes and resolves super()', () => {
    assert.ok(rel(g, 'call', id('pipeline/runner.py:Runner._collect'), id('pipeline/stages.py:Aggregator.add')));
    assert.ok(rel(g, 'call', id('pipeline/sources.py:SensorSource.__init__'), id('pipeline/sources.py:Source.__init__')));
    assert.ok(rel(g, 'inherit', id('pipeline/sources.py:SensorSource'), id('pipeline/sources.py:Source')));
  });

  it('attributes module-level code to the module', () => {
    assert.ok(rel(g, 'call', 'py:mod:main.py', id('main.py:main')));
  });

  it('resolves module attribute calls through imports', () => {
    assert.ok(rel(g, 'call', id('pipeline/runner.py:process_frame'), id('pipeline/stages.py:decode')));
    assert.ok(rel(g, 'import', 'f:pipeline/runner.py', 'f:pipeline/stages.py'));
  });
});

describe('C ring buffer sample', () => {
  it('detects pthread_create thread entries', async () => {
    const g = await analyze(path.join(ROOT, 'samples', 'c-ringbuf'));
    assert.ok(rel(g, 'spawn', 'cc:main', 'cc:producer@main.c'));
    assert.ok(rel(g, 'spawn', 'cc:main', 'cc:consumer@main.c'));
    assert.ok(rel(g, 'call', 'cc:producer@main.c', 'cc:rb_put'));
  });
});

describe('robustness & incremental updates', () => {
  it('survives syntax errors and only re-parses changed files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
    fs.writeFileSync(path.join(dir, 'a.py'), 'def f(:\n    return g(\n\ndef g():\n    pass\n');
    fs.writeFileSync(path.join(dir, 'b.cpp'), 'int h() { return 1 +; }\nint k() { return h(); }\n');
    const pool = new ParsePool(WASM, WORKER, 0);
    let parsed = 0;
    const orig = pool.parse.bind(pool);
    pool.parse = async (jobs, p) => {
      parsed += jobs.length;
      return orig(jobs, p);
    };
    const session = new AnalysisSession(dir, pool);
    const g1 = await session.analyze(walk(dir).files);
    assert.equal(parsed, 2);
    assert.ok(g1.entities.some((e) => e.name === 'k'));
    assert.ok(rel(g1, 'call', 'cc:k', 'cc:h'));
    // touch one file
    fs.writeFileSync(path.join(dir, 'b.cpp'), 'int h() { return 1; }\nint k() { return h() + h(); }\nint m() { return k(); }\n');
    const g2 = await session.analyze(walk(dir).files);
    assert.equal(parsed, 3, 'only the changed file is parsed again');
    assert.ok(rel(g2, 'call', 'cc:m', 'cc:k'));
    pool.dispose();
  });
});
