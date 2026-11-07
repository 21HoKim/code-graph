/** Messages between the extension host and the webview. */
import type { CodeGraph } from '../core/model';

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
}

export type HostMessage =
  | { type: 'graph'; graph: CodeGraph; settings: ViewSettings; reason: 'initial' | 'update' }
  | { type: 'progress'; done: number; total: number }
  | { type: 'cursor'; file: string; line: number }
  | { type: 'focusFile'; file: string }
  | { type: 'error'; message: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'open'; file: string; line: number }
  | { type: 'reanalyze' }
  | { type: 'exportGraph' };
