// ---------- diff files, line comments ----------
import type { Comment, FileBlame, Finding } from '../shared/api.ts';
import { findingHtml, findingsOf } from './code-review.ts';
import { hl, keyOf, langFor, sameCommit } from './diff.ts';
import { curWt, S, view } from './state.ts';
import type { View, ViewFile } from './types.ts';
import { ago, editorLink, editorName, esc, fnv, md } from './util.ts';
import { lazyPlaceholder, lazyPlaceholderHtml } from './lazy.ts';

export const commitClass = (n: number) => (n === 0 ? 'cu' : `c${((n - 1) % 8) + 1}`);
export const commitLabel = (n: number) => (n === 0 ? 'uncommitted' : `#${n}`);

// Commit number (0 = uncommitted) that last touched line n of a file, from blame runs.
export function commitOfLine(file: string, n: number | undefined) {
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

function statusLabel(c: Comment) {
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

/** What a file's body shows; the one place that decides it, for both the full render and in-place collapse patches. */
export type BodyKind = 'collapsed' | 'binary' | 'empty' | 'large' | 'rows';
export function bodyKind(f: ViewFile): BodyKind {
  if (isCollapsed(f)) return 'collapsed';
  if (f.binary) return 'binary';
  if (!f.hunks.length) return 'empty';
  if (f.lineCount > 2500 && !S.forceRender.has(f.uid)) return 'large';
  return 'rows';
}

/** Lines this diff actually shows; anything anchored elsewhere goes in the "not on a changed line" block. */
function shownKeys(f: ViewFile) {
  const shown = new Set<string>();
  for (const h of f.hunks) for (const l of h.lines) shown.add(l.t === 'del' ? keyOf(f.path, 'old', l.o, f.commit) : keyOf(f.path, 'new', l.n, f.commit));
  return shown;
}

/**
 * Open comments that end up in some rendered file: on a line row, or in its "not on a changed line" block
 * (that block is built even for a collapsed file). Files whose rows aren't rendered (collapsed, binary, too large,
 * or in a collapsed commit) leave their on-a-line comments out, so they surface in "Comments on files not in this view".
 */
export function placedCommentIds(v: View) {
  const placed = new Set<string>();
  const byFile = new Map<string, Comment[]>();
  for (const c of v.comments) {
    if (c.status === 'resolved') continue;
    const k = `${c.commit || ''}\0${c.file}`;
    const here = byFile.get(k);
    if (here) here.push(c); else byFile.set(k, [c]);
  }
  if (!byFile.size) return placed;
  const files = v.diff.mode === 'commits' ? (v.groups ?? []).filter((g) => !S.shutCommits.has(g.n)).flatMap((g) => g.files) : v.files;
  for (const f of files) {
    const mine = byFile.get(`${f.commit || ''}\0${f.path}`);
    if (!mine) continue;
    const rows = bodyKind(f) === 'rows';
    const shown = rows ? null : shownKeys(f);
    for (const c of mine) if (!shown || !shown.has(keyOf(c.file, c.side, c.line, c.commit))) placed.add(c.id);
  }
  return placed;
}

export function renderFile(f: ViewFile, byAnchor: Map<string, Comment[]>) {
  const v = view();
  const kind = bodyKind(f);
  const collapsed = kind === 'collapsed';
  const viewed = v.diff.viewed[f.path] === f.hash;
  const wt = curWt();
  const name = f.status === 'renamed' && f.oldPath !== f.newPath
    ? `<span class="from">${esc(f.oldPath)} →</span> ${esc(f.newPath)}` : esc(f.path);
  const tag = f.status !== 'modified' ? `<span class="file-tag">${f.status}</span>` : '';
  const gen = f.generated ? '<span class="file-tag">generated</span>' : '';
  const firstLine = f.hunks[0]?.lines.find((l) => l.n)?.n || 1;

  let body;
  const lang = langFor(f.path);
  const shown = shownKeys(f);
  const mine = (v.comments || []).filter((c) => c.file === f.path && sameCommit(c.commit, f.commit) && c.status !== 'resolved');
  const outsideComments = mine.filter((c) => !shown.has(keyOf(c.file, c.side, c.line, c.commit)));
  const fileFindings = f.commit ? [] : findingsOf(v).filter((x) => x.file === f.path && x.status === 'open');
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
    ${blameButtonHtml(f, collapsed)}
    ${f.commit ? '' : `<label class="viewed-box ${viewed ? 'on' : ''}"><input type="checkbox" data-act="viewed" data-file="${esc(f.path)}" ${viewed ? 'checked' : ''}> Viewed</label>`}
  </div>`;
  if (kind === 'collapsed') body = '';
  else if (kind === 'binary') body = '<div class="file-note">Binary file</div>';
  else if (kind === 'empty') body = `<div class="file-note">${f.status === 'renamed' ? 'Renamed without changes' : 'No content changes (mode change or empty file)'}</div>`;
  else if (kind === 'large') body = `<div class="file-note">Large diff (${f.lineCount} lines). <button class="link-btn" data-act="force-render" data-file="${esc(f.uid)}">Load it</button></div>`;
  else if (lazyPlaceholder(f, mine.length + fileFindings.length > 0 || [...S.editors.keys()].some((k) => k.startsWith(`new:${f.commit ? `${f.commit}~` : ''}${f.path}|`)))) {
    body = lazyPlaceholderHtml(f);
  } else body = rowsHtml(f, byAnchor);
  const snippet = (line: number | null | undefined, text: string | undefined) => `<div class="outside-line"><span class="outside-no">${line ?? ''}</span><code>${text ? hl(text, lang) : '<span class="muted">(line not available)</span>'}</code></div>`;
  const outsideItems = [
    ...outsideFindings.map((x) => ({ line: x.startLine, html: snippet(x.startLine, x.snippet) + findingHtml(x, true) })),
    ...outsideComments.map((c) => ({ line: c.line, html: snippet(c.line, c.lineText) + threadHtml(c) })),
  ].sort((a, b) => (a.line || 0) - (b.line || 0));
  const out = outsideItems.length && !collapsed
    ? `<div class="outdated"><div class="outdated-label">Not on a changed line, so shown here</div><div class="threads">${outsideItems.map((i) => i.html).join('')}</div></div>` : '';
  return `<section class="file ${collapsed ? 'collapsed' : ''}" id="f-${fnv(f.uid)}">${head}<div class="file-body">${out}${body}</div></section>`;
}

// The table of diff rows for one file. Separate from renderFile so a lazily drawn file (lazy.ts) can fill in later.
export function rowsHtml(f: ViewFile, byAnchor: Map<string, Comment[]>) {
  const v = view();
  const lang = langFor(f.path);
  const rows: string[] = [];
  const fb = fileBlameOf(f);
  const span = fb ? 4 : 3;
  let lastSha: string | null = null;
  for (const h of f.hunks) {
    rows.push(`<tr class="hunk"><td colspan="${span}">${esc(h.header)}</td></tr>`);
    lastSha = null;
    for (const l of h.lines) {
      const side = l.t === 'del' ? 'old' : 'new';
      const line = l.t === 'del' ? l.o : l.n;
      const k = keyOf(f.path, side, line, f.commit);
      const sign = l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' ';
      const cn = !f.commit && l.t === 'add' ? commitOfLine(f.path, l.n) : undefined;
      const cAttr = cn !== undefined ? ` data-c="${cn}"` : '';
      const cBar = cn !== undefined ? cbarHtml(cn) : '';
      let blameCell = '';
      if (fb) {
        const sha = l.t === 'del' ? null : shaAt(fb, l.n);
        blameCell = blameCellHtml(fb, sha, sha !== lastSha);
        lastSha = sha;
      }
      rows.push(`<tr class="line ${l.t}" data-k="${esc(k)}"${cAttr}>${blameCell}<td class="num" data-act="new-comment" data-k="${esc(k)}">${l.o ?? ''}</td><td class="num" data-act="new-comment" data-k="${esc(k)}">${l.n ?? ''}</td><td class="code">${cBar}<button class="add-c" data-act="new-comment" data-k="${esc(k)}" title="Comment on this line">+</button><span class="sign">${sign}</span>${hl(l.text, lang)}</td></tr>`);
      const crHere: Finding[] = side === 'new' ? (v.crByAnchor?.get(k) || []) : [];
      const threads = (byAnchor.get(k) || []);
      const ek = `new:${k}`;
      if (threads.length || crHere.length || S.editors.has(ek)) {
        rows.push(`<tr class="thread-row"><td colspan="${span}"><div class="threads">${crHere.map((f) => findingHtml(f, true)).join('')}${threads.map(threadHtml).join('')}${S.editors.has(ek) ? editorHtml(ek, 'Add comment') : ''}</div></td></tr>`);
      }
    }
  }
  return `<table class="diff${fb ? ' blamed' : ''}"><colgroup>${fb ? '<col class="blame">' : ''}<col class="num"><col class="num"><col></colgroup>${rows.join('')}</table>`;
}

/** The commit bar on an added line (blame), shared by the full render and the in-place blame patch. */
export function cbarHtml(cn: number) {
  return `<span class="cbar ${commitClass(cn)}" title="${esc(cn ? `#${cn} ${commitByN(cn)?.sha.slice(0, 8)} ${commitByN(cn)?.subject || ''}` : 'Not committed yet')}"></span>`;
}

// ---------- Blame column ----------
// Full-history blame of a file as it is in the worktree, switched on per file from its header. Branch commits
// keep their colour and number; lines from before the branch are muted; removed lines have no blame.

const UNCOMMITTED = '0'.repeat(40);

export const blameKey = (f: ViewFile) => `${view().diff.fingerprint}:${f.path}`;

/** The loaded blame for a file showing its Blame column, if any. */
function fileBlameOf(f: ViewFile): FileBlame | undefined {
  if (f.commit || !S.blameOn.has(f.uid)) return undefined;
  return S.fileBlame.get(blameKey(f));
}

function blameButtonHtml(f: ViewFile, collapsed: boolean) {
  if (f.commit || collapsed || f.status === 'deleted' || f.binary) return '';
  const on = S.blameOn.has(f.uid);
  return `<button class="file-tag blame-btn ${on ? 'on' : ''}" data-act="blame-file" data-file="${esc(f.uid)}" aria-pressed="${on}" title="${on ? 'Hide' : 'Show'} who last changed each line">Blame</button>`;
}

function shaAt(fb: FileBlame, line: number | undefined): string | null {
  if (line === undefined) return null;
  let lo = 0, hi = fb.runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = fb.runs[mid];
    if (!r) break;
    if (line < r[0]) hi = mid - 1; else if (line > r[1]) lo = mid + 1; else return r[2];
  }
  return null;
}

function blameCellHtml(fb: FileBlame, sha: string | null, first: boolean) {
  const c = sha ? fb.commits[sha] : undefined;
  if (!c) return '<td class="blame"></td>';
  const cls = c.n === null ? 'old' : commitClass(c.n);
  const uncommitted = c.sha === UNCOMMITTED;
  const title = uncommitted ? 'Not committed yet' : `${c.summary}\n${c.author}, ${new Date(c.time).toLocaleString()}\n${c.sha}`;
  const act = c.n ? ` data-act="hl-commit" data-n="${c.n}"` : '';
  const label = !first ? '' : uncommitted ? '<span class="b-who">Not committed yet</span>'
    : `${c.n ? `<span class="b-num">#${c.n}</span>` : ''}<span class="b-sha">${c.sha.slice(0, 7)}</span><span class="b-who">${esc(c.author)}</span><span class="b-when">${ago(c.time)}</span>`;
  return `<td class="blame ${cls}${first ? ' start' : ''}" title="${esc(title)}"${act}>${label}</td>`;
}
