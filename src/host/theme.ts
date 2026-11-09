/**
 * The colour theme the editor shows right now, as a VS Code theme JSON for the source preview's syntax colours:
 * found among the installed extensions' `contributes.themes` (built-in themes included), its `include` chain
 * merged, and the user's `editor.tokenColorCustomizations` applied on top.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
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

let cached: EditorTheme | null | undefined;

/** The theme in use, or null when it cannot be found or read (the preview then stays plain). */
export function currentTheme(): EditorTheme | null {
  if (cached !== undefined) return cached;
  cached = null;
  const kind = vscode.window.activeColorTheme.kind;
  const all = contributions();
  for (const name of candidates()) {
    const hit = all.find(({ theme }) => (theme.id ?? theme.label) === name || theme.label === name);
    if (!hit?.theme.path || kindOf(hit.theme.uiTheme) !== kind) continue;
    try {
      const file = readThemeFile(path.join(hit.ext.extensionPath, hit.theme.path));
      const editor = vscode.workspace.getConfiguration('editor').get<Record<string, unknown>>('tokenColorCustomizations') ?? {};
      const colors = vscode.workspace.getConfiguration('workbench').get<Record<string, unknown>>('colorCustomizations') ?? {};
      const scoped = (o: Record<string, unknown>) => o[`[${name}]`] as Record<string, unknown> | undefined;
      cached = {
        name,
        type: kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark',
        colors: { ...file.colors, ...strings(colors), ...strings(scoped(colors)) },
        tokenColors: [...(file.tokenColors ?? []), ...customRules(editor), ...customRules(scoped(editor))],
      };
    } catch {
      cached = null;
    }
    break;
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
