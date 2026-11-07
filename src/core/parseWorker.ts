/** Worker-thread entry: receives batches of files, returns FileFacts. */
import { parentPort, workerData } from 'worker_threads';
import { loadParsers } from './extract';
import { parseOne, type ParseJob } from './pool';

const parsers = loadParsers((workerData as { wasmDir: string }).wasmDir);

parentPort?.on('message', async (msg: { id: number; jobs: ParseJob[] }) => {
  try {
    const p = await parsers;
    parentPort!.postMessage({ id: msg.id, facts: msg.jobs.map((j) => parseOne(p, j)) });
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, error: String((e as Error)?.stack ?? e) });
  }
});
