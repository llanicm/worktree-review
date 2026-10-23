import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CodeReview, Comment, Finding, Reviewer } from '../shared/api.ts';
import { errInfo, httpError } from './exec.ts';
import { changed, reviewerPids, save, state } from './state.ts';
import type { WorktreeRecord } from './types.ts';
import { log, newId, rec } from './util.ts';
import { contentTree, getWt } from './worktrees.ts';

// ---------- code reviews: what CodeRabbit and Claude share ----------
// Each reviewer keeps its own latest review per worktree, so running one never discards the other's findings.

export const REVIEWER_NAMES: Record<Reviewer, string> = { coderabbit: 'CodeRabbit', claude: 'Claude' };
export const isReviewer = (v: unknown): v is Reviewer => v === 'coderabbit' || v === 'claude';

const children = new Map<string, ChildProcess>(); // `${wtId} ${reviewer}` -> child process

export const reviewOf = (wtId: string, reviewer: Reviewer): CodeReview | undefined => state.codeReviews[wtId]?.[reviewer];

/** Records a new running review, replacing that reviewer's last one. */
export function beginReview(wt: WorktreeRecord, reviewer: Reviewer, extra: Partial<CodeReview> = {}): CodeReview {
  const review: CodeReview = {
    reviewer, status: 'running', startedAt: Date.now(), finishedAt: null, baseRef: wt.baseRef, fingerprint: wt.fingerprint,
    findings: [], reviewedFiles: [], error: null, heartbeatAt: Date.now(), usage: null, ...extra,
  };
  (state.codeReviews[wt.id] ??= {})[reviewer] = review;
  return review;
}

export function assertIdle(wt: WorktreeRecord, reviewer: Reviewer): void {
  if (reviewOf(wt.id, reviewer)?.status === 'running') throw httpError(409, `A ${REVIEWER_NAMES[reviewer]} review is already running for this worktree.`);
}

/**
 * Answers the request at once with the review already running, so the page shows it the moment you click, then does
 * the slower set-up (checking the CLI, refreshing the worktree, CodeRabbit's allowance) and starts the reviewer.
 * A problem found on the way fails the review with its message.
 */
export function startInBackground(wt: WorktreeRecord, review: CodeReview, setUp: () => Promise<void>, run: () => void): void {
  save();
  changed();
  setUp().then(async () => {
    if (review.status !== 'running') return; // cancelled while setting up
    review.baseRef = wt.baseRef;
    review.fingerprint = wt.fingerprint;
    review.contentTree = wt.contentTree = await contentTree(wt);
    if (review.status === 'running') run();
  }).catch((e: unknown) => {
    if (review.status !== 'running') return;
    review.status = 'failed';
    review.error = errInfo(e).message || `${REVIEWER_NAMES[review.reviewer]} couldn't start.`;
    review.finishedAt = Date.now();
    log(`${REVIEWER_NAMES[review.reviewer]} review couldn't start for ${wt.path}: ${review.error}`);
    save();
    changed();
  });
}

/** The first few lines a finding points at, to show next to it in the panel. */
export function addSnippet(wt: WorktreeRecord, f: Finding): Finding {
  try {
    const lines = fs.readFileSync(path.join(wt.path, f.file), 'utf8').split('\n');
    if (f.startLine) f.snippet = lines.slice(f.startLine - 1, Math.min(f.endLine || f.startLine, f.startLine + 4)).join('\n');
  } catch {}
  return f;
}

/** Runs a reviewer's CLI, handing each JSON line it prints to `onEvent`. `finish` runs once it exits, before the outcome is decided. */
export function runReview(wt: WorktreeRecord, review: CodeReview, cmd: string, args: string[],
  { env = process.env, onEvent, finish }: { env?: NodeJS.ProcessEnv; onEvent: (ev: Record<string, unknown>) => void; finish?: () => void }): void {
  const name = REVIEWER_NAMES[review.reviewer];
  const key = `${wt.id} ${review.reviewer}`;
  const child = spawn(cmd, args, { cwd: wt.path, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.set(key, child);
  if (child.pid) reviewerPids.add(child.pid);
  let buf = '', errText = '';
  const handle = (line: string): void => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    review.heartbeatAt = Date.now();
    onEvent(rec(parsed));
    save();
    changed();
  };
  child.stdout.on('data', (d: Buffer) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) !== -1) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr.on('data', (d: Buffer) => { errText = (errText + d).slice(-4000); });
  child.on('error', (e) => { review.status = 'failed'; review.error = e.message; save(); changed(); });
  child.on('close', (code, signal) => {
    if (buf.trim()) handle(buf);
    children.delete(key);
    if (child.pid) reviewerPids.delete(child.pid);
    review.finishedAt = Date.now();
    if (review.status === 'cancelled') { /* set by cancel */ }
    else {
      if (code === 0) finish?.();
      if (code === 0 && !review.error) review.status = 'done';
      else {
        review.status = 'failed';
        review.error ||= signal ? `Stopped (${signal}).` : (errText.trim().split('\n').pop() || `${name} exited with code ${code}.`);
      }
    }
    log(`${name} review ${review.status} for ${wt.path}: ${review.findings.length} findings`);
    save();
    changed();
  });
  save();
  changed();
}

export function cancelReview(wtId: string | undefined, reviewer: Reviewer): void {
  const r = wtId === undefined ? undefined : reviewOf(wtId, reviewer);
  if (!r || r.status !== 'running') throw httpError(409, 'No review is running.');
  r.status = 'cancelled';
  r.error = reviewer === 'coderabbit' ? 'Cancelled. CodeRabbit discards a review that is stopped early.' : 'Cancelled.';
  children.get(`${wtId} ${reviewer}`)?.kill();
  save();
  changed();
}

export function getFinding(fid: string | undefined): { wtId: string; review: CodeReview; finding: Finding } {
  for (const [wtId, byReviewer] of Object.entries(state.codeReviews)) {
    for (const r of Object.values(byReviewer)) {
      const f = r.findings.find((x) => x.id === fid);
      if (f) return { wtId, review: r, finding: f };
    }
  }
  throw httpError(404, 'Unknown finding');
}

export function findingToComment(wtId: string, f: Finding): Comment {
  const wt = getWt(wtId);
  const parts = [`**${REVIEWER_NAMES[f.source]} (${f.severity})${f.title ? `: ${f.title}` : ''}**`];
  if (f.comment && f.comment !== f.title) parts.push(f.comment);
  if (f.suggestions) parts.push(`Suggested change:\n\`\`\`\n${f.suggestions}\n\`\`\``);
  if (f.codegen && f.codegen !== f.comment) parts.push(`Fix guidance from ${REVIEWER_NAMES[f.source]}:\n${f.codegen}`);
  const c: Comment = {
    id: newId('c'), wtId: wt.id, wtPath: wt.path, file: f.file, line: f.endLine || f.startLine || 1, side: 'new',
    lineText: '', body: parts.join('\n\n'), status: 'draft', createdAt: Date.now(), replies: [], fromFinding: f.id,
  };
  try {
    const text = fs.readFileSync(path.join(wt.path, f.file), 'utf8').split('\n');
    c.lineText = text[(c.line || 1) - 1] ?? '';
  } catch {}
  state.comments.push(c);
  f.status = 'sent';
  f.commentId = c.id;
  return c;
}
