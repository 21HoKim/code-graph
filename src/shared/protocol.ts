/** Messages between the extension host and the webview. */
import type { CodeGraph, Diagnostic, VerifyInfo } from '../core/model';
import type { LiveUpdate } from '../core/live';
import type { Peek } from '../core/peek';
import type { RunTrace } from '../core/trace';

export type { VerifyInfo };

export type LevelSetting = 'auto' | 'dir' | 'file' | 'namespace' | 'class' | 'function';

export interface ViewSettings {
  defaultLevel: LevelSetting;
  layout: 'circuit' | 'network';
  flow: 'all' | 'focus' | 'off';
  maxParticles: number;
  showGuesses: boolean;
  lang: string;
  /** Running inside VS Code (false = standalone demo page). */
  host: boolean;
  /** Workspace trust: compile checks and Run & Trace execute tools, so they need a trusted workspace. */
  trusted?: boolean;
}

/** compile = syntax-only check · editor = language servers · build = real build for Run & Trace · runtime = exceptions/crashes */
export type DiagSet = 'compile' | 'editor' | 'build' | 'runtime';

export type HostMessage =
  | { type: 'graph'; graph: CodeGraph; settings: ViewSettings; reason: 'initial' | 'update' }
  | { type: 'progress'; done: number; total: number }
  | { type: 'cursor'; file: string; line: number }
  | { type: 'focusFile'; file: string }
  | { type: 'diagnostics'; set: DiagSet; diagnostics: Diagnostic[]; info?: VerifyInfo }
  | { type: 'task'; task: 'verify' | 'build' | 'run'; state: 'start' | 'progress' | 'done' | 'error'; message?: string; done?: number; total?: number }
  /** `scope`: a view of one process (container) of a trace of several. */
  | { type: 'trace'; trace: RunTrace | null; notes?: string[]; scope?: string }
  | { type: 'showProblems' }
  /** A run in progress: what runs right now ('tick', every 250 ms), until 'end' (its trace follows). */
  | { type: 'live'; state: 'tick' | 'end'; update?: LiveUpdate }
  /** Another view of the same run played, paused, jumped or changed speed: follow it. */
  | { type: 'replay'; t: number; playing: boolean; speed: number }
  /** Answer to a webview 'peek': the source lines for a hover preview (null: file not readable). */
  | { type: 'peek'; req: number; peek: Peek | null; final?: boolean }
  /** The colour theme changed: previews shown so far have the old colours. */
  | { type: 'peekReset' }
  | { type: 'error'; message: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'open'; file: string; line: number }
  /** A few source lines for the tooltip: a definition (`count` lines, up to `endLine`) or a call site (`count: 1`). */
  | { type: 'peek'; req: number; file: string; line: number; endLine?: number; count?: number }
  | { type: 'reanalyze' }
  | { type: 'exportGraph' }
  | { type: 'verify' }
  | { type: 'runTrace'; compose?: boolean }
  | { type: 'loadTrace' }
  | { type: 'clearTrace' }
  /** Open a view per process (container) of the trace, or of the one named. */
  | { type: 'splitTrace'; proc?: string }
  /** Stop the run in progress and show what it recorded. */
  | { type: 'stopRun' }
  /** The replay was played, paused, moved or sped up here: the other views of the run follow. */
  | { type: 'replay'; t: number; playing: boolean; speed: number };
