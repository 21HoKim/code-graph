import assert from 'node:assert/strict';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { AnalysisSession, walk } from '../src/core/analyze';
import type { CodeGraph, RelationKind } from '../src/core/model';
import { ParsePool } from '../src/core/pool';
import { ALL_KINDS, availableLevels, buildTree, hasSymbolsMode, pickLevel, project, type ProjectOptions, type ViewKind } from '../src/webview/projection';

const ROOT = path.resolve(__dirname, '..');

async function sample(name: string): Promise<CodeGraph> {
  const pool = new ParsePool(path.join(ROOT, 'dist', 'wasm'), undefined, 0);
  const dir = path.join(ROOT, 'samples', name);
  return new AnalysisSession(dir, pool).analyze(walk(dir).files);
}

let g: CodeGraph;
let py: CodeGraph;
let c: CodeGraph;
before(async () => {
  [g, py, c] = await Promise.all([sample('cpp-router'), sample('py-pipeline'), sample('c-ringbuf')]);
});

describe('language-aware levels', () => {
  it('C++ has every level', () => {
    assert.deepEqual(availableLevels(buildTree(g, 'files'), g), ['dir', 'file', 'namespace', 'class', 'function']);
    assert.ok(hasSymbolsMode(g));
  });

  it('Python has no namespace level and no symbols grouping', () => {
    assert.deepEqual(availableLevels(buildTree(py, 'files'), py), ['dir', 'file', 'class', 'function']);
    assert.equal(hasSymbolsMode(py), false);
    const t = buildTree(py, 'symbols');
    assert.ok(![...t.nodes.values()].some((n) => n.kind === 'namespace'), 'packages/modules are not namespaces');
    assert.equal(t.nodes.get('e:py:pkg:pipeline')?.kind, 'dir');
    assert.equal(t.nodes.get('e:py:mod:pipeline/runner.py')?.kind, 'file');
  });

  it('C has neither namespaces nor classes (structs are not a level)', () => {
    assert.deepEqual(availableLevels(buildTree(c, 'files'), c), ['file', 'function']);
    const t = buildTree(c, 'symbols');
    assert.ok(![...t.nodes.values()].some((n) => n.kind === 'namespace'), 'no "(global)" namespace for C');
  });

  it('marks Python package folders', () => {
    const t = buildTree(py, 'files');
    assert.equal(t.nodes.get('d:pipeline')?.tag, 'pkg');
  });
});

const opts = (level: ViewKind, extra: Partial<ProjectOptions> = {}): ProjectOptions => ({
  level,
  expand: new Set(),
  collapse: new Set(),
  kinds: new Set<RelationKind>(ALL_KINDS),
  minConf: 'guess',
  ...extra,
});

describe('view tree', () => {
  it('places out-of-line methods in a class fragment of the defining file', () => {
    const t = buildTree(g, 'files');
    const node = t.nodes.get(t.entityNode.get('cc:net::Router::start')!)!;
    const cls = t.nodes.get(node.parent!)!;
    assert.equal(cls.kind, 'class');
    assert.equal(cls.fragment, true);
    assert.equal(t.nodes.get(cls.parent!)!.kind, 'namespace');
    assert.ok(cls.id.startsWith('f:src/net/router.cpp|'));
  });

  it('merges a class across files in symbols mode', () => {
    const t = buildTree(g, 'symbols');
    const router = t.nodes.get('e:cc:net::Router')!;
    const names = router.children.map((c) => t.nodes.get(c)!.label);
    assert.ok(names.includes('start') && names.includes('rxLoop') && names.includes('Router'));
  });

  it('compacts single-child folder chains', () => {
    const t = buildTree(g, 'files');
    assert.ok([...t.nodes.values()].some((n) => n.kind === 'dir' && n.label === 'include/net'));
  });
});

describe('projection', () => {
  it('lifts calls to file level and aggregates parallel wires', () => {
    const t = buildTree(g, 'files');
    const p = project(t, g, opts('file'));
    const e = p.edges.find((x) => x.kind === 'call' && x.src === 'f:src/net/router.cpp' && x.dst === 'f:src/net/queue.cpp');
    assert.ok(e, 'router.cpp -> queue.cpp');
    assert.ok(e.rels.length >= 3, 'push, pop and close are merged into one wire');
    assert.ok(p.nodes.get('f:src/net/router.cpp')!.internal > 0, 'calls inside router.cpp become internal');
    assert.ok(!p.edges.some((x) => x.src === x.dst));
  });

  it('shows thread spawns at function level', () => {
    const t = buildTree(g, 'files');
    const p = project(t, g, opts('function'));
    const start = t.entityNode.get('cc:net::Router::start')!;
    const rx = t.entityNode.get('cc:net::Router::rxLoop')!;
    assert.ok(p.edges.some((e) => e.kind === 'spawn' && e.src === start && e.dst === rx));
  });

  it('collapsing a container re-routes its wires to the block', () => {
    const t = buildTree(g, 'files');
    const p = project(t, g, opts('function', { collapse: new Set(['f:src/net/router.cpp']) }));
    const n = p.nodes.get('f:src/net/router.cpp')!;
    assert.equal(n.container, false);
    assert.ok(p.edges.some((e) => e.src === 'f:src/net/router.cpp' && e.kind === 'call'));
  });

  it('focus keeps only the neighbourhood', () => {
    const t = buildTree(g, 'files');
    const full = project(t, g, opts('file'));
    const p = project(t, g, opts('file', { focus: { id: 'f:src/net/queue.cpp', hops: 1 } }));
    assert.ok(p.leaves < full.leaves);
    assert.ok(p.nodes.has('f:src/net/router.cpp'));
    assert.ok(!p.nodes.has('f:src/crc/crc32.c'));
  });

  it('hides guessed links on request', () => {
    const t = buildTree(g, 'files');
    const all = project(t, g, opts('function'));
    const sure = project(t, g, opts('function', { minConf: 'likely' }));
    assert.ok(sure.edges.length < all.edges.length);
    assert.ok(sure.edges.every((e) => e.conf !== 'guess'));
  });

  it('picks a readable starting level', () => {
    const lvl = pickLevel(buildTree(g, 'files'));
    assert.ok(['namespace', 'class', 'function', 'file'].includes(lvl));
  });
});
