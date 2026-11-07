/**
 * Parses files on worker threads so big workspaces don't block the
 * extension host. Falls back to in-process parsing for tiny batches or if
 * workers cannot start.
 */
import * as fs from 'fs';
import * as os from 'os';
import { Worker } from 'worker_threads';
import { extractFile, loadParsers, type Parsers } from './extract';
import type { FileFacts } from './model';

export interface ParseJob {
  abs: string;
  rel: string;
}

export type Progress = (done: number, total: number) => void;

interface Slot {
  worker: Worker;
  busy: boolean;
}

interface Pending {
  resolve: (f: FileFacts[]) => void;
  reject: (e: unknown) => void;
}

const CHUNK = 24;
const IN_PROCESS_THRESHOLD = 12;

export function defaultWorkerCount(requested?: number): number {
  if (requested && requested > 0) return Math.min(requested, 16);
  const cpus = os.cpus()?.length ?? 2;
  return Math.max(1, Math.min(4, cpus - 1));
}

export class ParsePool {
  private slots: Slot[] = [];
  private pending = new Map<number, Pending>();
  private seq = 0;
  private parsers?: Promise<Parsers>;
  private broken = false;

  constructor(
    private wasmDir: string,
    private workerScript: string | undefined,
    private size: number,
  ) {}

  async parse(jobs: ParseJob[], onProgress?: Progress): Promise<FileFacts[]> {
    if (!jobs.length) return [];
    if (this.broken || !this.workerScript || this.size <= 0 || jobs.length < IN_PROCESS_THRESHOLD) {
      return this.parseInProcess(jobs, onProgress);
    }
    try {
      this.ensureWorkers(Math.min(this.size, Math.ceil(jobs.length / CHUNK)));
    } catch {
      this.broken = true;
      return this.parseInProcess(jobs, onProgress);
    }
    const chunks: ParseJob[][] = [];
    for (let i = 0; i < jobs.length; i += CHUNK) chunks.push(jobs.slice(i, i + CHUNK));
    const results: FileFacts[][] = new Array(chunks.length);
    let next = 0;
    let done = 0;
    const runSlot = async (slot: Slot): Promise<void> => {
      while (next < chunks.length) {
        const idx = next++;
        try {
          results[idx] = await this.send(slot, chunks[idx]);
        } catch {
          results[idx] = await this.parseInProcess(chunks[idx]);
        }
        done += chunks[idx].length;
        onProgress?.(done, jobs.length);
      }
    };
    await Promise.all(this.slots.map(runSlot));
    return results.flat();
  }

  async parseInProcess(jobs: ParseJob[], onProgress?: Progress): Promise<FileFacts[]> {
    this.parsers ??= loadParsers(this.wasmDir);
    const parsers = await this.parsers;
    const out: FileFacts[] = [];
    for (let i = 0; i < jobs.length; i++) {
      out.push(parseOne(parsers, jobs[i]));
      if (i % 16 === 15) {
        onProgress?.(i + 1, jobs.length);
        await new Promise((r) => setImmediate(r)); // stay responsive
      }
    }
    onProgress?.(jobs.length, jobs.length);
    return out;
  }

  dispose(): void {
    for (const s of this.slots) void s.worker.terminate();
    this.slots = [];
    for (const p of this.pending.values()) p.reject(new Error('pool disposed'));
    this.pending.clear();
  }

  private ensureWorkers(n: number): void {
    while (this.slots.length < n) {
      const worker = new Worker(this.workerScript!, { workerData: { wasmDir: this.wasmDir } });
      const slot: Slot = { worker, busy: false };
      worker.on('message', (msg: { id: number; facts?: FileFacts[]; error?: string }) => {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.facts) p.resolve(msg.facts);
        else p.reject(new Error(msg.error ?? 'worker error'));
      });
      worker.on('error', (e) => {
        this.slots = this.slots.filter((s) => s !== slot);
        for (const [id, p] of this.pending) {
          p.reject(e);
          this.pending.delete(id);
        }
      });
      worker.unref(); // idle workers must not keep the process alive…
      this.slots.push(slot);
    }
  }

  private send(slot: Slot, jobs: ParseJob[]): Promise<FileFacts[]> {
    const id = ++this.seq;
    slot.busy = true;
    slot.worker.ref(); // …but busy ones must
    return new Promise<FileFacts[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      slot.worker.postMessage({ id, jobs });
    }).finally(() => {
      slot.busy = false;
      slot.worker.unref();
    });
  }
}

export function parseOne(parsers: Parsers, job: ParseJob): FileFacts {
  try {
    const text = fs.readFileSync(job.abs, 'utf8');
    return extractFile(parsers, job.rel, text);
  } catch (e) {
    return {
      path: job.rel,
      lang: 'cpp',
      lines: 0,
      hash: '',
      entities: [],
      calls: [],
      includes: [],
      imports: [],
      usingNamespaces: [],
      parseMs: 0,
      error: String((e as Error)?.message ?? e),
    };
  }
}
