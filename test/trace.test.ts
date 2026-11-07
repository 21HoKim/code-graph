import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { AnalysisSession, walk } from '../src/core/analyze';
import { loadParsers } from '../src/core/extract';
import { instrumentSources } from '../src/core/instrument';
import type { CodeGraph } from '../src/core/model';
import { ParsePool } from '../src/core/pool';
import { findEntries, runAndTrace, selectUnits, type RunResult } from '../src/core/runner';
import { parseTrace } from '../src/core/trace';
import { detectToolchain } from '../src/core/verify';

const ROOT = path.resolve(__dirname, '..');
const WASM = path.join(ROOT, 'dist', 'wasm');
const tc = detectToolchain();
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `cc-test-${name}-`));

async function analyze(dir: string): Promise<{ g: CodeGraph; session: AnalysisSession; files: ReturnType<typeof walk>['files'] }> {
  const session = new AnalysisSession(dir, new ParsePool(WASM, undefined, 0));
  const { files } = walk(dir);
  return { g: await session.analyze(files), session, files };
}

async function trace(dir: string, entryFile?: string, args: string[] = []): Promise<{ r: RunResult; g: CodeGraph }> {
  const { g, session, files } = await analyze(dir);
  const entries = findEntries(g);
  const entry = entryFile ? entries.find((e) => e.file === entryFile)! : entries[0];
  assert.ok(entry, `entry point in ${dir}`);
  const r = await runAndTrace({
    root: dir,
    graph: g,
    files: files.map((f) => ({ abs: f.abs, rel: f.rel, lang: g.files.find((x) => x.path === f.rel)!.lang })),
    entry,
    args,
    toolchain: tc,
    includePaths: session.includePaths,
    buildFlags: [],
    linkFlags: [],
    runtimeDir: path.join(ROOT, 'runtime'),
    workDir: tmp('run'),
    parsers: () => loadParsers(WASM),
    timeoutMs: 20000,
    maxEvents: 200000,
    values: true,
  });
  return { r, g };
}

describe('trace parsing', () => {
  it('builds nested spans from out-of-order per-thread lines', () => {
    const text = [
      '{"k":"h","schema":"code-graph-trace/1","lang":"cpp","clock":"ns"}',
      '{"k":"t","id":2,"t":50,"name":"thread-2"}',
      '["c",60,2,1,null,[["n","i","3"]]]',
      '["r",90,2,1]',
      '{"k":"t","id":1,"t":0,"name":"main"}',
      '["c",10,1,0,null,[]]',
      '["c",20,1,1,"0x10",[["n","i","1"]]]',
      '["r",30,1,1]',
      '["r",100,1,0]',
      '{"k":"end","t":120,"events":6,"dropped":0}',
    ].join('\n');
    const g: CodeGraph = { schema: 1, root: 'x', generatedAt: '', files: [], entities: [], relations: [], stats: {} as CodeGraph['stats'] };
    const tr = parseTrace(text, g, { fns: [{ id: 'cc:main', name: 'main' }, { id: 'cc:work', name: 'work' }] });
    assert.deepEqual(tr.spans.t, [10, 20, 60]);
    assert.deepEqual(tr.spans.end, [100, 30, 90]);
    assert.deepEqual(tr.spans.parent, [-1, 0, -1]);
    assert.deepEqual(tr.spans.depth, [0, 1, 0]);
    assert.equal(tr.selfs[1], '0x10');
    assert.deepEqual(tr.args[2], [['n', 'i', '3']]);
    assert.equal(tr.threads.find((t) => t.id === 2)?.entry, 1);
  });
});

describe('C/C++ instrumentation', () => {
  it('inserts probes on the brace line, skips constexpr, knows when `this` exists', async () => {
    const dir = tmp('inst');
    fs.writeFileSync(
      path.join(dir, 'a.cpp'),
      [
        'struct S {',
        '  static int count() { return 1; }',
        '  int get(const S& o, int* p, double d) const { return o.v + *p + (int)d; }',
        '  constexpr int k() const { return 3; }',
        '  int v = 0;',
        '};',
        'int S_helper(int n) {',
        '  return n;',
        '}',
        'int main() { S s; int x = 1; return s.get(s, &x, 2.0) + S::count() + S_helper(1); }',
      ].join('\n'),
    );
    const { g, files } = await analyze(dir);
    const out = path.join(dir, 'out');
    const r = instrumentSources({ files: files.map((f) => ({ abs: f.abs, rel: f.rel, lang: 'cpp' as const })), outDir: out, graph: g, parsers: await loadParsers(WASM) });
    const text = fs.readFileSync(path.join(out, 'a.cpp'), 'utf8');
    const lines = text.split('\n');
    assert.equal(lines.length, 10, 'line numbers are preserved');
    assert.match(lines[1], /cgt_s_\(\d+u, nullptr\)/, 'static member: no this');
    assert.match(lines[2], /cgt_s_\(\d+u, this\);.*::cgt::arg\("o", o, 1\);.*::cgt::arg\("p", p, 0\);.*::cgt::arg\("d", d, 0\)/);
    assert.doesNotMatch(lines[3], /cgt/, 'constexpr is left alone');
    assert.match(lines[6], /cgt_s_\(\d+u, nullptr\); ::cgt::arg\("n", n, 0\);$/);
    assert.equal(r.fns.length, 4);
    assert.ok(r.skipped.some((s) => s.why === 'constexpr'));
    assert.ok(r.fns.every((f) => f.id), 'every probe maps to an entity');
  });

  it('selects the translation units main needs (and not other mains)', async () => {
    const { g, files } = await analyze(path.join(ROOT, 'samples', 'cpp-router'));
    const main = g.entities.find((e) => e.name === 'main')!;
    const units = selectUnits(g, main, files);
    assert.ok(units.includes('src/main.cpp'));
    assert.ok(units.includes('src/net/router.cpp'));
    assert.ok(units.includes('src/crc/crc32.c'), 'C unit reached through calls');
  });
});

const native = !!(tc.cc && tc.cxx);
const py = !!tc.python;

describe('Run & Trace (C++ threads)', { skip: !native }, () => {
  it('records rx/tx threads, values and the shared router/queue', async () => {
    const { r } = await trace(path.join(ROOT, 'samples', 'cpp-router'));
    assert.ok(r.ok, r.notes.join('\n'));
    const tr = r.trace!;
    assert.equal(tr.exit.code, 0);
    assert.deepEqual(
      tr.threads.map((t) => t.name),
      ['main', 'rxLoop', 'txLoop #1', 'txLoop #2', 'txLoop #3', 'txLoop #4'],
    );
    assert.ok(tr.threads.slice(1).every((t) => t.parent === 1), 'worker threads were started by main');
    assert.ok(tr.fns.every((f) => f.id), 'all probes map to entities');
    const shared = tr.objects.filter((o) => o.threads.length > 1).map((o) => o.label);
    assert.ok(shared.includes('Router') && shared.includes('PacketQueue'), shared.join(', '));
    const add = tr.fns.findIndex((f) => f.id.endsWith('RouteTable::add'));
    const span = tr.spans.fn.indexOf(add);
    assert.deepEqual(tr.args[span].map((a) => a[0]), ['prefix', 'length', 'port']);
  });
});

describe('Run & Trace (C producer/consumer)', { skip: !native }, () => {
  it('sees the ring buffer shared by both threads', async () => {
    const { r } = await trace(path.join(ROOT, 'samples', 'c-ringbuf'));
    const tr = r.trace!;
    assert.equal(tr.exit.code, 0);
    assert.deepEqual(tr.threads.map((t) => t.name).sort(), ['consumer', 'main', 'producer']);
    const rb = tr.objects.find((o) => o.label.includes('ringbuf'));
    assert.ok(rb && rb.threads.length === 3);
  });
});

describe('Run & Trace (failures)', () => {
  it('C++ crash: the function that crashed turns red, with the stack of every thread', { skip: !native }, async () => {
    const dir = tmp('crash');
    fs.writeFileSync(
      path.join(dir, 'main.cpp'),
      ['#include <vector>', 'int pick(const std::vector<int>& v, int i) {', '  return v.at(i);', '}', 'int main() {', '  std::vector<int> v{1, 2};', '  return pick(v, 5);', '}'].join('\n'),
    );
    const { r } = await trace(dir);
    const tr = r.trace!;
    assert.equal(tr.exit.crash, 'SIGABRT');
    assert.equal(r.runtimeDiagnostics.length, 1);
    const d = r.runtimeDiagnostics[0];
    assert.equal(d.target, 'cc:pick');
    assert.match(d.message, /out_of_range/);
    assert.deepEqual(tr.exceptions[0].frames?.map(([f]) => tr.fns[f].name), ['main', 'pick']);
  });

  it('build errors come back as diagnostics instead of a trace', { skip: !native }, async () => {
    const { r } = await trace(path.join(ROOT, 'samples', 'broken-cpp'));
    assert.equal(r.ok, false);
    assert.ok(r.buildDiagnostics.some((d) => d.file === 'src/sensor.cpp' && d.line === 17));
  });

  it('Python: uncaught exception in a thread and in main, with values and returns', { skip: !py }, async () => {
    const dir = tmp('py');
    fs.writeFileSync(
      path.join(dir, 'app.py'),
      [
        'import threading',
        '',
        'def average(xs):',
        '    return sum(xs) / len(xs)',
        '',
        'def worker(box):',
        '    box.append(average([]))',
        '',
        'def report(box):',
        '    return len(box)',
        '',
        'def main():',
        '    box = []',
        '    t = threading.Thread(target=worker, args=(box,), name="calc")',
        '    t.start()',
        '    t.join()',
        '    print(average([1, 2, 3]), report(box))',
        '',
        'if __name__ == "__main__":',
        '    main()',
      ].join('\n'),
    );
    const { r } = await trace(dir);
    const tr = r.trace!;
    assert.equal(tr.exit.code, 0, 'the thread dies, the program does not');
    assert.deepEqual(tr.threads.map((t) => t.name), ['MainThread', 'calc']);
    assert.equal(tr.threads[1].parent, 1);
    const avg = tr.fns.findIndex((f) => f.name === 'average');
    const ok = tr.spans.fn.findIndex((f, i) => f === avg && tr.spans.th[i] === 1);
    assert.deepEqual(tr.args[ok][0].slice(0, 3), ['xs', 'c', '[1, 2, 3]']);
    assert.deepEqual(tr.rets[ok].slice(0, 2), ['d', '2.0']);
    assert.equal(r.runtimeDiagnostics.length, 1);
    assert.match(r.runtimeDiagnostics[0].message, /ZeroDivisionError.*calc/);
    assert.equal(r.runtimeDiagnostics[0].line, 4);
    const box = tr.objects.find((o) => o.label === '[]' || o.label.startsWith('list'));
    assert.ok(box && box.threads.length === 2, 'the list handed to the thread is followed across both threads');
  });
});
