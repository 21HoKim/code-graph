import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { panView } from '../src/webview/timeline';
import { shiftPan, timelineWheel } from '../src/webview/wheel';

const wheel = (deltaY: number, o: { deltaX?: number; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; deltaMode?: number } = {}) => ({
  deltaX: o.deltaX ?? 0,
  deltaY,
  deltaMode: o.deltaMode ?? 0,
  shiftKey: o.shiftKey ?? false,
  ctrlKey: o.ctrlKey ?? false,
  metaKey: o.metaKey ?? false,
});
const pan = (a: ReturnType<typeof timelineWheel>) => (typeof a === 'object' && 'pan' in a ? a.pan : undefined);
const zoom = (a: ReturnType<typeof timelineWheel>) => (typeof a === 'object' && 'zoom' in a ? a.zoom : undefined);

describe('timeline: the wheel', () => {
  it('scrolls the lanes; Ctrl or ⌘ + wheel zooms around the pointer (down = out, up = in)', () => {
    assert.equal(timelineWheel(wheel(100)), 'scroll');
    assert.ok(zoom(timelineWheel(wheel(100, { ctrlKey: true })))! > 1, 'down shows more time');
    assert.ok(zoom(timelineWheel(wheel(-100, { ctrlKey: true })))! < 1);
    assert.ok(zoom(timelineWheel(wheel(-100, { metaKey: true })))! < 1, '⌘ on macOS');
    const pinch = zoom(timelineWheel(wheel(-4, { ctrlKey: true })))!;
    assert.ok(pinch < 1 && pinch > 0.9, 'a trackpad pinch (small Ctrl + wheel steps) zooms gently');
  });

  it('Shift + wheel down moves right (later), up moves left (earlier)', () => {
    assert.ok(pan(timelineWheel(wheel(100, { shiftKey: true })))! > 0);
    assert.ok(pan(timelineWheel(wheel(-100, { shiftKey: true })))! < 0);
  });

  it('the same when the browser turns Shift + wheel into a sideways scroll', () => {
    assert.ok(pan(timelineWheel(wheel(0, { shiftKey: true, deltaX: 100 })))! > 0);
    assert.ok(pan(timelineWheel(wheel(0, { shiftKey: true, deltaX: -100 })))! < 0);
  });

  it('a sideways scroll (trackpad, tilt wheel) moves the way it scrolls', () => {
    assert.equal(pan(timelineWheel(wheel(2, { deltaX: 40 }))), 40);
    assert.equal(pan(timelineWheel(wheel(2, { deltaX: -40 }))), -40);
  });

  it('wheel steps in lines count as pixels', () => {
    assert.equal(pan(timelineWheel(wheel(3, { shiftKey: true, deltaMode: 1 }))), 48);
  });

  it('the circuit uses the same Shift + wheel rule', () => {
    assert.equal(shiftPan(wheel(100, { shiftKey: true })), 100);
    assert.equal(shiftPan(wheel(0, { shiftKey: true, deltaX: -30 })), -30);
    assert.equal(shiftPan(wheel(100)), null);
  });
});

describe('timeline: moving the view', () => {
  it('stops at both ends of the run and keeps the width', () => {
    assert.deepEqual(panView(-50, 100, 1000), [0, 100]);
    assert.deepEqual(panView(950, 100, 1000), [900, 1000]);
    assert.deepEqual(panView(300, 100, 1000), [300, 400]);
    assert.deepEqual(panView(10, 2000, 1000), [0, 1000], 'never wider than the run');
  });
});
