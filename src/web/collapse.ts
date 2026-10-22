// ---------- instant collapse / expand ----------
// Collapsing a file or commit only changes its own element, so these patch just that element in place instead of
// rebuilding the whole diff. They use the same HTML builders as renderMain (renderFile, groupHtml,
// commitBodyHtml, ...), so the DOM is exactly what a full render of the new state would produce. Anything
// unexpected (page not rendered for this view, element missing) falls back to renderMain().
import type { Comment } from '../shared/api.ts';
import { renderFile, isCollapsed } from './file.ts';
import { curWt, need, S } from './state.ts';
import type { CommitGroup, View, ViewFile } from './types.ts';
import { fnv } from './util.ts';
import { collapseAllHtml, commentsByAnchor, commitBodyHtml, groupHtml, orphanHtml, renderMain, unplacedComments } from './view.ts';

type ByAnchor = Map<string, Comment[]>;

/** Replaces an element with freshly built markup, in the same place. */
function replaceWith(el: Element, html: string) { el.outerHTML = html; }

/** The "Comments on files not in this view" panel can change when a file or commit opens or closes: its comments are listed there while the file's rows aren't rendered. */
function syncOrphan(page: Element, v: View): boolean {
  const html = orphanHtml(unplacedComments(v).orphan);
  if (html === v.orphanHtml) return true;
  v.orphanHtml = html;
  const cur = page.querySelector(':scope > div.panel:not(.cr-panel)');
  if (cur) {
    if (html) { replaceWith(cur, html); return true; }
    // Removing it leaves two whitespace nodes side by side; the parser would have produced one.
    const a = cur.previousSibling, b = cur.nextSibling;
    cur.remove();
    if (a instanceof Text && b instanceof Text) { a.data += b.data; b.remove(); }
    return true;
  }
  if (!html) return true;
  // Absent -> present. renderMain's template separates its five slots (CodeRabbit panel, "cut off" callout, this panel,
  // the other-view panel, the files) with "\n    "; empty slots merge their whitespace into one text node. Split it where this slot sits.
  const toolbar = page.querySelector(':scope > .toolbar');
  if (!toolbar) return false;
  let prev: Element = toolbar, slot = -1;
  let next = prev.nextElementSibling;
  if (next?.matches('.cr-panel')) { prev = next; slot = 0; next = next.nextElementSibling; }
  if (next?.matches('div.callout.warn')) { prev = next; slot = 1; }
  const ws = prev.nextSibling;
  const SEP = '\n    '.length;
  // Slots are numbered 0-4 (CodeRabbit panel, "cut off" callout, this panel, other-view panel, files); the whitespace run
  // between the previous and next present slot holds one separator per slot in between.
  const nextSlot = prev.nextElementSibling?.matches('details.panel:not(.commits-panel):not(.files-summary)') ? 3 : 4;
  if (!(ws instanceof Text) || ws.length < (nextSlot - slot) * SEP) return false;
  const tail = ws.splitText((2 - slot) * SEP);
  const t = document.createElement('template');
  t.innerHTML = html;
  const el = t.content.firstElementChild;
  if (!el) return false;
  page.insertBefore(el, tail);
  return true;
}

function syncCollapseAll(page: Element, v: View): boolean {
  const btn = page.querySelector(':scope > .toolbar [data-act="collapse-all"], :scope > .toolbar [data-act="expand-all"]');
  if (!btn) return false;
  const html = collapseAllHtml(v);
  if (!html.includes(`data-act="${btn.getAttribute('data-act')}"`)) replaceWith(btn, html);
  return true;
}

/** Runs a patch against the rendered diff of the current worktree; falls back to a full render if that isn't what's on screen. */
function patch(fn: (page: Element, v: View, byAnchor: ByAnchor) => boolean) {
  const v = S.view;
  const page = need('#main').querySelector(':scope > .page');
  const ok = !!v && !S.page && v.wtId === curWt()?.id && !!page?.querySelector(':scope > .toolbar')
    && fn(page, v, commentsByAnchor(v.comments)) && syncOrphan(page, v) && syncCollapseAll(page, v);
  if (!ok) renderMain();
}

const fileEl = (f: ViewFile) => document.getElementById(`f-${fnv(f.uid)}`);
const groupEl = (n: number) => document.getElementById(`cg-${n}`);

function patchFiles(files: ViewFile[], byAnchor: ByAnchor) {
  for (const f of files) {
    const el = fileEl(f);
    if (!el) return false;
    replaceWith(el, renderFile(f, byAnchor));
  }
  return true;
}

function patchGroups(groups: CommitGroup[], byAnchor: ByAnchor) {
  for (const g of groups) {
    const el = groupEl(g.n);
    if (!el) return false;
    replaceWith(el, groupHtml(g, byAnchor));
  }
  return true;
}

export function toggleFile(f: ViewFile) {
  S.toggled.set(f.uid, !isCollapsed(f));
  patch((_page, _v, byAnchor) => patchFiles([f], byAnchor));
}

export function toggleCommit(n: number) {
  if (S.shutCommits.has(n)) S.shutCommits.delete(n); else S.shutCommits.add(n);
  patch((_page, v, byAnchor) => patchGroups((v.groups ?? []).filter((g) => g.n === n), byAnchor));
}

export function toggleBody(n: number) {
  if (S.openBodies.has(n)) S.openBodies.delete(n); else S.openBodies.add(n);
  patch((_page, v) => {
    const g = v.groups?.find((x) => x.n === n);
    const el = groupEl(n)?.querySelector(':scope > .commit-body');
    if (!g?.body || !el) return false;
    replaceWith(el, commitBodyHtml(g.body, n));
    return true;
  });
}

export function collapseAll(v: View) {
  if (v.diff.mode === 'commits') {
    const groups = (v.groups ?? []).filter((g) => !S.shutCommits.has(g.n));
    for (const g of groups) S.shutCommits.add(g.n);
    patch((_page, _v, byAnchor) => patchGroups(groups, byAnchor));
  } else {
    const files = v.files.filter((f) => !isCollapsed(f));
    for (const f of v.files) S.toggled.set(f.uid, true);
    patch((_page, _v, byAnchor) => patchFiles(files, byAnchor));
  }
}

export function expandAll(v: View) {
  const groups = (v.groups ?? []).filter((g) => S.shutCommits.has(g.n));
  S.shutCommits.clear();
  patch((_page, _v, byAnchor) => patchGroups(groups, byAnchor));
}
