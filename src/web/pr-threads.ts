// ---------- GitHub PR review threads ----------
import type { PRThread, PRThreads, Worktree } from '../shared/api.ts';
import { keyOf } from './diff.ts';
import { api, S, view } from './state.ts';
import type { View } from './types.ts';
import { ago, esc, md } from './util.ts';

const CODERABBIT = 'coderabbitai';
export const authorName = (login: string) => (login === CODERABBIT ? 'CodeRabbit' : login);
/** CodeRabbit's threads take its colour; everyone else's GitHub's. */
const colourOf = (t: PRThread) => (t.comments[0]?.author === CODERABBIT ? 'coderabbit' : 'github');

/** Changes whenever the threads or what you did with them change. */
export const prSig = (wt: Worktree) => wt.prThreads?.sig || '';

/** Threads to show in the diff: still open on GitHub, not handled here, and on a line that still exists. */
const showsInline = (t: PRThread) => !t.isResolved && t.status === 'open' && t.localLine !== null;

export const openThreads = (v: View): PRThread[] => (v.prThreads?.threads || []).filter((t) => !t.isResolved && t.status === 'open');

export function indexPRThreads() {
  const v = view();
  const byAnchor = new Map<string, PRThread[]>();
  v.prByAnchor = byAnchor;
  for (const t of v.prThreads?.threads || []) {
    if (!showsInline(t)) continue;
    const k = keyOf(t.file, 'new', t.localLine);
    const here = byAnchor.get(k);
    if (here) here.push(t); else byAnchor.set(k, [t]);
  }
}

export async function loadPRThreads() {
  const v = S.view;
  if (!v) return;
  try {
    v.prThreads = await api<PRThreads>('GET', `/api/worktrees/${v.wtId}/pr-threads`);
    indexPRThreads();
  } catch {}
}

/** Fetch the threads from GitHub now, rather than at the next check. */
export function syncPRThreads(wt: Worktree) {
  if (wt.pr?.state !== 'OPEN') return Promise.resolve();
  return api<PRThreads>('POST', `/api/worktrees/${wt.id}/pr-threads/sync`).then((r) => {
    if (S.view?.wtId !== wt.id) return;
    S.view.prThreads = r;
    indexPRThreads();
  });
}

const where = (t: PRThread) => {
  const n = t.localLine ?? t.line ?? t.originalLine;
  return `${t.file}${n ? `:${n}` : ''}`;
};

function msgHtml(t: PRThread, i: number) {
  const c = t.comments[i];
  if (!c) return '';
  const lead = i === 0 && t.title ? `<div class="cr-title">${md(t.title)}</div>` : '';
  return `<div class="msg"><div class="msg-head"><strong class="${i === 0 ? 'cr-name' : ''}">${esc(authorName(c.author))}</strong>
      ${i === 0 && t.severity ? `<span class="sev ${esc(t.severity)}">${esc(t.severity)}</span>` : ''}
      <a href="${esc(c.url)}" target="_blank" rel="noopener" class="muted">${ago(c.createdAt)}</a></div>
    ${lead}${c.body && c.body !== t.title ? `<div class="msg-body">${md(c.body)}</div>` : ''}
    ${i === 0 && t.suggestions ? `<details><summary>Suggested change</summary><pre class="suggestion">${esc(t.suggestions)}</pre></details>` : ''}
    ${i === 0 && t.codegen ? `<details><summary>Fix guidance for agents</summary><div class="msg-body">${md(t.codegen)}</div></details>` : ''}</div>`;
}

/** An editor's save button, disabled with a spinner while its save is in flight. */
export function saveButtonHtml(ek: string, label: string) {
  const busy = S.saving.has(ek);
  return `<button class="btn small primary" data-act="save-editor" data-ek="${esc(ek)}" data-label="${esc(label)}"${busy ? ' disabled aria-busy="true"' : ''}>${busy ? '<span class="spinner" aria-hidden="true"></span>' : ''}${esc(label)}</button>`;
}

/** One thread: its comments, and what you can do with it here and on GitHub. */
export function prThreadHtml(t: PRThread, inline = false) {
  const ek = `gh:${t.id}`;
  const replying = S.editors.has(ek);
  const claudeSaid = S.view?.prThreads?.claudeReplies[t.id];
  const acts: string[] = [];
  if (t.status === 'open') acts.push(`<button class="btn small primary" data-act="pr-send" data-id="${esc(t.id)}">Send to Claude</button>`);
  if (t.canReply && !replying) {
    acts.push(`<button class="btn small" data-act="pr-reply" data-id="${esc(t.id)}">Reply on GitHub</button>`);
    if (claudeSaid) acts.push(`<button class="btn small" data-act="pr-reply" data-id="${esc(t.id)}" data-claude="1" title="Start a GitHub reply from what Claude said about it">Reply with Claude's answer</button>`);
  }
  if (!t.isResolved && t.canResolve) acts.push(`<button class="btn small" data-act="pr-resolve" data-id="${esc(t.id)}" title="Resolve this conversation on GitHub">Resolve on GitHub</button>`);
  if (t.isResolved && t.canUnresolve) acts.push(`<button class="btn small" data-act="pr-unresolve" data-id="${esc(t.id)}">Unresolve on GitHub</button>`);
  if (t.status === 'open') acts.push(`<button class="btn small" data-act="pr-dismiss" data-id="${esc(t.id)}" title="Hide it here; GitHub is left as it is">Dismiss</button>`);
  if (t.status === 'sent') acts.push('<span class="muted small">Added to your review as a draft</span>');
  if (t.status === 'dismissed') acts.push(`<span class="muted small">Dismissed</span><button class="link-btn" data-act="pr-restore" data-id="${esc(t.id)}">undo</button>`);
  const tags = [t.isResolved ? '<span class="status resolved">Resolved on GitHub</span>' : '',
    t.isOutdated ? '<span class="status" title="The code it was left on has changed in the PR">Outdated</span>' : '',
    !inline ? `<a href="#" class="mono" data-act="cr-jump" data-file="${esc(t.file)}" data-line="${t.localLine ?? ''}" data-id="${esc(t.id)}">${esc(where(t))}</a>` : ''].join('');
  // Collapsed to its first comment once handled, as findings are.
  const shown = t.status === 'open' || !inline ? t.comments.map((_, i) => msgHtml(t, i)) : [msgHtml(t, 0)];
  return `<div class="thread cr-finding pr-thread ${colourOf(t)} ${t.status}${t.isResolved ? ' resolved' : ''}"${inline ? ` id="fd-${esc(t.id)}"` : ''}>
    ${tags ? `<div class="pr-tags">${tags}</div>` : ''}${shown.join('')}
    ${replying ? `<div class="msg"><div class="editor"><textarea data-ek="${esc(ek)}" placeholder="Reply on GitHub, as you">${esc(S.editors.get(ek) || '')}</textarea>
      <div class="actions"><span class="hint">Posted to the PR as you · ⌘↵ to post · Esc to cancel</span>
        <button class="btn small" data-act="cancel-editor" data-ek="${esc(ek)}">Cancel</button>
        ${saveButtonHtml(ek, 'Post reply')}</div></div></div>` : ''}
    <div class="thread-actions">${acts.join('')}</div></div>`;
}

/** The PR's threads: how many are open, and the ones that can't be shown on a line of the diff. */
export function prPanelHtml(wt: Worktree) {
  const p = S.view?.prThreads;
  if (!wt.pr || wt.pr.state !== 'OPEN' || !p) return '';
  const all = p.threads;
  const open = all.filter((t) => !t.isResolved && t.status === 'open');
  const inDiff = (t: PRThread) => !!S.view?.files.some((f) => f.path === t.file && !f.commit) && t.localLine !== null && S.view?.diff.mode !== 'commits';
  const loose = open.filter((t) => !inDiff(t));
  const shown = open.filter(inDiff);
  const done = all.filter((t) => t.isResolved || t.status !== 'open');
  const head = !p.fetchedAt ? `Comments on PR #${p.number}` : `PR #${p.number} · ${open.length ? `${open.length} open of ${all.length} thread${all.length === 1 ? '' : 's'}` : all.length ? 'no open threads' : 'no review comments yet'}`;
  const facts = p.syncing ? 'Checking GitHub…' : p.fetchedAt ? `checked ${ago(p.fetchedAt)}` : '';
  return `<div class="panel cr-panel pr-panel github" id="pr-panel">
    <div class="panel-head"><span>${head}</span><span class="actions"><span class="muted small">${facts}</span>
      <a class="btn small" href="${esc(p.url || wt.pr.url)}/files" target="_blank" rel="noopener">Open on GitHub</a>
      <button class="btn small" data-act="pr-sync" ${p.syncing ? 'disabled' : ''}>Check now</button></span></div>
    <div class="panel-body">
      ${p.error ? `<p class="error">${esc(p.error)}</p>` : ''}
      ${shown.length ? `<ul class="cr-index">${shown.map((t) => `<li><a href="#" class="cr-item" data-act="cr-jump" data-file="${esc(t.file)}" data-line="${t.localLine ?? ''}" data-id="${esc(t.id)}">
        <span class="cr-line mono">${esc(where(t))}</span><strong>${esc(authorName(t.comments[0]?.author || ''))}</strong>
        <span class="cr-item-title">${md(t.title || (t.comments[0]?.body || '').split('\n')[0] || 'Comment')}</span></a></li>`).join('')}</ul>` : ''}
      ${loose.length ? `<div class="cr-loose"><div class="muted small">Not on a line of this diff${S.view?.diff.mode === 'commits' ? ' view' : ' (outdated, or the line has changed since)'}, so shown here:</div>
        <div class="threads cr-list">${loose.map((t) => prThreadHtml(t)).join('')}</div></div>` : ''}
      ${done.length ? `<details class="cr-done"><summary>${done.length} resolved, sent or dismissed</summary><div class="threads cr-list">${done.map((t) => prThreadHtml(t)).join('')}</div></details>` : ''}
    </div></div>`;
}
