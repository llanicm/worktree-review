// ---------- main view ----------
import type { Comment, Commit, Worktree } from '../shared/api.ts';
import { reviewButtonHtml, reviewPanelsHtml } from './code-review.ts';
import { cleanupPageHtml } from './cleanup.ts';
import { keyOf, parseKey } from './diff.ts';
import { cbarHtml, commitClass, commitOfLine, placedCommentIds, renderFile, threadHtml } from './file.ts';
import { headerHtml } from './header.ts';
import { beginRender, endRender } from './lazy.ts';
import { setupHtml } from './setup.ts';
import { curWt, need, S, st, view } from './state.ts';
import type { CommitGroup, View } from './types.ts';
import { ago, esc, md } from './util.ts';

export function renderMain() {
  const main = need('#main');
  if (S.page) {
    const scroll = main.scrollTop;
    main.innerHTML = S.page === 'cleanup' ? cleanupPageHtml() : setupHtml(S.page);
    main.scrollTop = scroll;
    return;
  }
  if (!S.selId) { main.innerHTML = '<div class="empty">Pick a worktree on the left.</div>'; return; }
  const wt = curWt();
  if (!wt) {
    const gone = S.st?.cleaned.find((c) => location.hash.includes(c.path));
    main.innerHTML = `<div class="empty">${gone ? 'This worktree was cleaned up after its PR merged.' : 'This worktree no longer exists.'}</div>`;
    return;
  }
  if (!S.view || S.view.wtId !== wt.id) { main.innerHTML = `<div class="page">${headerHtml(wt)}<div class="file-note">Loading diff…</div></div>`; return; }
  const v = S.view;
  const byAnchor = commentsByAnchor(v.comments);
  beginRender(main, byAnchor);
  const mode = v.diff.mode;
  const since = mode === 'since';
  const byCommit = mode === 'commits';
  const groups = v.groups ?? [];
  const hiddenCommits = v.diff.mode === 'commits' ? v.diff.hiddenCommits : 0;
  let filesHtml;
  if (byCommit) {
    filesHtml = groups.map((g) => groupHtml(g, byAnchor)).join('') + (hiddenCommits ? `<div class="callout small">${hiddenCommits} older commits aren't shown.</div>` : '');
  } else {
    filesHtml = v.files.map((f) => renderFile(f, byAnchor)).join('');
  }
  const { orphan, otherView } = unplacedComments(v);
  const orphanPanel = orphanHtml(orphan);
  v.orphanHtml = orphanPanel;
  const viewedCount = v.files.filter((f) => v.diff.viewed[f.path] === f.hash).length;

  v.headerSig = headerSig(wt);
  const scroll = main.scrollTop;
  main.innerHTML = `<div class="page" ${S.hl !== null && S.hl !== undefined && !byCommit ? `data-hl="${S.hl}"` : ''}>
    ${headerHtml(wt)}
    ${commitsHtml(v.diff.commits, wt)}
    <div class="toolbar">
      <div class="actions">
        <div class="seg">
          <button data-act="mode" data-mode="full" class="${since || byCommit ? '' : 'on'}">All changes</button>
          <button data-act="mode" data-mode="commits" class="${byCommit ? 'on' : ''}" ${v.diff.commits.length || wt.dirty ? '' : 'disabled'} title="Each commit's changes in the order they were made">By commit</button>
          <button data-act="mode" data-mode="since" class="${since ? 'on' : ''}" ${v.diff.sinceAvailable ? '' : 'disabled title="Mark as reviewed first"'}>Since last review${v.diff.reviewedAt ? ` (${ago(v.diff.reviewedAt)})` : ''}</button>
        </div>
        ${byCommit ? `<span class="progress">${v.diff.commits.length} commit${v.diff.commits.length === 1 ? '' : 's'}, oldest first</span>` : `<span class="progress">${viewedCount} / ${v.files.length} files viewed</span>`}
      </div>
      <div class="actions">
        ${S.stale ? '<span class="banner">New changes landed. <button class="btn small" data-act="refresh">Refresh</button></span>' : ''}
        ${reviewButtonHtml(wt)}
        ${collapseAllHtml(v)}
        <button class="btn" data-act="mark-reviewed" title="Remember this exact state so you can see only what changes next">Mark as reviewed</button>
      </div>
    </div>
    ${reviewPanelsHtml(wt)}
    ${v.diff.mode !== 'commits' && v.diff.truncated ? '<div class="callout warn">This diff is very large and was cut off.</div>' : ''}
    ${orphanPanel}
    ${otherViewHtml(otherView, byCommit)}
    ${byCommit ? filesHtml : v.files.length ? filesSummaryHtml(v) + filesHtml : `<div class="callout">${since ? 'Nothing has changed since your last review.' : `No changes against <code>${esc(v.diff.baseRef)}</code>.`}</div>`}
  </div>
  ${reviewBarHtml(wt)}`;
  main.scrollTop = scroll;
  endRender(main);
  applyHighlight();
  if (S.scrollTo) {
    document.getElementById(S.scrollTo)?.scrollIntoView({ block: 'start' });
    S.scrollTo = null;
  }

  if (S.focusEk) {
    const ta = main.querySelector<HTMLTextAreaElement>(`textarea[data-ek="${CSS.escape(S.focusEk)}"]`);
    if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
    S.focusEk = null;
  }
}

export const commentsByAnchor = (comments: Comment[]) => {
  const byAnchor = new Map<string, Comment[]>();
  for (const c of comments) {
    const k = keyOf(c.file, c.side, c.line, c.commit);
    const here = byAnchor.get(k);
    if (here) here.push(c); else byAnchor.set(k, [c]);
  }
  return byAnchor;
};

// One commit section of the By commit view. Shared by the full render and the in-place collapse patches (collapse.ts).
export function groupHtml(g: CommitGroup, byAnchor: Map<string, Comment[]>) {
  const shut = S.shutCommits.has(g.n);
  return `<section class="commit-group ${commitClass(g.n)} ${shut ? 'shut' : ''}" id="cg-${g.n}">
      <div class="commit-head"><button class="caret" data-act="toggle-commit" data-n="${g.n}" aria-expanded="${!shut}" aria-label="${shut ? 'Expand' : 'Collapse'} this commit" title="${shut ? 'Expand' : 'Collapse'} this commit">${shut ? '▸' : '▾'}</button><span class="cnum">${g.n ? `#${g.n}` : '±'}</span>
        <span class="commit-title">${esc(g.subject)}</span>
        <span class="muted small">${g.sha ? `<span class="mono">${g.sha.slice(0, 8)}</span> · ${esc(g.author)} · ${ago(g.time)} · ` : ''}${g.files.length} file${g.files.length === 1 ? '' : 's'}</span></div>
      ${shut || !g.body ? '' : commitBodyHtml(g.body, g.n)}
      ${shut ? '' : `<div class="commit-files">${g.truncated ? '<div class="callout warn small">This commit is too large to show in full.</div>' : ''}
      ${g.files.map((f) => renderFile(f, byAnchor)).join('') || '<div class="file-note">No file changes.</div>'}</div>`}
    </section>`;
}

// Comments that belong to this view but whose file isn't shown, vs comments made in the other view.
export function unplacedComments(v: View) {
  const byCommit = v.diff.mode === 'commits';
  const placed = placedCommentIds(v);
  const unplaced = v.comments.filter((c) => !placed.has(c.id) && c.status !== 'resolved');
  return { orphan: unplaced.filter((c) => (byCommit ? !!c.commit : !c.commit)), otherView: unplaced.filter((c) => (byCommit ? !c.commit : !!c.commit)) };
}
export const orphanHtml = (orphan: Comment[]) => orphan.length ? `<div class="panel"><div class="panel-head">Comments on files not in this view</div><div class="panel-body threads">${orphan.map((c) => `<div class="mono">${esc(c.file)}:${c.line}</div>${threadHtml(c)}`).join('')}</div></div>` : '';
const otherViewHtml = (otherView: Comment[], byCommit: boolean) => otherView.length ? `<details class="panel"><summary class="panel-head" style="cursor:pointer">${otherView.length} comment${otherView.length === 1 ? '' : 's'} made in the ${byCommit ? 'All changes' : 'By commit'} view
        <button class="btn small" data-act="mode" data-mode="${byCommit ? 'full' : 'commits'}">Show there</button></summary>
      <div class="panel-body threads">${otherView.map((c) => `<div class="mono">${esc(c.file)}:${c.line}${c.commit ? ` · ${c.commit.slice(0, 8)}` : ''}</div>${threadHtml(c)}`).join('')}</div></details>` : '';

export const collapseAllHtml = (v: View) => v.diff.mode === 'commits' && (v.groups ?? []).every((g) => S.shutCommits.has(g.n))
  ? '<button class="btn" data-act="expand-all">Expand all</button>'
  : '<button class="btn" data-act="collapse-all">Collapse all</button>';

export const headerSig = (wt: Worktree) => JSON.stringify([wt.sessions, wt.pr, wt.cleanup, wt.ahead, wt.dirty, wt.baseRef, wt.baseError, wt.error, wt.busy, S.removeErrors[wt.id], st().sessions.length, st().config]);

function commitsHtml(commits: Commit[], wt: Worktree) {
  if (!commits.length && !wt.dirty) return '';
  const byCommit = S.view?.diff.mode === 'commits';
  const canHl = !byCommit && !!S.view?.blame;
  const row = (n: number, sha: string | null, subject: string, time: number | null, body?: string) => `<div class="commit ${S.hl === n && canHl ? 'hl' : ''}" ${body ? `title="${esc(`${subject}\n\n${body}`)}"` : ''}>
      <button class="cswatch ${commitClass(n)}" data-act="hl-commit" data-n="${n}" ${canHl ? '' : 'disabled'} title="${canHl ? 'Highlight the lines from this commit' : byCommit ? '' : 'Working out which lines came from which commit…'}">${n ? `#${n}` : '±'}</button>
      ${sha ? `<span class="mono">${sha.slice(0, 8)}</span>` : ''}<span class="subject">${esc(subject)}</span>
      <span class="when">${time ? ago(time) : ''}</span>
      <button class="link-btn" data-act="view-commit" data-n="${n}">view</button></div>`;
  const rows = commits.map((c) => row(c.n, c.sha, c.subject, c.time, c.body));
  if (wt.dirty) rows.push(row(0, null, `Uncommitted changes (${wt.dirty} file${wt.dirty === 1 ? '' : 's'})`, null));
  return `<details class="panel commits-panel" ${commits.length <= 8 ? 'open' : ''}><summary class="panel-head" style="cursor:pointer">${commits.length} commit${commits.length === 1 ? '' : 's'}, oldest first
      ${S.hl !== null && S.hl !== undefined && canHl ? '<button class="btn small" data-act="hl-commit" data-n="">Clear highlight</button>' : ''}</summary>
    <div class="panel-body">${rows.join('')}</div></details>`;
}

const TRAILER = /^[A-Z][A-Za-z-]+: .+/;
export function commitBodyHtml(body: string, n: number) {
  const lines = body.split('\n');
  // Trailers (Co-Authored-By:, Signed-off-by:, Refs:) are the last paragraph of key: value lines.
  let cut = lines.length;
  while (cut > 0 && (TRAILER.test(lines[cut - 1] ?? '') || !(lines[cut - 1] ?? '').trim())) cut--;
  const trailerBlock = lines.slice(cut).filter((l) => l.trim());
  const isTrailers = trailerBlock.length && trailerBlock.every((l) => TRAILER.test(l));
  const main = (isTrailers ? lines.slice(0, cut) : lines).join('\n').trim();
  const long = main.split('\n').length > 6 || main.length > 600;
  const open = S.openBodies.has(n);
  return `<div class="commit-body ${long && !open ? 'clamped' : ''} ${main ? '' : 'trailers-only'}">
    ${main ? `<div class="commit-msg">${md(main)}</div>` : ''}
    ${isTrailers ? `<div class="commit-trailers">${trailerBlock.map(esc).join('<br>')}</div>` : ''}
    ${long ? `<button class="link-btn" data-act="toggle-body" data-n="${n}">${open ? 'Show less' : 'Show full message'}</button>` : ''}
  </div>`;
}

function applyHighlight() {
  let el = document.getElementById('hl-style');
  if (!el) { el = document.createElement('style'); el.id = 'hl-style'; document.head.appendChild(el); }
  const n = S.hl;
  el.textContent = n === null || n === undefined ? '' : `
    .page[data-hl="${n}"] tr.line.add:not([data-c="${n}"]) td, .page[data-hl="${n}"] tr.line.del td { opacity: .28; }
    .page[data-hl="${n}"] tr.line.add[data-c="${n}"] td.code { box-shadow: inset 3px 0 0 var(--c-hl, currentColor); }`;
}

function filesSummaryHtml(v: View) {
  if (v.files.length < 2) return '';
  return `<details class="panel files-summary" ${v.files.length <= 25 ? 'open' : ''}><summary class="panel-head" style="cursor:pointer">${v.files.length} files changed
      <span><span class="stat-add">+${v.files.reduce((n, f) => n + f.add, 0)}</span> <span class="stat-del">−${v.files.reduce((n, f) => n + f.del, 0)}</span></span></summary>
    <div class="panel-body">${v.files.map((f) => {
      const viewed = v.diff.viewed[f.path] === f.hash;
      const nc = v.comments.filter((c) => c.file === f.path && c.status !== 'resolved').length;
      return `<div class="row ${viewed ? 'viewed' : ''}"><input type="checkbox" data-act="viewed" data-file="${esc(f.path)}" ${viewed ? 'checked' : ''} title="Viewed">
        <a href="#" data-act="jump" data-file="${esc(f.path)}">${esc(f.path)}</a>${nc ? `<span class="chip comments">${nc}</span>` : ''}
        <span class="stat-add">+${f.add}</span><span class="stat-del">−${f.del}</span></div>`;
    }).join('')}</div></details>`;
}

function reviewBarHtml(wt: Worktree) {
  const v = view();
  const drafts = v.comments.filter((c) => c.status === 'draft');
  const summary = S.summaries[wt.id] || '';
  const pending = v.reviews;
  const live = st().sessions;
  const linked = wt.sessions;
  const open = drafts.length || summary || pending.length;
  const target = S.summaries[`${wt.id}:target`] || '';
  const options = [`<option value="">${linked.length ? `Claude session working here (${linked.map((s) => esc(s.name)).join(', ')})` : 'First Claude session that works here'}</option>`]
    .concat(live.map((s) => `<option value="${esc(s.sessionId)}" ${target === s.sessionId ? 'selected' : ''}>${esc(s.name)} (${esc(s.status)})${linked.some((l) => l.sessionId === s.sessionId) ? ' · working here' : ''}</option>`));
  return `<details class="review-bar" ${open ? 'open' : ''}>
    <summary><span>Review</span><span class="progress">${drafts.length} draft comment${drafts.length === 1 ? '' : 's'}${pending.length ? ` · ${pending.length} waiting` : ''}</span></summary>
    <div class="body">
      <textarea data-ek="summary" placeholder="Overall feedback (optional)">${esc(summary)}</textarea>
      <div class="actions">
        <select data-act="target" title="Which Claude session gets this review">${options.join('')}</select>
        <span style="flex:1"></span>
        <button class="btn" data-act="copy-prompt" ${drafts.length || pending.length ? '' : 'disabled'}>Copy as prompt</button>
        <button class="btn primary" data-act="submit" ${drafts.length || summary.trim() ? '' : 'disabled'}>Send to Claude</button>
      </div>
      <div class="note">${linked.length
        ? 'Delivered when that session finishes what it\'s doing, or with your next message to it.'
        : 'No Claude session is working in this worktree right now. It\'ll go to the first one that does, or copy it as a prompt.'}</div>
      ${pending.length ? `<div class="pending-list">${pending.map((r) => `<div>Review with ${r.commentIds.length} comment${r.commentIds.length === 1 ? '' : 's'} waiting since ${ago(r.createdAt)} · <button class="link-btn" data-act="cancel-review" data-id="${r.id}">take back</button></div>`).join('')}</div>` : ''}
    </div>
  </details>`;
}

// Blame arrives after the diff is on screen: add each added line's commit bar to the rows already drawn,
// rather than redrawing the whole diff. Rows still waiting in a placeholder (lazy.ts) get theirs when drawn.
export function applyBlame() {
  const page = need('#main').querySelector(':scope > .page');
  // Not drawn yet (headerSig is set by renderMain): the coming render includes the bars.
  if (!S.view?.headerSig) return;
  if (!page || S.view.diff.mode === 'commits') { renderMain(); return; }
  for (const row of page.querySelectorAll<HTMLElement>('section.file tr.line.add:not([data-c])')) {
    const k = row.dataset.k;
    if (!k) continue;
    const { commit, file, line } = parseKey(k);
    if (commit) continue;
    const cn = commitOfLine(file, line);
    if (cn === undefined) continue;
    row.dataset.c = String(cn);
    row.querySelector('td.code')?.insertAdjacentHTML('afterbegin', cbarHtml(cn));
  }
  // The commit swatches can highlight now.
  for (const b of page.querySelectorAll<HTMLButtonElement>('.commits-panel .cswatch[disabled]')) {
    b.disabled = false;
    b.title = 'Highlight the lines from this commit';
  }
}
