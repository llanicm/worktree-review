// ---------- sidebar ----------
import type { PullRequest, Session, SessionRef, Worktree } from '../shared/api.ts';
import { NAMES, REVIEWERS } from './code-review.ts';
import { renderJobs } from './jobs.ts';
import { need, S, st } from './state.ts';
import { ago, esc, md, shortPath } from './util.ts';

export type Groups = Record<'working' | 'merged' | 'recent' | 'older', Worktree[]>;

/** The worktree to open when none is chosen: the one most likely to need a review now. */
export function defaultWorktree(list: Worktree[]): Worktree | undefined {
  const g = grouped(list);
  return [...g.working, ...g.recent].find((w) => w.review.needsReview) ?? g.working[0] ?? g.recent[0] ?? list.find((w) => !w.isMain) ?? list[0];
}

export function grouped(list: Worktree[]): Groups {
  const recentMs = st().config.recentDays * 864e5;
  const g: Groups = { working: [], merged: [], recent: [], older: [] };
  for (const wt of list) {
    if (wt.sessions.length) g.working.push(wt);
    else if (wt.pr?.state === 'MERGED') g.merged.push(wt);
    else if (Date.now() - wt.lastActivity < recentMs) g.recent.push(wt);
    else g.older.push(wt);
  }
  for (const items of Object.values(g)) items.sort((a, b) => b.lastActivity - a.lastActivity);
  return g;
}

export function prChip(pr: PullRequest | null) {
  if (!pr) return '';
  const cls = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draftpr' : 'open';
  const label = pr.state === 'OPEN' && pr.isDraft ? 'draft' : pr.state.toLowerCase();
  return `<span class="chip ${cls}" title="${esc(pr.title)}">#${pr.number} ${label}</span>`;
}

export function sessionChip(s: SessionRef | Session) {
  return `<span class="chip" title="Claude session ${esc(s.name)} is ${esc(s.status)}"><span class="dot ${esc(s.status)}"></span>${esc(s.name)}</span>`;
}

function reviewChip(wt: Worktree) {
  const running = REVIEWERS.filter((k) => wt.codeReviews[k]?.status === 'running');
  if (running.length) return `<span class="chip cr"><span class="dot busy"></span>${running.map((k) => NAMES[k]).join(', ')}</span>`;
  const open = REVIEWERS.reduce((n, k) => n + (wt.codeReviews[k]?.open || 0), 0);
  return open ? `<span class="chip cr">${open} finding${open === 1 ? '' : 's'}</span>` : '';
}

function wtItem(wt: Worktree, showNew?: boolean) {
  const name = wt.branch || `detached @ ${wt.head?.slice(0, 8) || '?'}`;
  const c = wt.comments;
  const nComments = c.draft + c.waiting + c.open;
  const stats = wt.stats && (wt.stats.add || wt.stats.del)
    ? `<span class="stat-add">+${wt.stats.add}</span><span class="stat-del">−${wt.stats.del}</span>` : '';
  return `<a class="wt ${S.selId === wt.id ? 'sel' : ''}" href="#/${wt.id}" title="${esc(wt.path)}">
    <div class="wt-top">
      ${showNew && wt.review.needsReview ? '<span class="new-dot" title="Changed since you last reviewed"></span>' : ''}
      <span class="wt-branch">${esc(name)}</span>${stats}
    </div>
    <div class="wt-sub">
      <span class="wt-path">${esc(shortPath(wt.path))}</span><span>· ${ago(wt.lastActivity)}</span>
    </div>
    <div class="wt-sub">
      ${wt.sessions.map(sessionChip).join('')}${prChip(wt.pr)}
      ${nComments ? `<span class="chip comments">${nComments} comment${nComments === 1 ? '' : 's'}</span>` : ''}
      ${wt.busy ? '<span class="chip busy-chip"><span class="dot busy"></span>removing…</span>' : ''}
      ${wt.error ? `<span class="chip closed" title="${esc(wt.error.message)}">${wt.error.kind === 'broken-link' ? 'broken link' : "can't read"}</span>`
        : wt.dirtyKind === 'lockfile-only' ? '<span class="chip" title="Only a lockfile changed">lockfile changed</span>'
        : wt.dirtyKind === 'deleted-only' ? `<span class="chip" title="Tracked files missing from disk; nothing is lost">${wt.dirty} missing</span>`
        : wt.dirty ? `<span class="chip" title="Uncommitted changes">${wt.dirty} uncommitted</span>` : ''}
      ${reviewChip(wt)}
    </div>
  </a>`;
}

interface SectionOpts { always?: boolean; right?: string; tools?: string; hidden?: boolean; showNew?: boolean }

export function renderSidebar() {
  if (!S.st) return;
  const f = S.filter.toLowerCase();
  const list = S.st.worktrees.filter((w) => !f || (w.branch || '').toLowerCase().includes(f) || w.path.toLowerCase().includes(f));
  const g = grouped(list);
  const safe = g.merged.filter((w) => w.cleanup?.kind === 'merged' && w.cleanup.eligible).length;
  const idle = S.st.worktrees.filter((w) => w.cleanup && !w.sessions.length).length;
  const parts: string[] = [];
  const section = (title: string, items: Worktree[], opts: SectionOpts = {}) => {
    if (!items.length && !opts.always) return;
    parts.push(`<div class="group-head"><span>${title} <span class="count">${items.length}</span></span>${opts.right || ''}</div>`);
    if (opts.tools) parts.push(opts.tools);
    if (!opts.hidden) parts.push(items.map((w) => wtItem(w, opts.showNew)).join(''));
  };
  const broken = S.st.worktrees.filter((w) => w.error?.kind === 'broken-link').length;
  if (broken) {
    parts.push(`<div class="side-alert"><strong>${broken} worktree${broken === 1 ? ' has a' : 's have'} broken link${broken === 1 ? '' : 's'}</strong>
      to ${broken === 1 ? 'its' : 'their'} repository, so git can't read ${broken === 1 ? 'it' : 'them'}. This usually means the repository moved.
      <button class="btn small" data-act="repair-all">Repair ${broken === 1 ? 'it' : `all ${broken}`}</button></div>`);
  }
  section('Claude is working', g.working, { showNew: true });
  section('Recent', g.recent, { showNew: true });
  section('PR merged', g.merged, {
    tools: `<div class="group-tools">
      <label class="toggle"><input type="checkbox" data-act="auto-cleanup" ${S.st.config.autoCleanup ? 'checked' : ''}> Remove automatically when merged</label>
      ${safe ? `<button class="link-btn" data-act="cleanup-safe">Remove ${safe} safe now</button>` : ''}
    </div>`,
  });
  section('Older', g.older, {
    hidden: !S.showOlder && !f,
    right: f ? '' : `<button class="link-btn" data-act="toggle-older">${S.showOlder ? 'hide' : 'show'}</button>`,
  });
  if (idle && !f) {
    parts.push(`<div class="group-tools"><a class="link-btn" href="#/cleanup">Clean up worktrees no session is using (${idle})</a></div>`);
  }
  if (S.st.cleaned.length) {
    parts.push(`<div class="group-head"><span>Cleaned up <span class="count">${S.st.cleaned.length}</span></span>
      <button class="link-btn" data-act="toggle-cleaned">${S.showCleaned ? 'hide' : 'show'}</button></div>`);
    if (S.showCleaned) {
      parts.push(`<div class="cleaned">${S.st.cleaned.map((c, i) => `<div class="item">
        <div><strong>${esc(c.branch || `detached @ ${c.sha.slice(0, 8)}`)}</strong>${c.pr ? ` · <a href="${esc(c.pr.url)}" target="_blank">#${c.pr.number}</a>` : ''} · ${c.how === 'auto' ? 'auto' : c.how === 'forced' ? 'removed anyway' : 'by you'} ${ago(c.at)}${c.reason === 'idle' ? ' · unmerged' : ''}</div>
        ${c.branchKept ? `<div>Branch ${esc(c.branchKept)}</div>` : ''}
        <div class="mono">${esc(shortPath(c.path))}</div>
        <button class="link-btn" data-act="copy-restore" data-i="${i}">Copy restore command</button>
      </div>`).join('')}</div>`);
    }
  }
  if (!S.st.worktrees.length) parts.push('<div class="group-tools">No worktrees yet. Repos show up here once Claude Code has worked in them.</div>');
  if (S.st.prError) parts.unshift(`<div class="group-tools">${md(S.st.prError)}</div>`);
  need('#list').innerHTML = parts.join('');
  renderJobs();

  const recentMs = S.st.config.recentDays * 864e5;
  const n = S.st.worktrees.filter((w) => w.review.needsReview && (w.sessions.length || Date.now() - w.lastActivity < recentMs)).length;
  document.title = n ? `(${n}) Worktree Review` : 'Worktree Review';
}
