import fs from 'node:fs';
import type {
  BlameResponse, CodeRabbitLogin, CodeRabbitResponse, CodeRabbitReview, Comment, CommentsResponse, DiffResponse, DirListing,
  Finding, HookResponse, Integrations, Job, NewComment, Ok, PromptResponse, PublicState, RepairResult, Review, SendAllResponse,
  ShutdownResponse,
} from '../shared/api.ts';
import { cleanupStatus } from './cleanup-status.ts';
import { cancelCodeRabbit, crUsage, findingToComment, getFinding, startCodeRabbit } from './coderabbit.ts';
import { getBlame, getDiff } from './diffs.ts';
import { gitOk, httpError } from './exec.ts';
import { getIntegrations, markHook, probe, startCodeRabbitLogin } from './integrations.ts';
import { deferShutdown, jobs, jobsRunning, shutdownNow, startJob } from './jobs.ts';
import { HOME } from './paths.ts';
import { publicState } from './public-state.ts';
import { removeWorktree, repairWorktrees } from './removal.ts';
import { claimReviews, getComment, reviewPrompt, submitReview } from './reviews.ts';
import { refreshSessions } from './sessions.ts';
import { listDir, updateConfig } from './settings.ts';
import { changed, save, state, wts, wtState } from './state.ts';
import { log, newId } from './util.ts';
import { getWt, refreshWorktree } from './worktrees.ts';

/** Everything a route can answer with. Handlers are checked against this, so a response can't drift from ../shared/api.ts. */
type ApiResult =
  | PublicState | DiffResponse | BlameResponse | CommentsResponse | PromptResponse | Ok | Job | RepairResult | CodeRabbitResponse
  | CodeRabbitReview | Finding | SendAllResponse | DirListing | Integrations | CodeRabbitLogin | Comment | Review | ShutdownResponse | HookResponse;

type Handler = (m: RegExpMatchArray, body: unknown, url: URL) => ApiResult | Promise<ApiResult>;
export type Route = readonly [method: string, re: RegExp, handler: Handler];

// Request bodies are parsed JSON and, as before, trusted to have the fields the page sends:
// a missing or mistyped one surfaces as an error response, not a validation message.
const bodyOf = <T>(raw: unknown): T => raw as T;
const arg = (m: RegExpMatchArray, i = 1): string | undefined => m[i];

export const routes: Route[] = [
  ['GET', /^\/api\/state$/, () => publicState()],
  ['GET', /^\/api\/worktrees\/(\w+)\/diff$/, (m, _body, url) => getDiff(getWt(arg(m)), url.searchParams.get('mode'))],
  ['GET', /^\/api\/worktrees\/(\w+)\/blame$/, (m) => getBlame(getWt(arg(m)))],
  ['GET', /^\/api\/worktrees\/(\w+)\/comments$/, (m): CommentsResponse => {
    getWt(arg(m));
    return {
      comments: state.comments.filter((c) => c.wtId === m[1]),
      reviews: state.reviews.filter((r) => r.wtId === m[1] && r.status === 'pending'),
    };
  }],
  ['GET', /^\/api\/worktrees\/(\w+)\/prompt$/, (m): PromptResponse => {
    const wt = getWt(arg(m));
    const cs = state.comments.filter((c) => c.wtId === wt.id && (c.status === 'draft' || c.status === 'pending'));
    return { text: reviewPrompt(wt, null, cs) };
  }],
  ['POST', /^\/api\/worktrees\/(\w+)\/base$/, async (m, raw): Promise<Ok> => {
    const body = bodyOf<{ base?: string }>(raw);
    const wt = getWt(arg(m));
    const ref = (body.base || '').trim();
    if (ref && !(await gitOk(wt.path, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))) throw httpError(400, `Unknown ref: ${ref}`);
    wtState(wt.id, wt.path).baseOverride = ref || null;
    save();
    await refreshWorktree(wt, { force: true });
    return { ok: true };
  }],
  ['POST', /^\/api\/worktrees\/(\w+)\/reviewed$/, (m, raw): Ok => {
    const body = bodyOf<{ tree?: string; fingerprint?: string | null }>(raw);
    const wt = getWt(arg(m));
    const s = wtState(wt.id, wt.path);
    s.reviewedTree = body.tree;
    s.reviewedFp = wt.snap && wt.snap.tree === body.tree ? wt.snap.fp : body.fingerprint;
    s.reviewedAt = Date.now();
    save();
    changed();
    return { ok: true };
  }],
  ['POST', /^\/api\/worktrees\/(\w+)\/viewed$/, (m, raw): Ok => {
    const body = bodyOf<{ viewed?: boolean; file: string; hash: string }>(raw);
    const wt = getWt(arg(m));
    const s = wtState(wt.id, wt.path);
    s.viewed ||= {};
    if (body.viewed) s.viewed[body.file] = body.hash; else delete s.viewed[body.file];
    save();
    return { ok: true };
  }],
  ['POST', /^\/api\/worktrees\/(\w+)\/submit$/, (m, raw) => submitReview(getWt(arg(m)), bodyOf<{ summary?: string; targetSession?: string }>(raw))],
  ['POST', /^\/api\/worktrees\/(\w+)\/remove$/, (m, raw) => {
    const body = bodyOf<{ force?: unknown }>(raw);
    const wt = getWt(arg(m));
    if (wt.busy) throw httpError(409, 'This worktree is already being removed.');
    const force = body.force === true;
    return startJob('remove', `Removing ${wt.branch || 'worktree'}${force ? ' (anyway)' : ''}`, [wt], (w) => removeWorktree(w, 'manual', { force }));
  }],
  ['POST', /^\/api\/jobs\/(\w+)\/dismiss$/, (m): Ok => {
    const job = jobs.find((j) => j.id === m[1]);
    if (job) job.dismissed = true;
    changed();
    return { ok: true };
  }],
  ['POST', /^\/api\/cleanup\/safe$/, () => {
    const items = [...wts.values()].filter((wt) => {
      const cs = !wt.busy && cleanupStatus(wt);
      return cs && cs.kind === 'merged' && cs.eligible;
    });
    if (!items.length) throw httpError(409, 'Nothing is safe to remove right now.');
    return startJob('cleanup', `Removing ${items.length} merged worktree${items.length === 1 ? '' : 's'}`, items, (wt) => removeWorktree(wt, 'manual'));
  }],
  // Remove the worktrees you picked on the clean-up page. Each is checked again just before removal.
  ['POST', /^\/api\/cleanup$/, (_m, raw) => {
    const body = bodyOf<{ ids?: unknown }>(raw);
    const ids: unknown[] = Array.isArray(body.ids) ? body.ids : [];
    const items = ids.flatMap((id) => {
      const wt = typeof id === 'string' ? wts.get(id) : undefined;
      return wt && !wt.busy && cleanupStatus(wt)?.eligible ? [wt] : [];
    });
    if (!items.length) throw httpError(409, 'None of those can be removed right now.');
    return startJob('cleanup', `Removing ${items.length} worktree${items.length === 1 ? '' : 's'}`, items, (wt) => removeWorktree(wt, 'manual'));
  }],
  ['POST', /^\/api\/worktrees\/(\w+)\/repair$/, async (m) => repairWorktrees([getWt(arg(m))])],
  ['POST', /^\/api\/repair$/, async () => repairWorktrees([...wts.values()].filter((w) => w.error?.kind === 'broken-link'))],
  ['POST', /^\/api\/config$/, async (_m, body): Promise<Ok> => { await updateConfig(body); return { ok: true }; }],
  ['GET', /^\/api\/worktrees\/(\w+)\/coderabbit$/, async (m, _body, url): Promise<CodeRabbitResponse> => {
    const wt = getWt(arg(m));
    const review = state.coderabbit[wt.id] || null;
    return { review, usage: url.searchParams.has('usage') ? await crUsage(wt) : review?.usage || null };
  }],
  ['POST', /^\/api\/worktrees\/(\w+)\/coderabbit$/, (m) => startCodeRabbit(getWt(arg(m)))],
  ['POST', /^\/api\/worktrees\/(\w+)\/coderabbit\/cancel$/, (m): Ok => {
    cancelCodeRabbit(arg(m));
    return { ok: true };
  }],
  ['POST', /^\/api\/findings\/(\w+)\/(send|dismiss|restore)$/, (m): Finding => {
    const { wtId, finding } = getFinding(arg(m));
    if (m[2] === 'send') findingToComment(wtId, finding);
    else if (m[2] === 'dismiss') finding.status = 'dismissed';
    else finding.status = 'open';
    save();
    changed();
    return finding;
  }],
  ['POST', /^\/api\/worktrees\/(\w+)\/coderabbit\/send-all$/, (m): SendAllResponse => {
    const wt = getWt(arg(m));
    const r = state.coderabbit[wt.id];
    const open = (r?.findings || []).filter((f) => f.status === 'open');
    for (const f of open) findingToComment(wt.id, f);
    save();
    changed();
    return { sent: open.length };
  }],
  ['GET', /^\/api\/fs$/, (_m, _body, url) => listDir(url.searchParams.get('path'), url.searchParams.get('hidden') === '1')],
  ['GET', /^\/api\/integrations$/, (_m, _body, url) => getIntegrations(url.searchParams.has('refresh'))],
  ['POST', /^\/api\/integrations\/coderabbit\/login$/, () => startCodeRabbitLogin()],
  ['POST', /^\/api\/integrations\/coderabbit\/logout$/, async () => {
    await probe('coderabbit', ['auth', 'logout', '--agent']);
    return getIntegrations(true);
  }],
  ['POST', /^\/api\/onboarding$/, (_m, raw): Ok => {
    const body = bodyOf<{ done?: boolean }>(raw);
    state.onboardedAt = body.done === false ? null : Date.now();
    save();
    changed();
    return { ok: true };
  }],
  ['POST', /^\/api\/comments$/, (_m, raw): Comment => {
    const body = bodyOf<NewComment & { lineText: string }>(raw);
    const wt = getWt(body.wtId);
    if (!body.body?.trim()) throw httpError(400, 'Empty comment');
    const c: Comment = {
      id: newId('c'), wtId: wt.id, wtPath: wt.path, file: body.file, line: body.line, side: body.side,
      lineText: body.lineText, body: body.body.trim(), status: 'draft', createdAt: Date.now(), replies: [],
      commit: /^[0-9a-f]{40}$/.test(body.commit || '') ? body.commit : undefined,
      commitSubject: body.commitSubject || undefined,
    };
    state.comments.push(c);
    save();
    changed();
    return c;
  }],
  ['PATCH', /^\/api\/comments\/(\w+)$/, (m, raw): Comment => {
    const body = bodyOf<{ body?: unknown }>(raw);
    const c = getComment(arg(m));
    if (c.status !== 'draft') throw httpError(409, 'Only drafts can be edited');
    c.body = String(body.body || '').trim() || c.body;
    save();
    return c;
  }],
  ['DELETE', /^\/api\/comments\/(\w+)$/, (m): Ok => {
    const c = getComment(arg(m));
    state.comments = state.comments.filter((x) => x !== c);
    save();
    changed();
    return { ok: true };
  }],
  ['POST', /^\/api\/comments\/(\w+)\/reply$/, (m, raw): Comment => {
    const body = bodyOf<{ body?: string; author?: string }>(raw);
    const c = getComment(arg(m));
    if (!body.body?.trim()) throw httpError(400, 'Empty reply');
    const author = body.author || 'claude';
    c.replies.push({ author, body: body.body.trim(), at: Date.now() });
    // A reply from you re-opens the thread and sends it back to Claude.
    if (author === 'you' && c.status !== 'draft') c.status = 'draft';
    save();
    changed();
    return c;
  }],
  ['POST', /^\/api\/comments\/(\w+)\/resolve$/, (m, raw): Comment => {
    const body = bodyOf<{ note?: string; author?: string }>(raw);
    const c = getComment(arg(m));
    c.status = 'resolved';
    c.resolvedAt = Date.now();
    if (body.note?.trim()) c.replies.push({ author: body.author || 'claude', body: body.note.trim(), at: Date.now() });
    save();
    changed();
    return c;
  }],
  ['POST', /^\/api\/comments\/(\w+)\/reopen$/, (m): Comment => {
    const c = getComment(arg(m));
    c.status = 'delivered';
    save();
    changed();
    return c;
  }],
  ['POST', /^\/api\/reviews\/(\w+)\/cancel$/, (m): Ok => {
    const r = state.reviews.find((x) => x.id === m[1] && x.status === 'pending');
    if (!r) throw httpError(404, 'No pending review');
    r.status = 'cancelled';
    for (const c of state.comments) if (r.commentIds.includes(c.id) && c.status === 'pending') c.status = 'draft';
    save();
    changed();
    return { ok: true };
  }],
  ['POST', /^\/api\/shutdown$/, (_m, raw): ShutdownResponse => {
    const body = bodyOf<{ restartWith?: unknown }>(raw);
    // Never cut a removal off halfway: finish running jobs, then hand over to the replacement if one was named.
    const replacement = typeof body.restartWith === 'string' && body.restartWith.endsWith('server.mjs') && fs.existsSync(body.restartWith) ? body.restartWith : null;
    if (jobsRunning()) {
      deferShutdown(replacement);
      log(`shutdown requested; waiting for running jobs to finish${replacement ? `, then starting ${replacement}` : ''}`);
      return { ok: true, deferred: true };
    }
    setTimeout(() => shutdownNow(replacement), 100);
    return { ok: true };
  }],
  ['POST', /^\/api\/hook$/, (_m, raw): HookResponse => {
    markHook();
    refreshSessions();
    return { text: claimReviews(bodyOf<{ session_id?: string; cwd?: string }>(raw)) };
  }],
];

// Test-only (WTR_TEST_JOBS=1): a slow fake cleanup over pretend worktrees, to exercise the progress UI.
if (process.env.WTR_TEST_JOBS === '1') {
  routes.push(['POST', /^\/api\/test\/job$/, (_m, raw): Job => {
    const body = bodyOf<{ count?: number; delay?: number; failAt?: number }>(raw);
    const items = Array.from({ length: body.count || 4 }, (_, i) => ({ id: `test${i}`, branch: `test/branch-${i + 1}`, path: `${HOME}/fake/wt-${i + 1}` }));
    return startJob('cleanup', `Removing ${items.length} merged worktrees`, items, async (w) => {
      await new Promise((r) => setTimeout(r, body.delay || 1500));
      if (w.id === `test${(body.failAt ?? -1)}`) throw new Error("Git refused to remove it: Git found modified or untracked files in it, so it wasn't removed.");
    });
  }]);
}
