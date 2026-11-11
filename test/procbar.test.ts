import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { liveWindow } from '../src/webview/livelanes';
import { nextSelection, sparkPath } from '../src/webview/procbar';

describe('container cards', () => {
  const sel = (...xs: string[]) => new Set(xs);

  it('a click shows only that container; clicking the only one shown shows all again', () => {
    assert.deepEqual([...nextSelection(sel(), 'node-a', false)], ['node-a']);
    assert.deepEqual([...nextSelection(sel('node-a'), 'node-b', false)], ['node-b']);
    assert.deepEqual([...nextSelection(sel('node-a'), 'node-a', false)], []);
    assert.deepEqual([...nextSelection(sel('node-a', 'node-b'), 'node-a', false)], ['node-a'], 'of two, only the clicked one');
  });

  it('Ctrl / ⌘ + click adds or removes one', () => {
    assert.deepEqual([...nextSelection(sel('node-a'), 'node-b', true)], ['node-a', 'node-b']);
    assert.deepEqual([...nextSelection(sel('node-a', 'node-b'), 'node-a', true)], ['node-b']);
  });

  it('draws activity as a sparkline scaled to its peak', () => {
    assert.equal(sparkPath([5]), '', 'one value is no line');
    const p = sparkPath([0, 10, 5]);
    assert.match(p, /M0\.0,15\.5 L50\.0,1\.5 L100\.0,8\.5/);
  });
});

describe('live swimlanes', () => {
  it('follow now, or stay where the user moved them, inside the run', () => {
    assert.deepEqual(liveWindow(true, 0, 30_000, 100_000, 0), [70_000, 100_000]);
    assert.deepEqual(liveWindow(true, 0, 30_000, 9_000, 0), [0, 30_000], 'a young run fills from the left');
    assert.deepEqual(liveWindow(false, 50_000, 30_000, 100_000, 0), [20_000, 50_000], 'moved back');
    assert.deepEqual(liveWindow(false, 10_000, 30_000, 100_000, 0), [0, 30_000], 'not before the start');
    assert.deepEqual(liveWindow(false, 500_000, 30_000, 100_000, 0), [70_000, 100_000], 'not past now');
  });
});
