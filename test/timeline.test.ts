import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { panView, wheelPan } from '../src/webview/timeline';

const wheel = (deltaY: number, o: { deltaX?: number; shiftKey?: boolean; deltaMode?: number } = {}) => ({
  deltaX: o.deltaX ?? 0,
  deltaY,
  deltaMode: o.deltaMode ?? 0,
  shiftKey: o.shiftKey ?? false,
});

describe('timeline: moving the view', () => {
  it('Shift + wheel down moves left (earlier), up moves right (later)', () => {
    assert.ok(wheelPan(wheel(100, { shiftKey: true }))! < 0);
    assert.ok(wheelPan(wheel(-100, { shiftKey: true }))! > 0);
  });

  it('the same when the browser turns Shift + wheel into a sideways scroll', () => {
    assert.ok(wheelPan(wheel(0, { shiftKey: true, deltaX: 100 }))! < 0);
    assert.ok(wheelPan(wheel(0, { shiftKey: true, deltaX: -100 }))! > 0);
  });

  it('a sideways scroll moves the way it scrolls; a plain wheel zooms', () => {
    assert.equal(wheelPan(wheel(2, { deltaX: 40 })), 40);
    assert.equal(wheelPan(wheel(100)), null);
  });

  it('wheel steps in lines count as pixels', () => {
    assert.equal(wheelPan(wheel(3, { shiftKey: true, deltaMode: 1 })), -48);
  });

  it('stops at both ends of the run and keeps the width', () => {
    assert.deepEqual(panView(-50, 100, 1000), [0, 100]);
    assert.deepEqual(panView(950, 100, 1000), [900, 1000]);
    assert.deepEqual(panView(300, 100, 1000), [300, 400]);
    assert.deepEqual(panView(10, 2000, 1000), [0, 1000], 'never wider than the run');
  });
});
