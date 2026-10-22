import type { ServerResponse } from 'node:http';
import type { PublicState, Worktree } from '../shared/api.ts';
import { cleanupStatus } from './cleanup-status.ts';
import { config } from './config.ts';
import { coderabbitReady, crLogin } from './integrations.ts';
import { jobs } from './jobs.ts';
import { HOME, PORT, VERSION } from './paths.ts';
import { prError } from './prs.ts';
import { repos, sessions, state, takeChanged, wts } from './state.ts';
import type { WorktreeRecord, WorktreeState } from './types.ts';
import { sha1 } from './util.ts';

// ---------- public state & SSE ----------

function publicWorktree(wt: WorktreeRecord): Worktree {
  const s: Partial<WorktreeState> = state.worktrees[wt.id] ?? {};
  const mine = state.comments.filter((c) => c.wtId === wt.id);
  const r = state.coderabbit[wt.id];
  return {
    id: wt.id, path: wt.path, repoName: wt.repoName, branch: wt.branch, head: wt.head,
    isMain: wt.isMain, locked: wt.locked, detached: wt.detached,
    fingerprint: wt.fingerprint, dirty: wt.dirty, lastActivity: wt.lastActivity,
    ahead: wt.ahead, stats: wt.stats, baseRef: wt.baseRef, baseSource: wt.baseSource, baseError: wt.baseError,
    pr: wt.pr ? { number: wt.pr.number, state: wt.pr.state, isDraft: wt.pr.isDraft, url: wt.pr.url, title: wt.pr.title, mergedAt: wt.pr.mergedAt } : null,
    sessions: wt.sessions.map((x) => ({ sessionId: x.sessionId, name: x.name, status: x.status })),
    cleanup: cleanupStatus(wt),
    error: wt.error || null,
    busy: wt.busy || null,
    dirtyKind: wt.dirtyKind || null,
    coderabbit: r ? {
      status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, heartbeatAt: r.heartbeatAt,
      open: r.findings.filter((f) => f.status === 'open').length, total: r.findings.length,
      sig: sha1(r.status + r.findings.map((f) => f.id + f.status).join()).slice(0, 10),
    } : null,
    review: {
      reviewedAt: s.reviewedAt || null,
      needsReview: !!wt.fingerprint && (wt.stats?.files || 0) > 0 && s.reviewedFp !== wt.fingerprint,
    },
    comments: {
      draft: mine.filter((c) => c.status === 'draft').length,
      waiting: mine.filter((c) => c.status === 'pending').length,
      open: mine.filter((c) => c.status === 'delivered').length,
      sig: sha1(mine.map((c) => `${c.id}${c.status}${c.replies.length}${c.body.length}`).join()
        + state.reviews.filter((r) => r.wtId === wt.id).map((r) => r.status).join()).slice(0, 10),
    },
  };
}

export function publicState(): PublicState {
  return {
    port: PORT,
    version: VERSION,
    home: HOME,
    prError,
    config: {
      autoCleanup: config.autoCleanup, recentDays: config.recentDays, editor: config.editor,
      prPollMinutes: config.prPollMinutes, roots: config.roots, extraRepos: config.extraRepos,
    },
    onboardedAt: state.onboardedAt || null,
    repos: [...repos.values()].map((r) => ({ name: r.name, root: r.root, github: r.gh ? `${r.gh.owner}/${r.gh.name}` : null })),
    coderabbitLogin: crLogin,
    jobs: jobs.filter((j) => !j.dismissed).slice(0, 5),
    coderabbitReady: coderabbitReady(),
    installedAt: state.installedAt,
    sessions: [...sessions.values()].map((s) => ({ sessionId: s.sessionId, name: s.name, status: s.status, cwd: s.cwd })),
    cleaned: state.cleaned.slice(0, 30),
    worktrees: [...wts.values()].map(publicWorktree),
  };
}

export const clients = new Set<ServerResponse>();
let lastSent = '';

export function startBroadcast(): void {
  setInterval(() => {
    if (!takeChanged()) return;
    const json = JSON.stringify(publicState());
    if (json === lastSent) return;
    lastSent = json;
    for (const res of clients) res.write(`event: state\ndata: ${json}\n\n`);
  }, 500);
  setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25_000);
}
