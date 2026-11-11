/**
 * Mouse wheel and trackpad input, shared by the circuit (`viewport.ts`) and the timeline (`timeline.ts`) so both
 * follow the same rules.
 */

type Wheel = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'shiftKey' | 'ctrlKey' | 'metaKey'>;

/** Pixels per wheel step: deltas come in pixels, lines or pages. */
export function wheelUnit(mode: number): number {
  return mode === 1 ? 16 : mode === 2 ? 400 : 1;
}

/**
 * Shift + wheel moves sideways: down = right (later on the timeline), up = left (earlier). Returns pixels, positive
 * = right, or null without Shift. Browsers may turn Shift + wheel into a sideways scroll themselves (deltaX instead of
 * deltaY); that gives the same direction.
 */
export function shiftPan(e: Wheel): number | null {
  if (!e.shiftKey) return null;
  return (e.deltaY || e.deltaX) * wheelUnit(e.deltaMode);
}

/** A sideways scroll (trackpad, tilt wheel): pixels the way it scrolls, or null when the gesture is vertical. */
export function sideways(e: Wheel): number | null {
  return Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX * wheelUnit(e.deltaMode) : null;
}

/** What a wheel event does on the timeline. */
export type TimelineWheel =
  /** move the view sideways by this many pixels (positive = later) */
  | { pan: number }
  /** zoom around the pointer: the visible time span is multiplied by this */
  | { zoom: number }
  /** nothing here: the lanes scroll up and down as the page would */
  | 'scroll';

/**
 * Timeline: the wheel scrolls the lanes, Ctrl (⌘ on macOS) + wheel zooms around the pointer — so does a trackpad
 * pinch, which arrives as Ctrl + wheel —, Shift + wheel and sideways scrolls move the view.
 */
export function timelineWheel(e: Wheel): TimelineWheel {
  const shift = shiftPan(e);
  if (shift !== null) return { pan: shift };
  if (e.ctrlKey || e.metaKey) {
    const dy = e.deltaY * wheelUnit(e.deltaMode);
    // a wheel notch is ~100 px, a pinch a few: both zoom at a usable pace
    return { zoom: Math.exp(dy * (Math.abs(dy) >= 50 ? 0.0015 : 0.01)) };
  }
  const side = sideways(e);
  if (side !== null) return { pan: side };
  return 'scroll';
}
