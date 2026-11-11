import assert from 'node:assert/strict';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { AnalysisSession, walk } from '../src/core/analyze';
import { attachDiagnostics, computeHealth, impactPath } from '../src/core/health';
import type { CodeGraph, Diagnostic } from '../src/core/model';
import { ParsePool } from '../src/core/pool';
import { detectToolchain, parseCompilerOutput, parseLinkerErrors, splitCommand, syntaxOnly, verifyWorkspace } from '../src/core/verify';

const ROOT = path.resolve(__dirname, '..');
const tc = detectToolchain();

async function analyze(name: string): Promise<{ g: CodeGraph; dir: string; session: AnalysisSession }> {
  const dir = path.join(ROOT, 'examples', name);
  const session = new AnalysisSession(dir, new ParsePool(path.join(ROOT, 'dist', 'wasm'), undefined, 0));
  const g = await session.analyze(walk(dir).files);
  return { g, dir, session };
}

async function verify(name: string, g: CodeGraph, dir: string, session: AnalysisSession) {
  return verifyWorkspace({
    root: dir,
    files: walk(dir).files.map((f) => ({ abs: f.abs, rel: f.rel, lang: g.files.find((x) => x.path === f.rel)!.lang })),
    includePaths: session.includePaths,
    toolchain: tc,
  });
}

describe('compiler output parsing', () => {
  it('reads gcc/clang diagnostics and linker errors', () => {
    const out = [
      '/w/src/a.cpp:12:5: error: ‘ofset_’ was not declared in this scope',
      'src/b.c:3:10: fatal error: missing.h: No such file or directory',
      '/usr/include/x.h:1:1: error: outside',
      'src/a.cpp:20:1: warning: unused variable',
      'In file included from src/a.cpp:3:',
    ].join('\n');
    const { diags, outside } = parseCompilerOutput(out, '/w', '/w');
    assert.equal(diags.length, 3);
    assert.deepEqual(diags.map((d) => [d.file, d.line, d.severity]), [
      ['src/a.cpp', 12, 'error'],
      ['src/b.c', 3, 'error'],
      ['src/a.cpp', 20, 'warning'],
    ]);
    assert.equal(outside, 1);
    assert.deepEqual(parseLinkerErrors("main.cpp:(.text+0x1c): undefined reference to `telemetry::flush()'\nld: error: undefined symbol: foo"), [
      'telemetry::flush()',
      'foo',
    ]);
  });

  it('turns compile_commands entries into syntax-only checks', () => {
    const args = splitCommand('/usr/bin/c++ -DX=1 -I"inc dir" -o CMakeFiles/a.o -c /w/src/a.cpp -MD -MF a.d');
    assert.deepEqual(syntaxOnly(args), ['-DX=1', '-Iinc dir', '/w/src/a.cpp', '-fsyntax-only']);
  });
});

describe('broken C++ sample', () => {
  let g: CodeGraph;
  let diags: Diagnostic[];
  before(async () => {
    const a = await analyze('cpp/features/problems');
    g = a.g;
    const v = tc.cxx ? await verify('cpp/features/problems', g, a.dir, a.session) : undefined;
    diags = attachDiagnostics(g, [...(g.diagnostics ?? []), ...(v?.diagnostics ?? [])]);
  });

  it('finds the missing implementation statically', () => {
    const d = diags.find((x) => x.source === 'incomplete');
    assert.equal(d?.target, 'cc:telemetry::flush');
  });

  it('pins the compile error on Sensor::calibrate', { skip: !tc.cxx && 'no C++ compiler' }, () => {
    const d = diags.find((x) => x.source === 'compiler' && x.severity === 'error');
    assert.ok(d, 'compiler error found');
    assert.equal(d.file, 'src/sensor.cpp');
    assert.equal(d.target, 'cc:telemetry::Sensor::calibrate');
  });

  it('computes cut wires, impact and unpowered blocks', { skip: !tc.cxx && 'no C++ compiler' }, () => {
    const h = computeHealth(g, diags);
    assert.ok(h.broken.has('cc:telemetry::Sensor::calibrate'));
    assert.ok(h.broken.has('cc:telemetry::flush'));
    assert.equal(h.affected.get('cc:telemetry::Sensor::read')?.dist, 1);
    assert.ok(h.affected.has('cc:main'));
    assert.ok(h.unpowered.has('cc:telemetry::clampRange'), 'only reachable through the broken calibrate()');
    assert.ok(!h.unpowered.has('cc:telemetry::movingAverage'));
    const cut = g.relations.filter((r) => h.cut.has(r.id)).map((r) => `${r.from}>${r.to}`);
    assert.ok(cut.includes('cc:telemetry::Sensor::read>cc:telemetry::Sensor::calibrate'));
    const p = impactPath(h, g, 'cc:main');
    assert.ok(h.broken.has(p[p.length - 1].node));
  });
});

describe('broken Python sample', () => {
  let g: CodeGraph;
  let diags: Diagnostic[];
  before(async () => {
    const a = await analyze('python/features/problems');
    g = a.g;
    const v = tc.python ? await verify('python/features/problems', g, a.dir, a.session) : undefined;
    // the interpreter's verdict replaces tree-sitter's coarse one
    const stat = (g.diagnostics ?? []).filter((d) => !(v?.pyChecked && d.source === 'syntax'));
    diags = attachDiagnostics(g, [...stat, ...(v?.diagnostics ?? [])]);
  });

  it('reports the syntax error for the whole module', { skip: !tc.python && 'no python' }, () => {
    const d = diags.find((x) => x.file === 'report.py' && x.severity === 'error');
    assert.match(d!.message, /SyntaxError/);
    assert.equal(d!.target, 'f:report.py');
  });

  it('flags undefined names and called NotImplementedError stubs', () => {
    assert.equal(diags.find((d) => /name 'total'/.test(d.message))?.target, 'py:metrics.py:summarize');
    assert.equal(diags.find((d) => d.source === 'incomplete')?.target, 'py:exporters.py:Exporter.write');
  });

  it('spreads the damage to importers and callers', { skip: !tc.python && 'no python' }, () => {
    const h = computeHealth(g, diags);
    assert.ok(h.broken.has('f:report.py'));
    assert.ok(h.affected.has('f:app.py'), 'app.py imports the broken module');
    assert.ok(h.affected.has('py:app.py:main'), 'main calls broken functions');
    assert.ok(g.relations.some((r) => h.cut.has(r.id) && r.to === 'py:report.py:render'), 'wire into a function of the broken module is cut');
  });
});
