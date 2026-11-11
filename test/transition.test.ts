import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyFit, durationFor, fitOnto, transformTo } from '../src/webview/transition';

describe('open / close transition', () => {
  const block = { x: 100, y: 50, w: 120, h: 40 };
  const container = { x: 100, y: 50, w: 480, h: 200 };

  it('maps a box onto another (the container at the size of the block it was)', () => {
    const f = fitOnto(container, block);
    assert.deepEqual(applyFit(f, container), block);
    // a child placed inside the new container starts at the same place inside the old block
    const child = { x: 340, y: 150, w: 120, h: 40 };
    const at = applyFit(f, child);
    assert.ok(at.x >= block.x && at.x + at.w <= block.x + block.w + 1e-9 && at.y >= block.y && at.y + at.h <= block.y + block.h + 1e-9);
  });

  it('a block group moves by its own origin, a container by the world origin', () => {
    assert.equal(transformTo(block, { ...block, x: 0, y: 0 }, true), 'translate(100.00px, 50.00px) scale(1.0000, 1.0000)');
    assert.equal(transformTo(block, container, false), 'translate(75.00px, 40.00px) scale(0.2500, 0.2000)');
    assert.equal(transformTo(container, container, false), 'translate(0.00px, 0.00px) scale(1.0000, 1.0000)', 'ends where the container is drawn');
  });

  it('lasts about a quarter of a second, a little longer for big changes, with a limit', () => {
    assert.equal(durationFor(10), 251);
    assert.ok(durationFor(600) > durationFor(10));
    assert.equal(durationFor(100000), 340);
  });
});
