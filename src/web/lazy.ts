// ---------- drawing only what's on screen ----------
// A big diff is tens of thousands of rows, and building, highlighting and laying them all out is what made
// opening a worktree slow. A full render draws the files near the screen (and the first few hundred lines,
// for a first visit) and gives the rest an empty placeholder of about the right height. Placeholders are
// filled as they scroll near, and the rest in small slices while the page is idle, so it never blocks.
// The browser's scroll anchoring keeps the view steady when a placeholder above the viewport changes height.
import type { Comment } from '../shared/api.ts';
import { rowsHtml } from './file.ts';
import { S } from './state.ts';
import type { ViewFile } from './types.ts';
import { esc, fnv } from './util.ts';

const FIRST_LINES = 600;    // drawn straight away on a first visit
const NEAR_PX = 1500;       // drawn straight away if this close to the viewport
const ROW_PX = 20, HUNK_PX = 28, CHAR_PX = 7.2;

/** Set only while renderMain builds the page; outside it (in-place patches) every file is drawn. */
let render: { budget: number; near: Set<string>; cols: number } | null = null;
let byAnchor: Map<string, Comment[]> = new Map();

/** Before a full render: note which files are on screen now, so they're drawn again rather than flashing as placeholders. */
export function beginRender(main: HTMLElement, anchors: Map<string, Comment[]>) {
  byAnchor = anchors;
  const near = new Set<string>();
  const box = main.getBoundingClientRect();
  for (const el of main.querySelectorAll<HTMLElement>('section.file')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > box.top - NEAR_PX && r.top < box.bottom + NEAR_PX) near.add(el.id);
  }
  // Characters per row in the code column, for estimating wrapped lines.
  const cols = Math.max(40, Math.floor((box.width - 48 - 2 * 52 - 22) / CHAR_PX));
  render = { budget: near.size ? 0 : FIRST_LINES, near, cols };
}

export function endRender(main: HTMLElement) {
  render = null;
  watch(main);
}

/** Whether renderFile should leave this file's rows for later. Files with comments or an open editor are always drawn. */
export function lazyPlaceholder(f: ViewFile, hasThreads: boolean): boolean {
  if (!render || hasThreads || render.near.has(`f-${fnv(f.uid)}`)) return false;
  if (render.budget > 0) { render.budget -= f.lineCount; return false; }
  return true;
}

export function lazyPlaceholderHtml(f: ViewFile) {
  const cols = render?.cols ?? 120;
  let h = 0;
  for (const hunk of f.hunks) {
    h += HUNK_PX;
    for (const l of hunk.lines) h += ROW_PX * Math.max(1, Math.ceil(l.text.length / cols));
  }
  return `<div class="lazy-rows" data-lazy="${esc(f.uid)}" style="height:${h}px"></div>`;
}

// ---------- filling placeholders ----------

let io: IntersectionObserver | null = null;
let idleTimer: number | null = null;

function fileByUid(uid: string): ViewFile | undefined {
  const v = S.view;
  if (!v) return undefined;
  return v.files.find((f) => f.uid === uid) ?? v.groups?.flatMap((g) => g.files).find((f) => f.uid === uid);
}

function fill(el: Element) {
  const uid = el.getAttribute('data-lazy');
  const f = uid === null ? undefined : fileByUid(uid);
  io?.unobserve(el);
  if (!f || !el.isConnected) return;
  el.outerHTML = rowsHtml(f, byAnchor);
}

function watch(main: HTMLElement) {
  io?.disconnect();
  if (idleTimer !== null) clearTimeout(idleTimer);
  const pending = main.querySelectorAll('[data-lazy]');
  if (!pending.length) return;
  io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) fill(e.target);
  }, { root: main, rootMargin: `${NEAR_PX}px 0px` });
  for (const el of pending) io.observe(el);
  // Everything else in small slices once things are quiet, so find-in-page works and scrolling never shows a gap.
  const slice = () => {
    const end = performance.now() + 8;
    let el = main.querySelector('[data-lazy]');
    while (el && performance.now() < end) { fill(el); el = main.querySelector('[data-lazy]'); }
    idleTimer = el ? window.setTimeout(slice, 30) : null;
  };
  idleTimer = window.setTimeout(slice, 600);
}

/** Draws a file's rows now if they're still a placeholder (e.g. before jumping to a line in it). */
export function fillFile(uid: string) {
  const el = document.querySelector(`[data-lazy="${CSS.escape(uid)}"]`);
  if (el) fill(el);
}
