/**
 * Dynamic trace format — DRAFT v0 (not consumed yet; see docs/ROADMAP.md).
 *
 * The contract between runtime tracers (Python sys.monitoring, C/C++
 * -finstrument-functions / eBPF uprobes / debugger) and the viewer.
 * JSON Lines: one header line, then one event per line, ordered by `t`.
 *
 * The viewer maps every FrameRef to a static Entity by file + line range
 * (innermost function whose range contains `line`), then fires a pulse along
 * the projected wire caller → callee, coloured by thread.
 */

export interface TraceHeader {
  kind: 'header';
  schema: 'code-current-trace/0';
  lang: 'python' | 'c' | 'cpp' | 'mixed';
  /** Absolute workspace root on the traced machine, to relativize paths. */
  root: string;
  /** Unit of `t`. */
  clock: 'ns' | 'us';
  pid: number;
  started: string;
}

/** Where code is running. `file` is relative to the header root. */
export interface FrameRef {
  file: string;
  line: number;
  name: string;
}

/**
 * Summary of a value crossing a wire. `id` is an identity (Python id(),
 * C pointer value) so one object can be followed across calls and threads:
 * the "data tracking" view highlights every wire the same id travelled on.
 */
export interface ValueSummary {
  name?: string;
  type: string;
  repr?: string;
  size?: number;
  id?: string;
}

export type TraceEvent =
  | { kind: 'call'; t: number; tid: number; fn: FrameRef; caller?: FrameRef; args?: ValueSummary[] }
  | { kind: 'return'; t: number; tid: number; fn: FrameRef; value?: ValueSummary }
  | { kind: 'thread_start'; t: number; tid: number; parent?: number; name?: string; entry?: FrameRef }
  | { kind: 'thread_end'; t: number; tid: number }
  | { kind: 'lock'; t: number; tid: number; obj: string; op: 'wait' | 'acquired' | 'release' }
  | { kind: 'watch'; t: number; tid: number; at: FrameRef; value: ValueSummary };

export type TraceLine = TraceHeader | TraceEvent;
