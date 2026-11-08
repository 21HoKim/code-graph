import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { AnalysisSession, walk } from '../src/core/analyze';
import { loadParsers } from '../src/core/extract';
import { instrumentSources } from '../src/core/instrument';
import type { CodeGraph } from '../src/core/model';
import { ParsePool } from '../src/core/pool';
import { libraryDirs, readMakeTargets } from '../src/core/buildinfo';
import { findEntries, runAndTrace, selectUnits, type RunInput, type RunResult } from '../src/core/runner';
import { mergeTraces, parseTrace, processTrace } from '../src/core/trace';
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

async function trace(dir: string, entryFile?: string, args: string[] = [], extra: Partial<RunInput> = {}): Promise<{ r: RunResult; g: CodeGraph }> {
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
    ...extra,
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

describe('traces of several processes', () => {
  const g: CodeGraph = { root: '/x', files: [], entities: [], relations: [] } as unknown as CodeGraph;
  const fns = [
    { id: 'a', name: 'main' },
    { id: 'b', name: 'serve' },
  ];
  const one = (pid: number, mono: number, self: string) =>
    parseTrace(
      [
        `{"k":"h","schema":"code-graph-trace/1","lang":"cpp","clock":"ns","pid":${pid},"mono":${mono},"exe":"node"}`,
        '{"k":"t","id":1,"t":0,"name":"main"}',
        `["c",10,1,0,"${self}",[]]`,
        `["c",20,1,1,"${self}",[]]`,
        '["r",30,1,1]',
        `["c",40,1,1,"${self}",[]]`,
        '["r",50,1,1]',
        '["r",60,1,0]',
      ].join('\n'),
      g,
      { fns },
    );

  it('lines processes up on one clock and keeps their threads and objects apart', () => {
    const a = one(1, 1_000_000, '0x10');
    const b = one(1, 1_000_015, '0x10');
    assert.equal(a.clock?.mono, 1_000_000);
    const m = mergeTraces(
      [
        { name: 'node-b', trace: b },
        { name: 'node-a', trace: a },
      ],
      g,
      { command: 'compose' },
    );
    // node-a started first: it comes first
    assert.deepEqual(
      m.threads.map((t) => t.name),
      ['node-a · main', 'node-b · main'],
    );
    assert.deepEqual(
      m.procs?.map((p) => [p.name, p.threads]),
      [
        ['node-a', [1]],
        ['node-b', [2]],
      ],
    );
    assert.deepEqual(
      m.threads.map((t) => t.id),
      [1, 2],
    );
    assert.equal(m.spans.t.length, 6);
    // node-a started 15 ns earlier: its calls come first on the common clock
    assert.deepEqual(m.spans.t.slice(0, 3), [10, 20, 25]);
    for (let i = 1; i < m.spans.t.length; i++) assert.ok(m.spans.t[i] >= m.spans.t[i - 1]);
    for (let i = 0; i < m.spans.t.length; i++) if (m.spans.parent[i] >= 0) assert.equal(m.spans.th[m.spans.parent[i]], m.spans.th[i]);
    // the same address in two processes is two objects
    assert.deepEqual(m.objects.map((o) => o.id).sort(), ['node-a/0x10', 'node-b/0x10']);
    assert.deepEqual(m.calls.sort(), [
      [0, 2],
      [1, 4],
    ]);
  });

  it('cuts one process out again, on the same clock, for a view per container', () => {
    const m = mergeTraces(
      [
        { name: 'node-b', trace: one(1, 1_000_015, '0x10') },
        { name: 'node-a', trace: one(1, 1_000_000, '0x20') },
      ],
      g,
      { command: 'compose' },
    );
    const b = processTrace(m, 'node-b', g)!;
    assert.equal(b.command, 'node-b');
    assert.equal(b.procs, undefined);
    assert.deepEqual(
      b.threads.map((t) => [t.id, t.name]),
      [[2, 'main']],
    );
    assert.deepEqual(b.spans.t, [25, 35, 55]);
    assert.deepEqual(b.spans.parent, [-1, 0, 0]);
    assert.ok(b.spans.th.every((th) => th === 2));
    assert.equal(b.durationNs, m.durationNs, 'the views share one time axis');
    assert.deepEqual(b.objects.map((o) => o.id), ['node-b/0x10']);
    assert.deepEqual(b.calls.sort(), [
      [0, 1],
      [1, 2],
    ]);
    assert.equal(processTrace(m, 'nope', g), undefined);
  });
});

describe('library folders of a link', () => {
  it('reads -L and every spelling of -rpath, leaves out system and missing folders', () => {
    const dir = tmp('libdirs');
    const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((x) => (fs.mkdirSync(path.join(dir, x)), path.join(dir, x)));
    assert.deepEqual(
      libraryDirs([
        `-L${a}`,
        '-L',
        b,
        `-Wl,-rpath,${c}:${a}`,
        '-Wl,-rpath',
        `-Wl,${d}`,
        `-Wl,--rpath=${e}`,
        '-L/usr/lib/x86_64-linux-gnu',
        '-L/usr/lib64',
        `-L${path.join(dir, 'missing')}`,
        '-Wl,-rpath,$ORIGIN',
        '-lboost_json',
      ], a),
      [a, b, c, d, e],
    );
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
    // threads are listed as they first ran: rx may start after some tx threads
    assert.deepEqual(
      tr.threads.map((t) => t.name).sort(),
      ['main', 'rxLoop', 'txLoop #1', 'txLoop #2', 'txLoop #3', 'txLoop #4'],
    );
    assert.equal(tr.threads[0].name, 'main');
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

describe('Run & Trace (build system)', { skip: !native }, () => {
  const PAIR = path.join(ROOT, 'samples', 'net-pair');

  it('builds the makefile program with its defines and libraries, and runs it where make links it', async () => {
    const { targets } = await readMakeTargets(PAIR);
    const target = targets.find((t) => t.name === 'node-b')!;
    const { r } = await trace(PAIR, 'src/main.cpp', [], { target, timeoutMs: 2500 });
    assert.ok(r.ok, r.notes.join('\n'));
    const ran = new Set(r.trace!.spans.fn.map((f) => r.trace!.fns[f]?.id ?? ''));
    // reading ../cfg/node-b.conf only works from src/, where make links node-b
    assert.ok([...ran].some((id) => id.endsWith('Config::load')), 'config loaded');
    assert.ok([...ran].some((id) => id.endsWith('Server::run')), 'ran as node-b');
  });

  it('runs a program whose libraries load libraries of their own from the same folder', async () => {
    // liba.so needs libb.so: with -Wl,-rpath written as a RUNPATH (Ubuntu, Debian …) the loader finds
    // liba for the program but not libb for liba, unless the folder is on the library path
    const lib = tmp('libs');
    fs.writeFileSync(path.join(lib, 'b.c'), 'int b(void) { return 7; }\n');
    fs.writeFileSync(path.join(lib, 'a.c'), 'int b(void);\nint a(void) { return b() + 1; }\n');
    const cc = (args: string[]) => assert.equal(spawnSync(tc.cc!, args, { cwd: lib, encoding: 'utf8' }).status, 0, args.join(' '));
    cc(['-shared', '-fPIC', '-o', 'libb.so', 'b.c']);
    cc(['-shared', '-fPIC', '-o', 'liba.so', 'a.c', '-L.', '-lb']);
    const dir = tmp('libuser');
    fs.writeFileSync(path.join(dir, 'main.c'), '#include <stdio.h>\nint a(void);\nint main(void) {\n  printf("a=%d\\n", a());\n  return 0;\n}\n');
    fs.writeFileSync(path.join(dir, 'makefile'), `app: main.c\n\t${tc.cc} -o app main.c -L${lib} -Wl,-rpath,${lib} -la\n`);
    const { targets } = await readMakeTargets(dir);
    const { r } = await trace(dir, 'main.c', [], { target: targets.find((t) => t.name === 'app')!, timeoutMs: 5000 });
    assert.ok(r.ok, [...r.notes, r.output].join('\n'));
    assert.equal(r.trace!.exit.code, 0);
    assert.match(r.trace!.output, /a=8/);
  });

  it('guesses the library when a link without build info misses its symbols', async () => {
    const { r } = await trace(PAIR, 'src/main.cpp', [], { buildFlags: ['-DNODE_B'], timeoutMs: 2500 });
    assert.ok(r.ok, r.notes.join('\n'));
    assert.ok(r.notes.some((n) => n.includes('-lcrypto') && n.includes('OpenSSL')), r.notes.join('\n'));
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
