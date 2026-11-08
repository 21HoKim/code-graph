/** Messages between the extension host and the webview. */
import type { CodeGraph, Diagnostic, VerifyInfo } from '../core/model';
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
  | { type: 'trace'; trace: RunTrace | null; notes?: string[] }
  | { type: 'showProblems' }
  | { type: 'error'; message: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'open'; file: string; line: number }
  | { type: 'reanalyze' }
  | { type: 'exportGraph' }
  | { type: 'verify' }
  | { type: 'runTrace'; compose?: boolean }
  | { type: 'loadTrace' }
  | { type: 'clearTrace' };
