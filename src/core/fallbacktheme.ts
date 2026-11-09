/**
 * VS Code's Dark+ / Light+ token colours (as Shiki ships them), for when the theme in use cannot be read —
 * e.g. it is installed on the other side of a remote. Kept apart from highlight.ts so that reading themes
 * does not load the grammars.
 */
import darkPlus from 'shiki/dist/themes/dark-plus.mjs';
import lightPlus from 'shiki/dist/themes/light-plus.mjs';
import type { EditorTheme } from './highlight';

export function fallbackTheme(type: 'dark' | 'light'): EditorTheme {
  const t = (type === 'light' ? lightPlus : darkPlus) as unknown as { name: string; colors?: Record<string, string>; tokenColors?: unknown[] };
  return { name: `${t.name} (CodeGraph fallback)`, type, colors: t.colors, tokenColors: t.tokenColors ?? [] };
}
