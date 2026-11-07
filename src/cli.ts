#!/usr/bin/env node
/**
 * CodeCurrent CLI – run the analyzer without VS Code (CI, debugging, tests).
 *
 *   node dist/cli.js <dir> [-o graph.json] [--workers N] [--max-files N] [-I include/dir] [--quiet]
 */
import * as fs from 'fs';
import * as path from 'path';
import { AnalysisSession, walk } from './core/analyze';
import { ParsePool, defaultWorkerCount } from './core/pool';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let dir: string | undefined;
  let out: string | undefined;
  let workers: number | undefined;
  let maxFiles = 5000;
  let quiet = false;
  const includes: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') out = argv[++i];
    else if (a === '--workers') workers = Number(argv[++i]);
    else if (a === '--max-files') maxFiles = Number(argv[++i]);
    else if (a === '-I') includes.push(argv[++i]);
    else if (a === '--quiet') quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log('usage: code-current <dir> [-o graph.json] [--workers N] [--max-files N] [-I dir] [--quiet]');
      return;
    } else dir = a;
  }
  if (!dir) throw new Error('missing <dir>');
  const root = path.resolve(dir);
  const wasmDir = path.join(__dirname, 'wasm');
  const pool = new ParsePool(wasmDir, path.join(__dirname, 'parseWorker.js'), workers ?? defaultWorkerCount());
  const t0 = Date.now();
  const { files, truncated } = walk(root, { maxFiles });
  const session = new AnalysisSession(root, pool, includes.length ? includes : undefined);
  const graph = await session.analyze(files, (d, t) => {
    if (!quiet && process.stderr.isTTY) process.stderr.write(`\rparsing ${d}/${t}`);
  });
  pool.dispose();
  if (!quiet && process.stderr.isTTY) process.stderr.write('\n');
  const s = graph.stats;
  const pct = s.callSites ? Math.round((100 * s.resolvedCalls) / s.callSites) : 0;
  if (!quiet) {
    console.error(
      `${s.files} files${truncated ? ' (truncated)' : ''} · ${s.classes} classes · ${s.functions} functions · ` +
        `${s.relations} relations · ${s.resolvedCalls}/${s.callSites} call sites resolved (${pct}%) · ` +
        `parse ${s.parseMs}ms (cpu) · link ${s.linkMs}ms · wall ${Date.now() - t0}ms`,
    );
    for (const w of graph.warnings ?? []) console.error('warn:', w);
  }
  const json = JSON.stringify(graph, null, out ? 0 : 2);
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, json);
  }
  else console.log(json);
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
