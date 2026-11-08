/**
 * Run options from VS Code settings and `.codegraph.json` (a key in the file wins), and the
 * "Create .codegraph.json" command that writes a starting file with what CodeGraph detected.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_FILE, composeFilesOf, loadProjectConfig, starterConfig, type ProjectConfig } from '../core/config';
import { composeConfig, findComposeFiles, planServices } from '../core/compose';
import { findEntries } from '../core/runner';
import { targetsFor } from '../core/buildinfo';
import type { AnalysisService } from './service';

export interface Options {
  config: ProjectConfig;
  configFile?: string;
  configError?: string;
  entry: string;
  target: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  buildFlags: string[];
  linkFlags: string[];
  useBuildSystem: boolean;
  customBuild?: { command: string; program: string };
  timeoutMs: number;
  maxEvents: number;
  values: boolean;
  compose: {
    files: string[];
    profiles: string[];
    services: string[];
    docker: string;
    timeoutMs: number;
    startTimeoutMs: number;
  };
}

let warned = '';

/** Settings with `.codegraph.json` on top. Warns once when the file cannot be read. */
export function options(root: string): Options {
  const s = vscode.workspace.getConfiguration('codeGraph');
  const { config, file, error } = loadProjectConfig(root);
  if (error && error !== warned) {
    warned = error;
    const open = vscode.l10n.t('Open {0}', CONFIG_FILE);
    void vscode.window.showWarningMessage(vscode.l10n.t('CodeGraph could not read {0}: {1}', CONFIG_FILE, error), open).then((c) => {
      if (c === open && file) void vscode.window.showTextDocument(vscode.Uri.file(file));
    });
  }
  const r = config.run ?? {};
  const c = config.compose ?? {};
  // 0 = no limit: the run ends with the program, or with Stop
  const secs = (v: unknown, fallback: number) => (typeof v === 'number' && v >= 0 ? v : fallback);
  const setting = s.get<string>('run.compose.file', '');
  return {
    config,
    configFile: file,
    configError: error,
    entry: (r.entry ?? s.get<string>('run.entry', '')).trim(),
    target: (r.target ?? s.get<string>('run.target', '')).trim(),
    args: r.args ?? s.get<string[]>('run.args', []),
    cwd: r.cwd ?? (s.get<string>('run.cwd', '') || undefined),
    env: { ...s.get<Record<string, string>>('run.env', {}), ...(r.env ?? {}) },
    buildFlags: r.buildFlags ?? s.get<string[]>('run.buildFlags', []),
    linkFlags: r.linkFlags ?? s.get<string[]>('run.linkFlags', []),
    useBuildSystem: s.get<boolean>('run.useBuildSystem', true),
    customBuild: r.build && r.program ? { command: r.build, program: r.program } : undefined,
    timeoutMs: secs(r.timeoutSeconds, Math.max(0, s.get<number>('run.timeoutSeconds', 0))) * 1000,
    maxEvents: Math.max(1000, s.get<number>('run.maxEvents', 200000)),
    values: s.get<boolean>('run.captureValues', true),
    compose: {
      files: findComposeFiles(root, composeFilesOf(config) ?? (setting ? [setting] : undefined)),
      profiles: c.profiles ?? [],
      services: c.services ?? s.get<string[]>('run.compose.services', []),
      docker: s.get<string>('run.compose.docker', 'docker') || 'docker',
      timeoutMs: secs(c.timeoutSeconds, secs(r.timeoutSeconds, Math.max(0, s.get<number>('run.timeoutSeconds', 0)))) * 1000,
      startTimeoutMs: secs(c.startTimeoutSeconds, Math.max(10, s.get<number>('run.compose.startTimeoutSeconds', 600))) * 1000,
    },
  };
}

/** "CodeGraph: Create .codegraph.json": opens it, or writes one with what CodeGraph detected. */
export async function createConfigCommand(svc: AnalysisService): Promise<void> {
  const root = svc.root;
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) {
    const content = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'CodeGraph' }, async () => {
      const graph = svc.graph ?? (await svc.analyze());
      const entries = findEntries(graph);
      const { targets } = await svc.buildTargets();
      const composeFiles = findComposeFiles(root);
      let services: string[] = [];
      if (composeFiles.length && vscode.workspace.isTrusted) {
        try {
          const docker = vscode.workspace.getConfiguration('codeGraph').get<string>('run.compose.docker', 'docker') || 'docker';
          const project = await composeConfig(docker, composeFiles);
          const planned = planServices(project, root, { sources: svc.sourceFiles() }).plans.map((p) => p.name);
          services = planned.length ? planned : Object.keys(project.services);
        } catch {
          /* docker not here: leave the example */
        }
      }
      return starterConfig({
        entries: entries.map((e) => e.module ?? e.file),
        targets: entries.map((e) => ({ entry: e.module ?? e.file, names: targetsFor(targets, path.join(root, ...e.file.split('/'))).map((t) => t.name) })),
        composeFiles: composeFiles.map((f) => path.relative(root, f).split(path.sep).join('/')),
        services,
      });
    });
    fs.writeFileSync(file, content);
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file));
}
