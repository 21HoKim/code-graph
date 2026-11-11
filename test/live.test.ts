import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { AnalysisSession, walk } from '../src/core/analyze';
import { loadParsers } from '../src/core/extract';
import { LiveTail, liveForProc, type LiveUpdate } from '../src/core/live';
import type { CodeGraph } from '../src/core/model';
import { ParsePool } from '../src/core/pool';
import { findEntries, runAndTrace, type RunInput } from '../src/core/runner';
import { detectToolchain } from '../src/core/verify';

const ROOT = path.resolve(__dirname, '..');
const WASM = path.join(ROOT, 'dist', 'wasm');
const tc = detectToolchain();
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `cc-live-${name}-`));
/** Entity id of the function `name` (C statics carry their file: cc:work@main.c). */
const fn = (id: string | undefined, name: string) => !!id && new RegExp(`[:.]${name}(@|$)`).test(id);

async function run(dir: string, extra: Partial<RunInput>): Promise<{ r: Awaited<ReturnType<typeof runAndTrace>>; g: CodeGraph }> {
  const session = new AnalysisSession(dir, new ParsePool(WASM, undefined, 0));
  const { files } = walk(dir);
  const g = await session.analyze(files);
  const r = await runAndTrace({
    root: dir,
    graph: g,
    files: files.map((f) => ({ abs: f.abs, rel: f.rel, lang: g.files.find((x) => x.path === f.rel)!.lang })),
    entry: findEntries(g)[0],
    args: [],
    toolchain: tc,
    includePaths: session.includePaths,
    buildFlags: [],
    linkFlags: [],
    runtimeDir: path.join(ROOT, 'runtime'),
    workDir: tmp('work'),
    parsers: () => loadParsers(WASM),
    timeoutMs: 20000,
    maxEvents: 200000,
    values: true,
    ...extra,
  });
  return { r, g };
}

describe('live view', () => {
  it('turns the latest "what runs now" of every trace file into one update, with the calls since the last one', () => {
    const dir = tmp('tail');
    const c = path.join(dir, 'node-a.jsonl');
    const py = path.join(dir, 'worker.jsonl');
    const g = {
      root: dir,
      files: [],
      relations: [],
      entities: [
        { id: 'cc:main', kind: 'function', name: 'main', qname: 'main', def: { file: 'main.cpp', line: 1 } },
        { id: 'cc:serve', kind: 'function', name: 'serve', qname: 'serve', def: { file: 'main.cpp', line: 5 } },
        { id: 'py:app.py:loop', kind: 'function', name: 'loop', qname: 'app.loop', def: { file: 'app.py', line: 3, endLine: 6 } },
      ],
    } as unknown as CodeGraph;
    fs.writeFileSync(c, '{"k":"h","schema":"code-graph-trace/1","lang":"cpp","pid":7}\n["c",1,1,0,null,[]]\n');
    fs.writeFileSync(py, '{"k":"h","schema":"code-graph-trace/1","lang":"python","root":"/srv","pid":9}\n');
    const updates: LiveUpdate[] = [];
    const tail = new LiveTail({
      graph: g,
      sources: () => [
        { file: c, proc: 'node-a', fns: [{ id: 'cc:main', name: 'main' }, { id: 'cc:serve', name: 'serve' }] },
        { file: py, proc: 'worker', mapFile: () => (f) => f.replace(/^src\//, '') },
      ],
      onUpdate: (u) => updates.push(u),
    });
    tail.tick();
    assert.deepEqual(updates[0].threads, [], 'nothing live yet');
    fs.appendFileSync(c, '{"k":"live","t":5,"th":[[1,"main",[0,1]],[2,"rx",[1]]],"calls":[[0,1],[1,4]],"edges":[[-1,0,1],[0,1,4]]}\n');
    fs.appendFileSync(py, '{"k":"f","id":0,"file":"src/app.py","line":3,"name":"loop","q":"loop"}\n{"k":"live","t":5,"th":[[1,"MainThread",[0]]],"calls":[[0,3]],"edges":[[-1,0,3]]}');
    tail.tick();
    const u = updates[1];
    assert.deepEqual(
      u.threads.map((x) => [x.id, x.name, x.proc]),
      [
        [1, 'main', 'node-a'],
        [2, 'rx', 'node-a'],
      ],
      'the Python line is not finished yet',
    );
    assert.deepEqual(u.stacks, [
      { th: 1, fns: ['cc:main', 'cc:serve'] },
      { th: 2, fns: ['cc:serve'] },
    ]);
    assert.deepEqual(u.edges, [
      ['cc:main', 'cc:serve', 4, 'node-a'],
      ['', 'cc:main', 1, 'node-a'],
    ]);
    assert.equal(u.calls, 5);
    assert.deepEqual(u.procs, [{ name: 'node-a', pid: 7, calls: 5, recent: 5, threads: 2 }], 'worker has no live record yet');
    fs.appendFileSync(py, '\n');
    fs.appendFileSync(c, '{"k":"live","t":9,"th":[[1,"main",[0]]],"calls":[[0,1],[1,6]],"edges":[[-1,0,1],[0,1,6]]}\n');
    tail.tick();
    const v = updates[2];
    assert.deepEqual(
      v.threads.map((x) => [x.id, x.name, x.proc]),
      [
        [1, 'main', 'node-a'],
        [3, 'MainThread', 'worker'],
      ],
    );
    assert.deepEqual(v.stacks[1], { th: 3, fns: ['py:app.py:loop'] }, 'Python functions found through the file map');
    assert.deepEqual(v.hot, [
      ['py:app.py:loop', 3, 'worker'],
      ['cc:serve', 2, 'node-a'],
    ]);
    assert.deepEqual(v.edges, [
      ['', 'py:app.py:loop', 3, 'worker'],
      ['cc:main', 'cc:serve', 2, 'node-a'],
    ]);
    assert.deepEqual(
      v.procs?.map((p) => [p.name, p.calls, p.recent, p.threads]),
      [
        ['node-a', 7, 2, 1],
        ['worker', 3, 3, 1],
      ],
    );
    // a view of one container gets only its part
    const a = liveForProc(v, 'node-a');
    assert.deepEqual(a.threads, [{ id: 1, name: 'main' }]);
    assert.deepEqual(a.stacks, [{ th: 1, fns: ['cc:main'] }]);
    assert.deepEqual(a.edges, [['cc:main', 'cc:serve', 2]]);
    assert.deepEqual(a.hot, [['cc:serve', 2]]);
    assert.equal(a.calls, 7);
  });

  it('follows a C program while it runs, and Stop ends it with its trace kept', { skip: !tc.cc }, async () => {
    const dir = tmp('c');
    fs.writeFileSync(
      path.join(dir, 'main.c'),
      [
        '#include <pthread.h>',
        '#include <unistd.h>',
        'static volatile long sink;',
        'static void work(long i) { sink += i; usleep(500); }',
        'static void *spin(void *arg) { for (long i = 0;; i++) work(i); return arg; }',
        'int main(void) {',
        '  pthread_t th;',
        '  pthread_create(&th, 0, spin, 0);',
        '  for (;;) { work(-1); usleep(2000); }',
        '}',
      ].join('\n'),
    );
    const updates: LiveUpdate[] = [];
    const finish = new AbortController();
    const { r } = await run(dir, {
      timeoutMs: 0,
      finish: finish.signal,
      live: (u) => {
        updates.push(u);
        if (updates.filter((x) => x.stacks.length).length >= 4) finish.abort();
      },
    });
    assert.ok(r.ok, r.notes.join('\n'));
    assert.equal(r.trace!.exit.stopped, true);
    assert.ok(r.notes.includes('stopped by you'));
    const busy = updates.filter((u) => u.threads.length >= 2);
    assert.ok(busy.length >= 2, `live updates with both threads (${updates.length} updates)`);
    assert.ok(
      busy.some((u) => u.stacks.some((s) => fn(s.fns.at(-1), 'work'))),
      JSON.stringify(busy.at(-1)?.stacks),
    );
    assert.ok(busy.some((u) => u.hot.some(([e, n]) => fn(e, 'work') && n > 0)), 'calls since the last update');
    assert.ok(busy.some((u) => u.edges.some(([a, b]) => fn(a, 'spin') && fn(b, 'work'))), 'caller → callee');
    assert.ok(r.trace!.spans.t.length > 10, 'the trace up to the stop is kept');
  });

  it('follows a Python program while it runs', { skip: !tc.python }, async () => {
    const dir = tmp('py');
    fs.writeFileSync(
      path.join(dir, 'app.py'),
      [
        'import threading, time',
        '',
        'def tick(i):',
        '    time.sleep(0.002)',
        '    return i',
        '',
        'def pump(n):',
        '    for i in range(n):',
        '        tick(i)',
        '',
        'if __name__ == "__main__":',
        '    t = threading.Thread(target=pump, args=(400,), name="pump")',
        '    t.start()',
        '    pump(300)',
        '    t.join()',
      ].join('\n'),
    );
    const updates: LiveUpdate[] = [];
    const { r } = await run(dir, { live: (u) => updates.push(u) });
    assert.ok(r.ok, r.notes.join('\n'));
    const seen = updates.filter((u) => u.stacks.some((s) => s.fns.some((f) => fn(f, 'pump'))));
    assert.ok(seen.length >= 1, `live updates with pump on a stack (${updates.length} updates)`);
    assert.ok(updates.some((u) => u.threads.some((t) => t.name === 'pump')), 'the thread by its name');
    assert.ok(updates.some((u) => u.hot.some(([e]) => fn(e, 'tick'))));
  });
});
