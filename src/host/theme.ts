/**
 * The colour theme the editor shows right now, as a VS Code theme JSON for the source preview's syntax colours:
 * found among the installed extensions' `contributes.themes` (built-in themes included), its `include` chain
 * merged, and the user's `editor.tokenColorCustomizations` applied on top.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { fallbackTheme } from '../core/fallbacktheme';
import type { EditorTheme } from '../core/highlight';
import { customRules, readThemeFile } from '../core/themefile';

interface ThemeContribution {
  id?: string;
  label?: string;
  uiTheme?: string;
  path?: string;
}

function contributions(): { ext: vscode.Extension<unknown>; theme: ThemeContribution }[] {
  const out: { ext: vscode.Extension<unknown>; theme: ThemeContribution }[] = [];
  for (const ext of vscode.extensions.all) {
    const themes = (ext.packageJSON as { contributes?: { themes?: ThemeContribution[] } })?.contributes?.themes;
    if (Array.isArray(themes)) for (const theme of themes) out.push({ ext, theme });
  }
  return out;
}

function kindOf(uiTheme: string | undefined): vscode.ColorThemeKind {
  switch (uiTheme) {
    case 'vs':
      return vscode.ColorThemeKind.Light;
    case 'hc-black':
      return vscode.ColorThemeKind.HighContrast;
    case 'hc-light':
      return vscode.ColorThemeKind.HighContrastLight;
    default:
      return vscode.ColorThemeKind.Dark;
  }
}

/**
 * Older settings IDs of the built-in themes, as VS Code migrates them (workbenchThemeService.ts,
 * migrateThemeSettingsId): the "Default " prefix went away and the experimental themes became the 2026 ones.
 */
const LEGACY_IDS: Record<string, string> = {
  'Default Dark Modern': 'Dark Modern',
  'Default Light Modern': 'Light Modern',
  'Default Dark+': 'Dark+',
  'Default Light+': 'Light+',
  'Experimental Dark': 'Dark 2026',
  'VS Code Dark': 'Dark 2026',
  'Experimental Light': 'Light 2026',
  'VS Code Light': 'Light 2026',
};

/** Theme settings IDs that may be the one in use: the setting, then the preferred theme for the active kind. */
function candidates(): string[] {
  const w = vscode.workspace.getConfiguration('workbench');
  const kind = vscode.window.activeColorTheme.kind;
  const preferred =
    kind === vscode.ColorThemeKind.Light ? 'preferredLightColorTheme'
    : kind === vscode.ColorThemeKind.HighContrast ? 'preferredHighContrastColorTheme'
    : kind === vscode.ColorThemeKind.HighContrastLight ? 'preferredHighContrastLightColorTheme'
    : 'preferredDarkColorTheme';
  return [w.get<string>('colorTheme'), w.get<string>(preferred)].filter((x): x is string => !!x);
}

function strings(o: Record<string, unknown> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(o ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

function activeType(): 'dark' | 'light' {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark';
}

/** The theme file of the theme in use, with the user's customisations; a reason when it cannot be had. */
function findTheme(): EditorTheme | string {
  const kind = vscode.window.activeColorTheme.kind;
  const all = contributions();
  const names = candidates();
  for (const raw of names) {
    const name = LEGACY_IDS[raw] ?? raw;
    const hit = all.find(({ theme }) => (theme.id ?? theme.label) === name || theme.label === name);
    if (!hit?.theme.path || kindOf(hit.theme.uiTheme) !== kind) continue;
    const file = path.join(hit.ext.extensionPath, hit.theme.path);
    let read;
    try {
      read = readThemeFile(file);
    } catch (e) {
      const remote = vscode.env.remoteName ? ` (remote "${vscode.env.remoteName}": the theme may be installed on the other machine)` : '';
      return `"${name}" from ${hit.ext.id}: cannot read ${file}${remote}: ${(e as Error).message}`;
    }
    if (!read.tokenColors?.length) return `"${name}" from ${hit.ext.id} has no token colours CodeGraph can read`;
    const editor = vscode.workspace.getConfiguration('editor').get<Record<string, unknown>>('tokenColorCustomizations') ?? {};
    const colors = vscode.workspace.getConfiguration('workbench').get<Record<string, unknown>>('colorCustomizations') ?? {};
    const scoped = (o: Record<string, unknown>) => (o[`[${name}]`] ?? o[`[${raw}]`]) as Record<string, unknown> | undefined;
    return {
      name,
      type: activeType(),
      colors: { ...read.colors, ...strings(colors), ...strings(scoped(colors)) },
      tokenColors: [...read.tokenColors, ...customRules(editor), ...customRules(scoped(editor))],
    };
  }
  return `no installed theme matches ${names.map((n) => `"${n}"`).join(' or ') || 'the settings'}`;
}

let cached: EditorTheme | undefined;

/**
 * The theme in use for the preview's syntax colours. When it cannot be found or read, Dark+ / Light+ (by the
 * active kind) stand in, so the preview is coloured either way; `log` hears which one it is, once per theme change.
 */
export function currentTheme(log?: (line: string) => void): EditorTheme {
  if (cached) return cached;
  const found = findTheme();
  if (typeof found === 'string') {
    cached = fallbackTheme(activeType());
    log?.(`source preview colours: ${found} — using ${cached.name}`);
  } else {
    cached = found;
    log?.(`source preview colours: theme "${found.name}"`);
  }
  return cached;
}

/** Calls `changed` when the colours of the preview change: another theme, or customisations. */
export function onThemeChange(changed: () => void): vscode.Disposable {
  const reset = () => {
    cached = undefined;
    changed();
  };
  return vscode.Disposable.from(
    vscode.window.onDidChangeActiveColorTheme(reset),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('workbench.colorTheme') || e.affectsConfiguration('editor.tokenColorCustomizations') || e.affectsConfiguration('workbench.colorCustomizations')) reset();
    }),
  );
}
