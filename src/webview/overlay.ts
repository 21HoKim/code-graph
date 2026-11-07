/**
 * Health overlay for the current projection: which visible blocks are broken / affected / unpowered,
 * which containers hold problems, which wires are cut or carry no current.
 */
import type { Health } from '../core/health';
import type { CodeGraph, Diagnostic } from '../core/model';
import type { Projection } from './projection';

export type BlockState = 'broken' | 'affected' | 'unpowered';

export interface BlockStatus {
  state: BlockState;
  errors: number;
  dist: number;
  diags: Diagnostic[];
}

/** self: the container itself is broken (e.g. a file that does not parse) · errors: errors inside it */
export interface ZoneStatus {
  self: boolean;
  errors: number;
}

export interface Overlay {
  blocks: Map<string, BlockStatus>;
  zones: Map<string, ZoneStatus>;
  wires: Map<string, 'cut' | 'dead'>;
}

export function buildOverlay(p: Projection, g: CodeGraph, h: Health): Overlay {
  const blocks = new Map<string, BlockStatus>();
  const zones = new Map<string, ZoneStatus>();
  /** Only the broken thing itself turns red; enclosing containers just count the errors inside them. */
  const mark = (vis: string, errors: number, self: boolean) => {
    for (let c: string | null = p.nodes.get(vis)?.container ? vis : p.nodes.get(vis)?.parent ?? null; c; c = p.nodes.get(c)?.parent ?? null) {
      const z = zones.get(c) ?? zones.set(c, { self: false, errors: 0 }).get(c)!;
      if (self && c === vis) z.self = true;
      z.errors += errors;
    }
  };
  for (const [target, diags] of h.broken) {
    const v = p.repOf(target);
    if (!v) continue;
    // a python module and its file are the same block: count once
    const dup = target.startsWith('py:mod:') && h.broken.get('f:' + target.slice(7)) === diags;
    if (p.nodes.get(v)?.container) {
      if (!dup) mark(v, diags.length, true);
      continue;
    }
    const st = blocks.get(v);
    if (st?.state === 'broken') {
      if (!dup) {
        st.errors += diags.length;
        st.diags.push(...diags);
      }
    } else blocks.set(v, { state: 'broken', errors: diags.length, dist: 0, diags: [...diags] });
    if (!dup) mark(v, diags.length, false);
  }
  for (const [id, a] of h.affected) {
    const v = p.repOf(id);
    if (!v || p.nodes.get(v)?.container) continue;
    const st = blocks.get(v);
    if (st?.state === 'broken') continue;
    if (!st || st.state !== 'affected' || a.dist < st.dist) blocks.set(v, { state: 'affected', errors: 0, dist: a.dist, diags: [] });
  }
  // a block is unpowered when every function inside it is
  const total = new Map<string, number>();
  const off = new Map<string, number>();
  for (const e of g.entities) {
    if (e.kind !== 'function') continue;
    const v = p.repOf(e.id);
    if (!v || p.nodes.get(v)?.container) continue;
    total.set(v, (total.get(v) ?? 0) + 1);
    if (h.unpowered.has(e.id)) off.set(v, (off.get(v) ?? 0) + 1);
  }
  for (const [v, n] of off) if (n === total.get(v) && !blocks.has(v)) blocks.set(v, { state: 'unpowered', errors: 0, dist: 0, diags: [] });

  const wires = new Map<string, 'cut' | 'dead'>();
  for (const e of p.edges) {
    if (e.rels.some((r) => h.cut.has(r.id))) wires.set(e.id, 'cut');
    else if (e.rels.length && e.rels.every((r) => h.dead.has(r.id))) wires.set(e.id, 'dead');
  }
  return { blocks, zones, wires };
}
