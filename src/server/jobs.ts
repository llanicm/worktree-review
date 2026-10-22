import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Job, WorktreeError } from '../shared/api.ts';
import { errInfo, httpError } from './exec.ts';
import { DATA_DIR } from './paths.ts';
import { changed } from './state.ts';
import { log, newId } from './util.ts';
import type { Server } from 'node:http';

// ---------- background jobs (bulk cleanup, single removals) ----------
// Removing a worktree deletes its files, which takes seconds for a big repo, so
// removals run here and report progress over the live connection.

export const jobs: Job[] = [];
let pendingShutdown: { replacement: string | null } | null = null;

let httpServer: Server | null = null;
export function registerServer(s: Server): void { httpServer = s; }

/** Shut down once running jobs are done, handing over to `replacement` (a server.mjs) if one is named. */
export function deferShutdown(replacement: string | null): void { pendingShutdown = { replacement }; }

export const jobsRunning = (): boolean => jobs.some((j) => j.status === 'running');

export function shutdownNow(replacement: string | null): void {
  if (replacement) {
    const out = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
    httpServer?.close();
    // Give the port a moment to free up before the replacement binds it.
    setTimeout(() => {
      spawn(process.execPath, [replacement], { cwd: path.resolve(path.dirname(replacement), '..'), detached: true, stdio: ['ignore', out, out], env: process.env }).unref();
      process.exit(0);
    }, 300);
  } else process.exit(0);
}

/** What a job works through: a worktree, or (in tests) a stand-in for one. */
export interface JobSubject {
  id: string;
  branch: string | null;
  path: string;
  busy?: string | null;
  error?: WorktreeError | null;
}

export function startJob<T extends JobSubject>(kind: Job['kind'], title: string, items: T[], worker: (wt: T) => Promise<void>): Job {
  if (kind === 'cleanup' && jobs.some((j) => j.kind === 'cleanup' && j.status === 'running')) {
    throw httpError(409, 'A cleanup is already running.');
  }
  const job: Job = {
    id: newId('j'), kind, title, total: items.length, done: 0, current: null,
    ok: [], failed: [], status: 'running', startedAt: Date.now(), finishedAt: null, dismissed: false,
  };
  jobs.unshift(job);
  jobs.splice(20);
  (async () => {
    for (const wt of items) {
      job.current = { id: wt.id, branch: wt.branch, path: wt.path, startedAt: Date.now() };
      wt.busy = kind;
      changed();
      try {
        await worker(wt);
        job.ok.push({ id: wt.id, branch: wt.branch, path: wt.path });
      } catch (e) {
        job.failed.push({ id: wt.id, branch: wt.branch, path: wt.path, error: errInfo(e).message, kind: wt.error?.kind || null });
      } finally {
        wt.busy = null;
      }
      job.done++;
      changed();
    }
    job.current = null;
    job.status = 'done';
    job.finishedAt = Date.now();
    log(`${job.title}: ${job.ok.length} ok, ${job.failed.length} failed`, job.failed.map((f) => `${f.path}: ${f.error}`).join(' | '));
    changed();
    if (pendingShutdown && !jobsRunning()) setTimeout(() => shutdownNow(pendingShutdown?.replacement ?? null), 1000);
  })();
  return job;
}
