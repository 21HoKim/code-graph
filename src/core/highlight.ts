/**
 * Syntax colours for the source preview, in the colour theme the user has (TextMate grammars + a VS Code
 * theme JSON, the same pair the editor uses). Lines in, HTML lines out — escaped, with inline colours.
 * No VS Code API here: the host finds the theme (host/theme.ts) and hands it over.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHighlighterCore, type HighlighterCore, type ThemeRegistrationAny, type ThemedToken } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import c from 'shiki/dist/langs/c.mjs';
import cpp from 'shiki/dist/langs/cpp.mjs';
import python from 'shiki/dist/langs/python.mjs';

export type HighlightLang = 'c' | 'cpp' | 'python';

/** What a VS Code colour theme gives a grammar: its name, kind and token colours (`colors` for the default fore-/background). */
export interface EditorTheme {
  name: string;
  type: 'dark' | 'light';
  colors?: Record<string, string>;
  tokenColors: unknown[];
}

export function langOf(file: string): HighlightLang | undefined {
  if (/\.pyi?$/i.test(file)) return 'python';
  if (/\.c$/i.test(file)) return 'c';
  // headers: C++ grammar reads C headers fine, and the other way round loses classes and namespaces
  if (/\.(h|hh|hpp|hxx|h\+\+|cc|cpp|cxx|c\+\+|ipp|inl)$/i.test(file)) return 'cpp';
  return undefined;
}

let core: Promise<HighlighterCore> | undefined;
const loaded = new Set<string>();
/** Oniguruma, the regex engine VS Code runs TextMate grammars with (dist/wasm next to the bundle). */
let wasmFile = path.join(__dirname, 'wasm', 'onig.wasm');

export function setHighlightWasm(file: string): void {
  wasmFile = file;
}

function highlighter(): Promise<HighlighterCore> {
  core ??= fs.promises
    .readFile(wasmFile)
    .then((wasm) => createHighlighterCore({ langs: [c, cpp, python], themes: [], engine: createOnigurumaEngine(wasm) }))
    .catch((e) => {
      core = undefined;
      throw e;
    });
  return core;
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

const SAFE_COLOR = /^#[0-9a-f]{3,8}$/i;

function span(t: ThemedToken, text: string, fg: string | undefined): string {
  const css: string[] = [];
  const color = t.color?.toLowerCase();
  if (color && SAFE_COLOR.test(color) && color !== fg) css.push(`color:${color}`);
  const fs = t.fontStyle ?? 0;
  if (fs > 0) {
    if (fs & 1) css.push('font-style:italic');
    if (fs & 2) css.push('font-weight:bold');
    if (fs & 4) css.push('text-decoration:underline');
  }
  return css.length ? `<span style="${css.join(';')}">${escHtml(text)}</span>` : escHtml(text);
}

let generation = 0;

/** `lines` coloured as one piece of `lang` code; null when the theme cannot be used. */
export async function highlightLines(lines: string[], lang: HighlightLang, theme: EditorTheme): Promise<string[] | null> {
  const hl = await highlighter();
  const key = `cg${generation}:${theme.name}`;
  if (!loaded.has(key)) {
    try {
      await hl.loadTheme({ ...(theme as unknown as ThemeRegistrationAny), name: key, settings: theme.tokenColors as never } as ThemeRegistrationAny);
      loaded.add(key);
    } catch {
      return null;
    }
  }
  const fg = theme.colors?.['editor.foreground']?.toLowerCase();
  const { tokens } = hl.codeToTokens(lines.join('\n'), { lang, theme: key });
  return tokens.map((row) => row.map((t) => span(t, t.content, fg)).join(''));
}

/** The theme changed (another theme, a customisation, an update): load it again next time. */
export function forgetThemes(): void {
  generation++;
  loaded.clear();
}
