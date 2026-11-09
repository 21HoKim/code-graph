import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { peekLines } from '../src/core/peek';
import { clipLabel, LABEL_MAX } from '../src/webview/layout';

describe('peekLines', () => {
  const c = [
    '#include <stdio.h>',
    '',
    '/* Ring buffer push.',
    ' * Drops the oldest item when full. */',
    'static int push(ring *r, int v)',
    '{',
    '\tif (full(r))',
    '\t\tr->tail++;',
    '\tr->buf[r->head++] = v;',
    '\treturn 0;',
    '}',
  ].join('\n');

  it('takes the comment above, the header and the start of the body', () => {
    const p = peekLines(c, 5, { endLine: 11, count: 4 });
    assert.equal(p.first, 3);
    assert.deepEqual(p.lines, ['/* Ring buffer push.', ' * Drops the oldest item when full. */', 'static int push(ring *r, int v)', '{', '    if (full(r))', '        r->tail++;']);
    assert.equal(p.more, true);
  });

  it('stops at the end of the definition', () => {
    const p = peekLines(c, 5, { endLine: 11, count: 50 });
    assert.equal(p.first + p.lines.length - 1, 11);
    assert.equal(p.more, false);
  });

  it('does not take preprocessor lines for comments', () => {
    const p = peekLines('#include <a.h>\n#define N 4\nint f(void) { return N; }', 3, { count: 1 });
    assert.equal(p.first, 3);
    assert.deepEqual(p.lines, ['int f(void) { return N; }']);
  });

  it('takes Python comments and decorators, and dedents a method', () => {
    const py = 'class A:\n    # cached\n    @property\n    def size(self):\n        return len(self.items)\n';
    const p = peekLines(py, 4, { endLine: 5 });
    assert.equal(p.first, 2);
    assert.deepEqual(p.lines, ['# cached', '@property', 'def size(self):', '    return len(self.items)']);
  });

  it('shows just the line of a call', () => {
    const p = peekLines(c, 7, { count: 1, lead: 0 });
    assert.deepEqual(p, { first: 7, lines: ['if (full(r))'], more: true });
  });

  it('cuts long lines and survives lines past the end', () => {
    const p = peekLines('x'.repeat(300), 9, { width: 20 });
    assert.equal(p.first, 1);
    assert.equal(p.lines[0].length, 20);
    assert.ok(p.lines[0].endsWith('…'));
  });
});

describe('clipLabel', () => {
  it('leaves short labels alone', () => {
    assert.equal(clipLabel('(n, buf)'), '(n, buf)');
  });

  it('cuts long labels to LABEL_MAX', () => {
    const s = clipLabel('configuration_manager=…, connection_pool_size=128');
    assert.equal(s.length, LABEL_MAX);
    assert.ok(s.endsWith('…'));
  });

  it('keeps both ends of addresses and hashes', () => {
    assert.equal(clipLabel('key=0x7f3a1c2e9b40c0e1, n=32', 24), 'key=0x7f3a…c0e1, n=32');
    assert.equal(clipLabel('digest=9f86d081884c7d659a2feaa0c55ad015', 24), 'digest=9f86…d015');
  });
});
