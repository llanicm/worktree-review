import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CodeRabbitReview, CodeRabbitUsage, Comment, Finding } from '../shared/api.ts';
import { httpError } from './exec.ts';
import { getIntegrations, lastJson, probe } from './integrations.ts';
import { changed, save, state } from './state.ts';
import type { WorktreeRecord } from './types.ts';
import { asStr, isStringArray, log, newId, rec } from './util.ts';
import { getWt, refreshWorktree } from './worktrees.ts';

// ---------- CodeRabbit reviews ----------

const crChildren = new Map<string, ChildProcess>(); // wtId -> child process

export async function crUsage(wt: WorktreeRecord): Promise<CodeRabbitUsage | null> {
  const r = await probe('coderabbit', ['usage', '--agent'], { cwd: wt.path });
  const u = rec(rec(lastJson(r.out)).includedReviews);
  if (u.state !== 'available') return null;
  const { limit, remaining, fullCapacityInMs, rollingWindowMs, repository } = u;
  if (typeof limit !== 'number' || typeof remaining !== 'number' || typeof fullCapacityInMs !== 'number' || typeof rollingWindowMs !== 'number' || typeof repository !== 'string') return null;
  return { limit, remaining, fullInMs: fullCapacityInMs, windowMs: rollingWindowMs, repository };
}

const asText = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join('\n\n');
  if (typeof v === 'object') {
    const o = rec(v);
    const t = o.text || o.code || o.suggestion || o.diff || o.command;
    return typeof t === 'string' ? t : JSON.stringify(v, null, 2);
  }
  return String(v);
};

function toFinding(ev: Record<string, unknown>): Finding {
  const start = Number(ev.startLine ?? ev.line ?? ev.lineStart) || null;
  return {
    id: newId('f'),
    severity: String(ev.severity || 'info').toLowerCase(),
    file: asStr(ev.fileName) || asStr(ev.file) || asStr(ev.path) || '',
    startLine: start,
    endLine: Number(ev.endLine ?? ev.lineEnd) || start,
    title: asText(ev.title),
    comment: asText(ev.comment),
    codegen: asText(ev.codegenInstructions),
    suggestions: asText(ev.suggestions),
    status: 'open',
  };
}

export async function startCodeRabbit(wt: WorktreeRecord): Promise<CodeRabbitReview> {
  const prev = state.coderabbit[wt.id];
  if (prev?.status === 'running') throw httpError(409, 'A CodeRabbit review is already running for this worktree.');
  const integ = await getIntegrations();
  if (!integ.coderabbit.installed) throw httpError(409, 'The CodeRabbit CLI is not installed. See Settings.');
  if (!integ.coderabbit.authed) throw httpError(409, 'Sign in to CodeRabbit in Settings first.');
  await refreshWorktree(wt);
  const usage = await crUsage(wt);
  if (usage && usage.remaining <= 0) {
    throw httpError(429, `No CodeRabbit reviews left for ${usage.repository} this hour. Try again in about ${Math.ceil(usage.fullInMs / 60000)} minutes.`);
  }
  const review: CodeRabbitReview = {
    status: 'running', startedAt: Date.now(), finishedAt: null, baseRef: wt.baseRef, fingerprint: wt.fingerprint,
    findings: [], reviewedFiles: [], error: null, heartbeatAt: Date.now(),
    usage: usage ? { ...usage, remaining: Math.max(0, usage.remaining - 1) } : null,
  };
  state.coderabbit[wt.id] = review;
  const child = spawn('coderabbit', ['review', '--agent', '--base', wt.baseRef ?? '', '--include-untracked'], { cwd: wt.path, env: process.env });
  crChildren.set(wt.id, child);
  let buf = '', errText = '';
  const handle = (line: string): void => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    const ev = rec(parsed);
    review.heartbeatAt = Date.now();
    if (ev.type === 'finding') {
      const f = toFinding(ev);
      try {
        const lines = fs.readFileSync(path.join(wt.path, f.file), 'utf8').split('\n');
        if (f.startLine) f.snippet = lines.slice(f.startLine - 1, Math.min(f.endLine || f.startLine, f.startLine + 4)).join('\n');
      } catch {}
      review.findings.push(f);
    }
    else if (ev.type === 'complete') { review.reviewedFiles = isStringArray(ev.reviewedFiles) ? ev.reviewedFiles : []; review.message = asStr(ev.message); }
    else if (ev.type === 'error') review.error = asStr(ev.message) || asStr(ev.error) || 'CodeRabbit reported an error.';
    else if (ev.type === 'status' && ev.message) review.message = asStr(ev.message);
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
    crChildren.delete(wt.id);
    review.finishedAt = Date.now();
    if (review.status === 'cancelled') { /* set by cancel */ }
    else if (code === 0 && !review.error) review.status = 'done';
    else {
      review.status = 'failed';
      review.error ||= signal ? `Stopped (${signal}).` : (errText.trim().split('\n').pop() || `CodeRabbit exited with code ${code}.`);
    }
    log(`CodeRabbit review ${review.status} for ${wt.path}: ${review.findings.length} findings`);
    save();
    changed();
  });
  save();
  changed();
  return review;
}

export function cancelCodeRabbit(wtId: string | undefined): void {
  const r = wtId === undefined ? undefined : state.coderabbit[wtId];
  const child = wtId === undefined ? undefined : crChildren.get(wtId);
  if (!r || r.status !== 'running') throw httpError(409, 'No review is running.');
  r.status = 'cancelled';
  r.error = 'Cancelled. CodeRabbit discards a review that is stopped early.';
  child?.kill();
  save();
  changed();
}

export function getFinding(fid: string | undefined): { wtId: string; review: CodeRabbitReview; finding: Finding } {
  for (const [wtId, r] of Object.entries(state.coderabbit)) {
    const f = r.findings?.find((x) => x.id === fid);
    if (f) return { wtId, review: r, finding: f };
  }
  throw httpError(404, 'Unknown finding');
}

export function findingToComment(wtId: string, f: Finding): Comment {
  const wt = getWt(wtId);
  const parts = [`**CodeRabbit (${f.severity})${f.title ? `: ${f.title}` : ''}**`];
  if (f.comment && f.comment !== f.title) parts.push(f.comment);
  if (f.suggestions) parts.push(`Suggested change:\n\`\`\`\n${f.suggestions}\n\`\`\``);
  if (f.codegen && f.codegen !== f.comment) parts.push(`Fix guidance from CodeRabbit:\n${f.codegen}`);
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
