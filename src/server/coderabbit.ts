import type { CodeRabbitUsage, CodeReview, Finding } from '../shared/api.ts';
import { addSnippet, assertIdle, beginReview, runReview } from './code-review.ts';
import { httpError } from './exec.ts';
import { getIntegrations, lastJson, probe } from './integrations.ts';
import type { WorktreeRecord } from './types.ts';
import { asStr, isStringArray, newId, rec } from './util.ts';
import { refreshWorktree } from './worktrees.ts';

// ---------- CodeRabbit reviews ----------

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
    source: 'coderabbit',
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

export async function startCodeRabbit(wt: WorktreeRecord): Promise<CodeReview> {
  assertIdle(wt, 'coderabbit');
  const integ = await getIntegrations();
  if (!integ.coderabbit.installed) throw httpError(409, 'The CodeRabbit CLI is not installed. See Settings.');
  if (!integ.coderabbit.authed) throw httpError(409, 'Sign in to CodeRabbit in Settings first.');
  await refreshWorktree(wt);
  const usage = await crUsage(wt);
  if (usage && usage.remaining <= 0) {
    throw httpError(429, `No CodeRabbit reviews left for ${usage.repository} this hour. Try again in about ${Math.ceil(usage.fullInMs / 60000)} minutes.`);
  }
  const review = beginReview(wt, 'coderabbit', { usage: usage ? { ...usage, remaining: Math.max(0, usage.remaining - 1) } : null });
  runReview(wt, review, 'coderabbit', ['review', '--agent', '--base', wt.baseRef ?? '', '--include-untracked'], {
    onEvent: (ev) => {
      if (ev.type === 'finding') review.findings.push(addSnippet(wt, toFinding(ev)));
      else if (ev.type === 'complete') { review.reviewedFiles = isStringArray(ev.reviewedFiles) ? ev.reviewedFiles : []; review.message = asStr(ev.message); }
      else if (ev.type === 'error') review.error = asStr(ev.message) || asStr(ev.error) || 'CodeRabbit reported an error.';
      else if (ev.type === 'status' && ev.message) review.message = asStr(ev.message);
    },
  });
  return review;
}
