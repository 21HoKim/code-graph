/**
 * VS Code colour theme files: one theme's colours and token colours with its `include` chain merged, and the
 * user's `editor.tokenColorCustomizations` as extra token rules. Node only (no VS Code API).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseJsonc } from './config';

export interface ThemeFile {
  colors?: Record<string, string>;
  tokenColors?: unknown[];
}

/** A theme file with what it includes underneath it (`include`, `tokenColors` as a path, old `settings`). */
export function readThemeFile(file: string, depth = 0): ThemeFile {
  if (depth > 8) return {};
  const raw = parseJsonc(fs.readFileSync(file, 'utf8')) as ThemeFile & { include?: string; settings?: unknown[] };
  const base: ThemeFile = raw.include ? readThemeFile(path.resolve(path.dirname(file), raw.include), depth + 1) : {};
  let own: unknown[] = [];
  const tc = raw.tokenColors as unknown;
  if (Array.isArray(tc)) own = tc;
  else if (typeof tc === 'string' && /\.json$/i.test(tc)) own = readThemeFile(path.resolve(path.dirname(file), tc), depth + 1).tokenColors ?? [];
  else if (Array.isArray(raw.settings)) own = raw.settings;
  return { colors: { ...base.colors, ...raw.colors }, tokenColors: [...(base.tokenColors ?? []), ...own] };
}

// `editor.tokenColorCustomizations` short keys → the scopes VS Code gives them
const SHORT_KEYS: Record<string, string[]> = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'meta.embedded.assembly'],
  keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable'],
};

/** `editor.tokenColorCustomizations` (or one theme's part of it) as token rules that go after the theme's own. */
export function customRules(c: Record<string, unknown> | undefined): unknown[] {
  if (!c) return [];
  const rules: unknown[] = [];
  for (const [key, scope] of Object.entries(SHORT_KEYS)) {
    const v = c[key];
    if (typeof v === 'string') rules.push({ scope, settings: { foreground: v } });
    else if (v && typeof v === 'object') rules.push({ scope, settings: v });
  }
  if (Array.isArray(c.textMateRules)) rules.push(...c.textMateRules);
  return rules;
}
