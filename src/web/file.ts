// ---------- diff files, line comments ----------
import type { Comment, Finding } from '../shared/api.ts';
import { findingHtml } from './coderabbit.ts';
import { hl, keyOf, langFor, sameCommit } from './diff.ts';
import { curWt, S, view } from './state.ts';
import type { ViewFile } from './types.ts';
import { ago, editorLink, editorName, esc, fnv, md } from './util.ts';

export const commitClass = (n: number) => (n === 0 ? 'cu' : `c${((n - 1) % 8) + 1}`);
export const commitLabel = (n: number) => (n === 0 ? 'uncommitted' : `#${n}`);

// Commit number (0 = uncommitted) that last touched line n of a file, from blame runs.
function commitOfLine(file: string, n: number | undefined) {
  const b = S.view?.blame?.lines?.[file];
  if (!b) return undefined;
  for (const [a, z, c] of b) if (n !== undefined && n >= a && n <= z) return c;
  return undefined;
}
export function commitByN(n: number) { return S.view?.diff.commits.find((c) => c.n === n); }

/** Commits that touched a file (0 = uncommitted); only the All changes / Since views carry this. */
export const fileCommitsOf = (path: string): number[] => {
  const d = S.view?.diff;
  return (d && 'fileCommits' in d ? d.fileCommits?.[path] : undefined) || [];
};

export function isCollapsed(f: ViewFile) {
  const t = S.toggled.get(f.uid);
  if (t !== undefined) return t;
  return (!f.commit && view().diff.viewed[f.path] === f.hash) || f.generated;
}

// TODO(api.ts): Comment has no `deliveredTo`, but the server sets { sessionId, name } when it delivers one.
function statusLabel(c: Comment & { deliveredTo?: { sessionId: string; name: string } }) {
  if (c.status === 'draft') return 'Draft';
  if (c.status === 'pending') return 'Submitted · waiting for a session';
  if (c.status === 'delivered') return `Sent to ${c.deliveredTo?.name || 'Claude'}`;
  if (c.status === 'resolved') return 'Resolved';
  return c.status;
}

export function editorHtml(ek: string, label: string) {
  return `<div class="editor"><textarea data-ek="${esc(ek)}" placeholder="Leave a comment">${esc(S.editors.get(ek) || '')}</textarea>
    <div class="actions"><span class="hint">⌘↵ to save · Esc to cancel</span>
      <button class="btn small" data-act="cancel-editor" data-ek="${esc(ek)}">Cancel</button>
      <button class="btn small primary" data-act="save-editor" data-ek="${esc(ek)}">${label}</button></div></div>`;
}

export function threadHtml(c: Comment) {
  const editing = S.editors.has(`edit:${c.id}`);
  const replying = S.editors.has(`reply:${c.id}`);
  const msgs = [`<div class="msg"><div class="msg-head"><strong>You</strong><span class="status ${c.status}">${esc(statusLabel(c))}</span><span>${ago(c.createdAt)}</span></div>
    ${editing ? editorHtml(`edit:${c.id}`, 'Update') : `<div class="msg-body">${md(c.body)}</div>`}</div>`];
  for (const r of c.replies || []) {
    msgs.push(`<div class="msg"><div class="msg-head"><strong>${r.author === 'you' ? 'You' : 'Claude'}</strong><span>${ago(r.at)}</span></div><div class="msg-body">${md(r.body)}</div></div>`);
  }
  const acts: string[] = [];
  if (c.status === 'draft' && !editing) acts.push(`<button class="btn small" data-act="edit" data-id="${c.id}">Edit</button>`, `<button class="btn small danger" data-act="delete" data-id="${c.id}">Delete</button>`);
  if (c.status === 'delivered' || c.status === 'pending') acts.push(`<button class="btn small" data-act="resolve" data-id="${c.id}">Resolve</button>`);
  if (c.status === 'resolved') acts.push(`<button class="btn small" data-act="reopen" data-id="${c.id}">Reopen</button>`);
  if (c.status !== 'draft' && !replying) acts.push(`<button class="btn small" data-act="reply" data-id="${c.id}">Reply</button>`);
  if (replying) msgs.push(`<div class="msg">${editorHtml(`reply:${c.id}`, 'Reply')}<div class="msg-head">A reply turns this back into a draft to send to Claude with your next review.</div></div>`);
  return `<div class="thread ${c.status}">${msgs.join('')}${acts.length ? `<div class="thread-actions">${acts.join('')}</div>` : ''}</div>`;
}

export function renderFile(f: ViewFile, byAnchor: Map<string, Comment[]>, used: Set<string>) {
  const v = view();
  const collapsed = isCollapsed(f);
  const viewed = v.diff.viewed[f.path] === f.hash;
  const wt = curWt();
  const name = f.status === 'renamed' && f.oldPath !== f.newPath
    ? `<span class="from">${esc(f.oldPath)} →</span> ${esc(f.newPath)}` : esc(f.path);
  const tag = f.status !== 'modified' ? `<span class="file-tag">${f.status}</span>` : '';
  const gen = f.generated ? '<span class="file-tag">generated</span>' : '';
  const firstLine = f.hunks[0]?.lines.find((l) => l.n)?.n || 1;

  let body;
  const lang = langFor(f.path);
  // Lines this diff actually shows; anything anchored elsewhere goes in the "not on a changed line" block.
  const shown = new Set<string>();
  for (const h of f.hunks) for (const l of h.lines) shown.add(l.t === 'del' ? keyOf(f.path, 'old', l.o, f.commit) : keyOf(f.path, 'new', l.n, f.commit));
  const mine = (v.comments || []).filter((c) => c.file === f.path && sameCommit(c.commit, f.commit) && c.status !== 'resolved');
  const outsideComments = mine.filter((c) => !shown.has(keyOf(c.file, c.side, c.line, c.commit)));
  const fileFindings = f.commit ? [] : (v.cr?.findings || []).filter((x) => x.file === f.path && x.status === 'open');
  const outsideFindings = fileFindings.filter((x) => !shown.has(keyOf(x.file, 'new', x.endLine || x.startLine)));
  const nOpen = mine.length + fileFindings.length;
  const touched = !f.commit ? fileCommitsOf(f.path) : [];
  const commitChips = touched.length && v.diff.commits.length
    ? touched.map((n) => `<span class="cchip ${commitClass(n)}" title="${esc(n ? `${commitByN(n)?.sha.slice(0, 8)} ${commitByN(n)?.subject || ''}` : 'Not committed yet')}">${commitLabel(n)}</span>`).join('') : '';
  const head = `<div class="file-head">
    <button class="caret" data-act="toggle-file" data-file="${esc(f.uid)}" aria-label="Collapse">${collapsed ? '▸' : '▾'}</button>
    ${f.commitN !== undefined && f.commit !== null || f.uncommitted ? `<span class="cchip fill ${commitClass(f.commitN ?? 0)}" title="${esc(f.uncommitted ? 'Uncommitted changes' : `Commit #${f.commitN}`)}">${f.uncommitted ? '±' : `#${f.commitN}`}</span>` : ''}
    <span class="file-name" title="${esc(f.path)}">${name}</span>${tag}${gen}${commitChips}
    <span class="stat-add">+${f.add}</span><span class="stat-del">−${f.del}</span>
    ${collapsed && nOpen ? `<span class="chip comments" title="Expand to see them">${nOpen} comment${nOpen === 1 ? '' : 's'}</span>` : ''}
    ${f.status !== 'deleted' && wt && editorLink(wt.path) ? `<a class="file-tag" href="${esc(editorLink(`${wt.path}/${f.path}`, firstLine))}" title="Open in ${editorName()}">open</a>` : ''}
    ${f.commit ? '' : `<label class="viewed-box ${viewed ? 'on' : ''}"><input type="checkbox" data-act="viewed" data-file="${esc(f.path)}" ${viewed ? 'checked' : ''}> Viewed</label>`}
  </div>`;
  if (collapsed) body = '';
  else if (f.binary) body = '<div class="file-note">Binary file</div>';
  else if (!f.hunks.length) body = `<div class="file-note">${f.status === 'renamed' ? 'Renamed without changes' : 'No content changes (mode change or empty file)'}</div>`;
  else if (f.lineCount > 2500 && !S.forceRender.has(f.uid)) body = `<div class="file-note">Large diff (${f.lineCount} lines). <button class="link-btn" data-act="force-render" data-file="${esc(f.uid)}">Load it</button></div>`;
  else {
    const rows: string[] = [];
    for (const h of f.hunks) {
      rows.push(`<tr class="hunk"><td colspan="3">${esc(h.header)}</td></tr>`);
      for (const l of h.lines) {
        const side = l.t === 'del' ? 'old' : 'new';
        const line = l.t === 'del' ? l.o : l.n;
        const k = keyOf(f.path, side, line, f.commit);
        const sign = l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' ';
        const cn = !f.commit && l.t === 'add' ? commitOfLine(f.path, l.n) : undefined;
        const cAttr = cn !== undefined ? ` data-c="${cn}"` : '';
        const cBar = cn !== undefined ? `<span class="cbar ${commitClass(cn)}" title="${esc(cn ? `#${cn} ${commitByN(cn)?.sha.slice(0, 8)} ${commitByN(cn)?.subject || ''}` : 'Not committed yet')}"></span>` : '';
        rows.push(`<tr class="line ${l.t}" data-k="${esc(k)}"${cAttr}><td class="num" data-act="new-comment" data-k="${esc(k)}">${l.o ?? ''}</td><td class="num" data-act="new-comment" data-k="${esc(k)}">${l.n ?? ''}</td><td class="code">${cBar}<button class="add-c" data-act="new-comment" data-k="${esc(k)}" title="Comment on this line">+</button><span class="sign">${sign}</span>${hl(l.text, lang)}</td></tr>`);
        const crHere: Finding[] = side === 'new' ? (v.crByAnchor?.get(k) || []) : [];
        const threads = (byAnchor.get(k) || []);
        threads.forEach((c) => used.add(c.id));
        const ek = `new:${k}`;
        if (threads.length || crHere.length || S.editors.has(ek)) {
          rows.push(`<tr class="thread-row"><td colspan="3"><div class="threads">${crHere.map((f) => findingHtml(f, true)).join('')}${threads.map(threadHtml).join('')}${S.editors.has(ek) ? editorHtml(ek, 'Add comment') : ''}</div></td></tr>`);
        }
      }
    }
    body = `<table class="diff"><colgroup><col class="num"><col class="num"><col></colgroup>${rows.join('')}</table>`;
  }
  const snippet = (line: number | null | undefined, text: string | undefined) => `<div class="outside-line"><span class="outside-no">${line ?? ''}</span><code>${text ? hl(text, lang) : '<span class="muted">(line not available)</span>'}</code></div>`;
  const outsideItems = [
    ...outsideFindings.map((x) => ({ line: x.startLine, html: snippet(x.startLine, x.snippet) + findingHtml(x, true) })),
    ...outsideComments.map((c) => { used.add(c.id); return { line: c.line, html: snippet(c.line, c.lineText) + threadHtml(c) }; }),
  ].sort((a, b) => (a.line || 0) - (b.line || 0));
  const out = outsideItems.length && !collapsed
    ? `<div class="outdated"><div class="outdated-label">Not on a changed line, so shown here</div><div class="threads">${outsideItems.map((i) => i.html).join('')}</div></div>` : '';
  return `<section class="file ${collapsed ? 'collapsed' : ''}" id="f-${fnv(f.uid)}">${head}<div class="file-body">${out}${body}</div></section>`;
}
