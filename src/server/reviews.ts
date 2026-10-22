import type { Comment, Review } from '../shared/api.ts';
import { httpError } from './exec.ts';
import { PORT } from './paths.ts';
import { changed, save, sessions, state, wts } from './state.ts';
import type { WorktreeRecord } from './types.ts';
import { newId } from './util.ts';

// ---------- review comments → Claude sessions ----------

export function getComment(id: string | undefined): Comment {
  const c = state.comments.find((x) => x.id === id);
  if (!c) throw httpError(404, 'Unknown comment');
  return c;
}

export function reviewPrompt(wt: WorktreeRecord, review: Review | null, comments: Comment[]): string {
  const lines: string[] = [];
  lines.push(`## Code review on \`${wt.branch || wt.head?.slice(0, 10)}\` (${wt.path})`);
  lines.push('');
  lines.push('This review was left in the Worktree Review dashboard. Address each comment in that worktree.');
  if (review?.summary) lines.push('', '### Overall', '', review.summary);
  for (const c of comments) {
    const where = c.commit ? ` (as of commit ${c.commit.slice(0, 8)}${c.commitSubject ? ` "${c.commitSubject}"` : ''})` : '';
    lines.push('', `### ${c.file}:${c.line}${c.side === 'old' ? ' (removed line)' : ''}${where}  [${c.id}]`);
    if (c.lineText) lines.push('', '```', c.lineText, '```');
    lines.push('', c.body);
    for (const r of c.replies || []) lines.push('', `> **${r.author === 'you' ? 'Reviewer' : 'Claude'}:** ${r.body.replace(/\n/g, '\n> ')}`);
  }
  if (comments.length) {
    lines.push('', '---', 'When a comment is dealt with, mark it resolved so the dashboard shows it (say what you changed):',
      `curl -s -X POST http://127.0.0.1:${PORT}/api/comments/<comment-id>/resolve -H 'x-wtr: 1' -H 'content-type: application/json' -d '{"note":"..."}'`,
      'To answer a comment without resolving it (you disagree, or need clarification), use /reply instead of /resolve with {"body":"..."}.');
  }
  return lines.join('\n');
}

export function submitReview(wt: WorktreeRecord, { summary, targetSession }: { summary?: string; targetSession?: string }): Review {
  const drafts = state.comments.filter((c) => c.wtId === wt.id && c.status === 'draft');
  if (!drafts.length && !summary?.trim()) throw httpError(400, 'Nothing to submit');
  const review: Review = {
    id: newId('r'), wtId: wt.id, wtPath: wt.path, summary: summary?.trim() || '',
    commentIds: drafts.map((c) => c.id), targetSession: targetSession || null,
    status: 'pending', createdAt: Date.now(),
  };
  for (const c of drafts) { c.status = 'pending'; c.reviewId = review.id; }
  state.reviews.push(review);
  save();
  changed();
  return review;
}

export function claimReviews({ session_id, cwd }: { session_id?: string; cwd?: string }): string | null {
  const session = session_id === undefined ? undefined : sessions.get(session_id);
  const ownWt = [...wts.values()]
    .filter((w) => cwd && (cwd === w.path || cwd.startsWith(w.path + '/')))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const claimed: string[] = [];
  for (const r of state.reviews) {
    if (r.status !== 'pending') continue;
    const wt = wts.get(r.wtId);
    if (!wt) continue;
    const ok = r.targetSession
      ? r.targetSession === session_id
      : (session?.worktreePaths.includes(wt.path) || ownWt?.id === wt.id);
    if (!ok) continue;
    r.status = 'delivered';
    r.deliveredAt = Date.now();
    const deliveredTo = { sessionId: session_id, name: session?.name || session_id?.slice(0, 8) };
    r.deliveredTo = deliveredTo;
    const comments = state.comments.filter((c) => r.commentIds.includes(c.id));
    for (const c of comments) if (c.status === 'pending') { c.status = 'delivered'; c.deliveredTo = deliveredTo; }
    claimed.push(reviewPrompt(wt, r, comments));
  }
  if (claimed.length) { save(); changed(); }
  return claimed.length ? claimed.join('\n\n') : null;
}
