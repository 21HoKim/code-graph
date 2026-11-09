import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codeOnly, returnStatements, statementAt } from '../src/core/snippets';
import { placeLabel } from '../src/webview/layout';

const cpp = [
  'int pick(const Table& t, int key) {', // 1
  '  // return early when empty', // 2
  '  if (t.empty()) return -1;', // 3
  '  const char* s = "return me;";', // 4
  '  auto it = t.find(key,', // 5
  '                   Policy::Exact);', // 6
  '  if (it == t.end()) {', // 7
  '    return fallback(key,', // 8
  '                    t.size());', // 9
  '  }', // 10
  '  return it->second;', // 11
  '}', // 12
].join('\n');

describe('code snippets', () => {
  it('blanks comments and strings but keeps positions', () => {
    const [a, b] = codeOnly(['x = "a;b"; // c;', 'y /* z */ = 1;'], 'cpp');
    assert.equal(a.length, 'x = "a;b"; // c;'.length);
    assert.ok(!a.includes('a;b') && !a.includes('c;'));
    assert.ok(b.startsWith('y ') && b.endsWith('= 1;') && !b.includes('z'));
  });

  it('finds every return of a C++ function as a whole statement', () => {
    const r = returnStatements(cpp, 1, 12, 'cpp');
    assert.deepEqual(
      r.map((s) => [s.first, s.last]),
      [[3, 3], [8, 9], [11, 11]],
      'not the comment on line 2 nor the string on line 4',
    );
    assert.match(r[1].lines.join('\n'), /fallback\(key,\n\s+t\.size\(\)\);/);
  });

  it('takes the whole call statement around a call site', () => {
    assert.deepEqual(statementAt(cpp, 6, 'cpp'), { first: 5, last: 6, lines: ['  auto it = t.find(key,', '                   Policy::Exact);'] });
    assert.equal(statementAt(cpp, 8, 'cpp')?.last, 9);
  });

  it('returns of a one-line C function', () => {
    assert.deepEqual(returnStatements('static int one(void) { return 1; }', 1, 1, 'c').map((s) => s.first), [1]);
  });

  it('Python: returns and yields, not those of nested functions; whole logical lines', () => {
    const py = [
      'def load(path):', // 1
      '    """return the rows"""', // 2
      '    def helper(x):', // 3
      '        return x * 2', // 4
      '    if not path:', // 5
      '        return []', // 6
      '    rows = read(path,', // 7
      '                strict=True)', // 8
      '    return [helper(r)', // 9
      '            for r in rows]', // 10
    ].join('\n');
    const r = returnStatements(py, 1, 10, 'python');
    assert.deepEqual(r.map((s) => [s.first, s.last]), [[6, 6], [9, 10]]);
    assert.deepEqual(statementAt(py, 8, 'python'), { first: 7, last: 8, lines: ['    rows = read(path,', '                strict=True)'] });
  });
});

describe('wire labels', () => {
  const blocks = [
    { x: 0, y: 0, w: 100, h: 40 },
    { x: 130, y: 0, w: 100, h: 40 },
  ];

  it('gives up on a wire between two close blocks', () => {
    assert.equal(placeLabel([{ x: 100, y: 20 }, { x: 130, y: 20 }], 90, 16, blocks, []), null);
  });

  it('moves off a block along a longer wire', () => {
    const r = placeLabel([{ x: 100, y: 20 }, { x: 115, y: 20 }, { x: 115, y: 140 }, { x: 130, y: 140 }], 60, 16, blocks, []);
    assert.ok(r);
    assert.ok(!blocks.some((b) => r.x < b.x + b.w && b.x < r.x + r.w && r.y < b.y + b.h && b.y < r.y + r.h));
  });

  it('does not stack labels', () => {
    const wire = [{ x: 0, y: 100 }, { x: 400, y: 100 }];
    const a = placeLabel(wire, 80, 16, [], [])!;
    const b = placeLabel(wire, 80, 16, [], [a])!;
    assert.ok(a && b && (b.x >= a.x + a.w || b.x + b.w <= a.x || b.y >= a.y + a.h || b.y + b.h <= a.y));
  });
});
