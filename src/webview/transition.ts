/**
 * Opening and closing blocks without a jump: every block and container slides and resizes from where it was to
 * where the new layout puts it (FLIP: First, Last, Invert, Play), in the spirit of macOS window animations.
 *
 * - A block or container that stays moves from its old box to its new one.
 * - What appears (the contents of a block being opened) starts inside its nearest ancestor's old box, grows with
 *   it and fades in a little later.
 * - What disappears (the contents of a container being closed) shrinks into its nearest ancestor's new box and
 *   fades out first.
 * - A block that becomes a container (or the reverse) cross-fades between the two shapes while it resizes.
 * - Wires and the flow layer wait for the end and fade in on their new paths.
 *
 * Boxes are in world coordinates of the new picture: the caller maps old boxes through the change of viewport, so
 * a block that keeps its place on screen does not move. With `prefers-reduced-motion` nothing animates.
 */
import type { Box } from './layout';

/** About as long as a macOS window animation; a bigger change takes a little longer, up to a limit. */
export function durationFor(elements: number): number {
  return Math.round(Math.min(340, 250 + elements / 10));
}

/** Decelerating, no bounce. */
export const EASE = 'cubic-bezier(0.2, 0, 0, 1)';

/** The affine map that takes box `to` onto box `from`: p ↦ p·s + t. */
export interface Fit {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

export function fitOnto(to: Box, from: Box): Fit {
  const sx = from.w / Math.max(1, to.w);
  const sy = from.h / Math.max(1, to.h);
  return { sx, sy, tx: from.x - to.x * sx, ty: from.y - to.y * sy };
}

export function applyFit(f: Fit, b: Box): Box {
  return { x: b.x * f.sx + f.tx, y: b.y * f.sy + f.ty, w: b.w * f.sx, h: b.h * f.sy };
}

/** CSS transform drawing an element laid out at `at` (its own origin at `at.x, at.y` when `local`) at box `b`. */
export function transformTo(b: Box, at: Box, local: boolean): string {
  const sx = b.w / Math.max(1, at.w);
  const sy = b.h / Math.max(1, at.h);
  // a block group is translated to its box (`local`); a container draws in world coordinates
  const tx = local ? b.x : b.x - at.x * sx;
  const ty = local ? b.y : b.y - at.y * sy;
  return `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
}

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface Before {
  /** Old boxes, already mapped into the new picture's world coordinates. */
  boxes: Map<string, Box>;
  /** Parent of each old node (containment), to find what a vanishing node folds into. */
  parent: (id: string) => string | null | undefined;
  /** The old elements, by id (detached once the new picture is in). */
  elements: Map<string, Element[]>;
  /** The old picture's world → the new picture's world (viewport change). */
  world: Fit;
}

export interface After {
  boxes: Map<string, Box>;
  parent: (id: string) => string | null | undefined;
  elements: Map<string, Element[]>;
  /** Where vanishing elements are put while they fade out. */
  ghosts: Element;
  /** Wires, labels, breaks: hidden while blocks move, faded in at the end. */
  late: Element[];
  /** Moves longer than this (world units) cross-fade instead of travelling across the screen. */
  maxMove: number;
}

const isShape = (el: Element) => el.classList.contains('n') || el.classList.contains('z');
const isLocal = (el: Element) => el.classList.contains('n');

/** Runs the transition; returns its length in ms (0 when nothing moved). */
export function play(before: Before, after: After): number {
  if (reducedMotion() || typeof Element === 'undefined' || !('animate' in Element.prototype)) return 0;
  const shapes = [...after.elements.entries()].filter(([, els]) => els.some(isShape));
  const D = durationFor(shapes.length);
  const big = shapes.length > 400; // many blocks: containers move, blocks inside only fade
  let moved = false;
  // the old → new map of the nearest ancestor that exists on both sides
  const carry = (id: string, parent: (id: string) => string | null | undefined, own: Map<string, Box>, other: Map<string, Box>): Fit | undefined => {
    for (let p = parent(id), k = 0; p && k < 40; p = parent(p), k++) {
      const a = own.get(p);
      const b = other.get(p);
      if (a && b) return fitOnto(a, b);
    }
    return undefined;
  };
  for (const [id, els] of shapes) {
    const nb = after.boxes.get(id);
    if (!nb) continue;
    const ob = before.boxes.get(id);
    const oldEls = before.elements.get(id)?.filter(isShape) ?? [];
    for (const el of els) {
      if (!isShape(el)) continue;
      const local = isLocal(el);
      const changedShape = !!ob && oldEls.length > 0 && oldEls.every((o) => isLocal(o) !== local);
      let from: Box | undefined = ob;
      let fadeIn = !ob || changedShape;
      if (!from) {
        const f = carry(id, after.parent, after.boxes, before.boxes);
        if (f) from = applyFit(f, nb);
      }
      if (big && local && !ob) from = undefined;
      if (from && Math.hypot(from.x - nb.x, from.y - nb.y) > after.maxMove) {
        from = undefined;
        fadeIn = true;
      }
      const frames: Keyframe[] = [];
      if (from && !same(from, nb)) {
        frames.push({ transform: transformTo(from, nb, local), transformOrigin: '0 0' }, { transform: transformTo(nb, nb, local), transformOrigin: '0 0' });
      }
      if (fadeIn) {
        if (!frames.length) frames.push({}, {});
        Object.assign(frames[0], { opacity: 0 });
        Object.assign(frames[1], { opacity: 1 });
      }
      if (!frames.length) continue;
      moved = true;
      // what appears comes in a little after its container starts to grow
      el.animate(frames, { duration: D, easing: EASE, delay: fadeIn && !ob ? 60 : 0, fill: 'backwards' });
    }
  }
  // what disappears (or changes shape) folds into where its ancestor goes, fading out first
  for (const [id, olds] of before.elements) {
    const nb = after.boxes.get(id);
    for (const el of olds) {
      if (!isShape(el)) continue;
      const stays = nb && after.elements.get(id)?.some((n) => isShape(n) && isLocal(n) === isLocal(el));
      if (stays) continue;
      const ob = before.boxes.get(id);
      if (!ob) continue;
      let to: Box | undefined = nb;
      if (!to) {
        const f = carry(id, before.parent, before.boxes, after.boxes);
        to = f ? applyFit(f, ob) : undefined;
      }
      // the element is still drawn in the old picture's coordinates: put it at its mapped old box, then move it
      const raw = unmap(before.world, ob);
      const at = isLocal(el) ? { x: 0, y: 0, w: raw.w, h: raw.h } : raw;
      const start = transformTo(ob, at, isLocal(el));
      const end = to ? transformTo(to, at, isLocal(el)) : start;
      el.removeAttribute('transform');
      el.classList.add('ghost');
      after.ghosts.appendChild(el);
      moved = true;
      const a = el.animate(
        [
          { transform: start, transformOrigin: '0 0', opacity: 1 },
          { transform: end, transformOrigin: '0 0', opacity: 0, offset: 0.6 },
          { transform: end, transformOrigin: '0 0', opacity: 0 },
        ],
        { duration: D, easing: EASE, fill: 'forwards' },
      );
      a.onfinish = () => el.remove();
      a.oncancel = () => el.remove();
    }
  }
  if (!moved) return 0;
  for (const el of after.late) {
    el.animate([{ opacity: 0 }, { opacity: 0, offset: D / (D + 160) }, { opacity: 1 }], { duration: D + 160, easing: 'ease-out' });
  }
  return D;
}

function same(a: Box, b: Box): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
}

/** A mapped box back in the old picture's world coordinates. */
function unmap(f: Fit, b: Box): Box {
  return { x: (b.x - f.tx) / f.sx, y: (b.y - f.ty) / f.sy, w: b.w / f.sx, h: b.h / f.sy };
}
