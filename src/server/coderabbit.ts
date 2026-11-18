import type { CodeRabbitUsage, CodeReview, Finding } from '../shared/api.ts';
import { addSnippet, assertIdle, beginReview, runReview, startInBackground } from './code-review.ts';
import { config } from './config.ts';
import { httpError } from './exec.ts';
import { coderabbitReady, getIntegrations, lastJson, probe } from './integrations.ts';
import type { WorktreeRecord } from './types.ts';
import { asStr, isStringArray, newId, rec } from './util.ts';
import { refreshWorktree } from './worktrees.ts';

// ---------- CodeRabbit reviews ----------

/** The hourly allowance of included reviews, or null when it can't be read. An unavailable allowance has none left. */
export async function crUsage(wt: WorktreeRecord): Promise<CodeRabbitUsage | null> {
  const r = await probe('coderabbit', ['usage', '--agent'], { cwd: wt.path });
  const u = rec(rec(lastJson(r.out)).includedReviews);
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const [limit, remaining, fullInMs, windowMs] = [num(u.limit), num(u.remaining), num(u.fullCapacityInMs), num(u.rollingWindowMs)];
  if (u.state === 'unavailable') return { limit: limit ?? 0, remaining: 0, fullInMs: fullInMs ?? 0, windowMs: windowMs ?? 0, repository: asStr(u.repository) || '' };
  if (u.state !== 'available' || limit === null || remaining === null || fullInMs === null || windowMs === null || typeof u.repository !== 'string') return null;
  return { limit, remaining, fullInMs, windowMs, repository: u.repository };
}

/** Why a review stopped instead of spending usage credits nobody agreed to. */
function creditsMessage(usage: CodeRabbitUsage | null): string {
  if (!usage) return "Couldn't check how many of your hourly CodeRabbit reviews are left, so it didn't start in case it would be charged.";
  const wait = usage.fullInMs ? ` More free ones come back within about ${Math.ceil(usage.fullInMs / 60000)} minutes.` : '';
  return `No free CodeRabbit reviews left${usage.repository ? ` for ${usage.repository}` : ''} this hour.${wait}`;
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

/**
 * Past the hourly allowance, CodeRabbit can bill each review to usage credits without asking (its "Automatic"
 * setting), so a review only runs there when it's started with useCredits.
 */
export function startCodeRabbit(wt: WorktreeRecord, useCredits = false): CodeReview {
  assertIdle(wt, 'coderabbit');
  const review = beginReview(wt, 'coderabbit', { message: 'Checking how many CodeRabbit reviews you have left', useCredits: useCredits || undefined });
  startInBackground(wt, review, async () => {
    const integ = coderabbitReady() ? null : await getIntegrations();
    if (integ && !integ.coderabbit.installed) throw httpError(409, 'The CodeRabbit CLI is not installed. See Settings.');
    if (integ && !integ.coderabbit.authed) throw httpError(409, 'Sign in to CodeRabbit in Settings first.');
    await refreshWorktree(wt);
    const usage = await crUsage(wt);
    if (!useCredits && (!usage || usage.remaining <= 0)) {
      review.needsCredits = true;
      throw httpError(402, creditsMessage(usage));
    }
    review.usage = usage ? { ...usage, remaining: Math.max(0, usage.remaining - 1) } : null;
    review.message = 'Starting';
  }, () => runCodeRabbit(wt, review));
  return review;
}

function runCodeRabbit(wt: WorktreeRecord, review: CodeReview): void {
  // --fresh: by default the CLI reviews only what changed since its last local review, but each review here
  // replaces the previous one, so a re-run would look clean while earlier findings still stand.
  const args = ['review', '--agent', '--fresh', '--base', wt.baseRef ?? '', '--include-untracked'];
  if (config.coderabbitDeep) args.push('--deep');
  if (review.useCredits) args.push('--use-credits');
  runReview(wt, review, 'coderabbit', args, {
    onEvent: (ev) => {
      // With usage-based reviews "On demand", the CLI stops at the limit and waits for consent instead.
      if (ev.type === 'action_required' || ev.status === 'awaiting_confirmation') {
        review.needsCredits = true;
        review.error = asStr(ev.message) || 'No free CodeRabbit reviews left this hour. CodeRabbit is waiting for you to agree to pay for this one with usage credits.';
      } else if (ev.type === 'finding') review.findings.push(addSnippet(wt, toFinding(ev)));
      else if (ev.type === 'complete') { review.reviewedFiles = isStringArray(ev.reviewedFiles) ? ev.reviewedFiles : []; review.message = asStr(ev.message); }
      else if (ev.type === 'error') review.error = asStr(ev.message) || asStr(ev.error) || 'CodeRabbit reported an error.';
      else if (ev.type === 'status' && ev.message) review.message = asStr(ev.message);
    },
  });
}
