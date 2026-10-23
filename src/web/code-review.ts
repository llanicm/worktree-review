// ---------- code reviews (CodeRabbit or Claude) ----------
import type { CodeReview, CodeReviewsResponse, Finding, ReviewEffort, Reviewer, Worktree } from '../shared/api.ts';
import { keyOf } from './diff.ts';
import { api, st, S, view } from './state.ts';
import type { View } from './types.ts';
import { ago, elapsed, esc, md } from './util.ts';

const SEV_ORDER = ['critical', 'major', 'minor', 'trivial', 'info', 'none'];
export const REVIEWERS: Reviewer[] = ['coderabbit', 'claude'];
export const NAMES: Record<Reviewer, string> = { coderabbit: 'CodeRabbit', claude: 'Claude' };
const EFFORTS: [ReviewEffort, string][] = [['low', 'Low (quickest)'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max (most thorough)']];

const ready = (k: Reviewer) => (k === 'coderabbit' ? st().coderabbitReady : st().claudeReady);

/** Changes whenever any reviewer's review or findings change. */
export const reviewsSig = (wt: Worktree) => REVIEWERS.map((k) => wt.codeReviews[k]?.sig || '').join();

export const findingsOf = (v: View): Finding[] => REVIEWERS.flatMap((k) => v.codeReviews?.[k]?.findings || []);

/** The reviewer and effort picked in the "Run code review" menu, kept across re-renders while it's open. */
export function reviewPick(wt: Worktree): { reviewer: Reviewer; effort: ReviewEffort } {
  const idle = REVIEWERS.filter((k) => ready(k) && wt.codeReviews[k]?.status !== 'running');
  const p = S.reviewPick;
  const reviewer = p && idle.includes(p.reviewer) ? p.reviewer : idle[0] ?? 'claude';
  return { reviewer, effort: p?.effort || st().config.reviewEffort };
}

function runningHtml(wt: Worktree, k: Reviewer) {
  const r = wt.codeReviews[k];
  if (r?.status !== 'running') return '';
  // The panel below has the details and Cancel; this stays in view as the page scrolls.
  return `<a href="#" class="cr-running ${k}" data-act="cr-panel" data-reviewer="${k}" title="${NAMES[k]} is reviewing. Show the review"><span class="dot busy"></span>${NAMES[k]}
    <span class="cr-elapsed" data-start="${r.startedAt}">${elapsed(r.startedAt)}</span></a>`;
}

function menuHtml(wt: Worktree, idle: Reviewer[]) {
  const pick = reviewPick(wt);
  const choice = (k: Reviewer, note: string) => `<label class="choice"><input type="radio" name="reviewer" data-review="reviewer" value="${k}" ${pick.reviewer === k ? 'checked' : ''}>
    <span><strong>${NAMES[k]}</strong><br><span class="muted small">${note}</span></span></label>`;
  return `<div class="review-menu" role="dialog" aria-label="Run code review">
    ${idle.length > 1 ? `<div class="review-menu-title">Who should review?</div>
      ${choice('coderabbit', 'The CodeRabbit CLI. Uses one of your hourly CodeRabbit reviews.')}
      ${choice('claude', "Claude Code's built-in /code-review, run on this machine.")}` : ''}
    ${pick.reviewer === 'claude' ? `<label class="setting row"><span>Effort</span>
      <select data-review="effort">${EFFORTS.map(([v, l]) => `<option value="${v}" ${pick.effort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <p class="muted small">Higher effort looks harder, takes longer and uses more of your Claude usage. The default is in Settings.</p>` : ''}
    <div class="actions"><button class="btn small" data-act="review-menu">Cancel</button><button class="btn small primary" data-act="review-start">Start review</button></div>
  </div>`;
}

export function reviewButtonHtml(wt: Worktree) {
  const running = REVIEWERS.map((k) => runningHtml(wt, k)).join('');
  if (!REVIEWERS.some(ready)) return '<a class="btn" href="#/settings" title="Connect CodeRabbit or Claude in Settings">Set up code review</a>';
  const idle = REVIEWERS.filter((k) => ready(k) && wt.codeReviews[k]?.status !== 'running');
  if (!idle.length) return running;
  // CodeRabbit alone has nothing to choose, so it starts straight away.
  const button = idle.length === 1 && idle[0] === 'coderabbit'
    ? '<button class="btn" data-act="review-start" title="Ask CodeRabbit to review these changes (uses one of your hourly CodeRabbit reviews)">Run code review</button>'
    : `<button class="btn" data-act="review-menu" aria-expanded="${S.reviewMenu === wt.id}">Run code review</button>`;
  return `${running}<span class="review-run">${button}${S.reviewMenu === wt.id ? menuHtml(wt, idle) : ''}</span>`;
}

export function findingHtml(f: Finding, inline = false) {
  const loc = f.file ? `${f.file}${f.startLine ? `:${f.startLine}${f.endLine && f.endLine !== f.startLine ? `–${f.endLine}` : ''}` : ''}` : '';
  const acts = f.status === 'open'
    ? `<button class="btn small primary" data-act="cr-send" data-id="${f.id}">Send to Claude</button><button class="btn small" data-act="cr-dismiss" data-id="${f.id}">Dismiss</button>`
    : f.status === 'sent' ? '<span class="muted small">Added to your review as a draft</span>'
    : `<span class="muted small">Dismissed</span><button class="link-btn" data-act="cr-restore" data-id="${f.id}">undo</button>`;
  const detail = [f.comment && f.comment !== f.title ? `<div class="msg-body">${md(f.comment)}</div>` : '',
    f.suggestions ? `<details><summary>Suggested change</summary><pre class="suggestion">${esc(f.suggestions)}</pre></details>` : '',
    f.codegen && f.codegen !== f.comment ? `<details><summary>Fix guidance for agents</summary><div class="msg-body">${md(f.codegen)}</div></details>` : ''].join('');
  return `<div class="thread cr-finding ${f.source} ${f.status}"${inline ? ` id="fd-${esc(f.id)}"` : ''}>
    <div class="msg"><div class="msg-head"><strong class="cr-name">${NAMES[f.source]}</strong><span class="sev ${esc(f.severity)}">${esc(f.severity)}</span>
      ${!inline && loc ? `<a href="#" class="mono" data-act="cr-jump" data-file="${esc(f.file)}" data-line="${f.endLine || f.startLine || ''}">${esc(loc)}</a>` : ''}</div>
      ${f.title ? `<div class="cr-title">${md(f.title)}</div>` : ''}
      ${f.status === 'open' || !inline ? detail : ''}</div>
    <div class="thread-actions">${acts}</div></div>`;
}

const loc = (f: Finding) => (f.startLine ? `${f.startLine}${f.endLine && f.endLine !== f.startLine ? `–${f.endLine}` : ''}` : '');
const jump = (f: Finding) => `data-act="cr-jump" data-file="${esc(f.file)}" data-line="${f.endLine || f.startLine || ''}" data-id="${esc(f.id)}"`;

/** Whether the diff on screen has the finding's file, so the finding shows there in place. */
const inDiff = (f: Finding) => !!f.file && !!S.view?.files.some((x) => x.path === f.file && !x.commit);

/** The open findings that show in the diff, as links to them: one group per file, in the diff's order. */
function indexHtml(open: Finding[]) {
  const order = new Map((S.view?.files || []).map((x, i) => [x.path, i]));
  const byFile = new Map<string, Finding[]>();
  for (const f of [...open].sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0) || (a.startLine || 0) - (b.startLine || 0))) {
    const here = byFile.get(f.file);
    if (here) here.push(f); else byFile.set(f.file, [f]);
  }
  return `<ul class="cr-index">${[...byFile].map(([file, fs]) => `<li>
    <a href="#" class="cr-file mono" ${jump(fs[0] as Finding)} title="${esc(file)}">${esc(file)}</a>
    <ul>${fs.map((f) => `<li><a href="#" class="cr-item" ${jump(f)}>
      <span class="sev ${esc(f.severity)}">${esc(f.severity)}</span><span class="cr-line mono">${loc(f) ? `L${loc(f)}` : ''}</span><span class="cr-item-title">${md(f.title || f.comment.split('\n')[0] || 'Finding')}</span></a></li>`).join('')}</ul>
  </li>`).join('')}</ul>`;
}

/** Findings already sent or dismissed: one line each, so they stay out of the way. */
function doneHtml(done: Finding[]) {
  if (!done.length) return '';
  return `<details class="cr-done"><summary>${done.length} sent or dismissed</summary><ul>${done.map((f) => `<li>
    <span class="muted small">${f.status === 'sent' ? 'Sent' : 'Dismissed'}</span>
    <span class="mono small">${esc(f.file)}${loc(f) ? `:${loc(f)}` : ''}</span> <span class="cr-item-title">${md(f.title || 'Finding')}</span>
    ${f.status === 'dismissed' ? `<button class="link-btn" data-act="cr-restore" data-id="${esc(f.id)}">undo</button>` : ''}</li>`).join('')}</ul></details>`;
}

/** Shown while a reviewer works: a page of code with a beam sweeping down it. */
const SWEEP_S = 2.4;
const lastCount = new Map<string, number>(); // reviewer -> findings counted when last drawn, to pop the badge only when it grows
// The panel is redrawn as the review reports progress. Starting each animation part-way through, by how long the
// review has been running, keeps the redrawn beam where it was rather than jumping back to the top.
const phase = (r: CodeReview) => -(((Date.now() - r.startedAt) / 1000) % SWEEP_S);
function scanHtml(r: CodeReview) {
  const widths = [62, 84, 48, 70, 36, 78, 54, 66], indents = [0, 8, 8, 16, 16, 8, 0, 8];
  const ph = phase(r);
  const n = r.findings.length;
  const grew = n > (lastCount.get(r.reviewer) ?? 0);
  lastCount.set(r.reviewer, n);
  return `<div class="cr-scan" aria-hidden="true"><div class="cr-scan-page">
    ${widths.map((w, i) => `<i style="width:${w}%;margin-left:${indents[i]}%;animation-delay:${(ph + (i / widths.length) * SWEEP_S).toFixed(2)}s"></i>`).join('')}
    <b class="cr-beam" style="animation-delay:${ph.toFixed(2)}s"></b></div>${n ? `<span class="cr-found${grew ? ' grew' : ''}">${n}</span>` : ''}</div>`;
}

function panelHtml(wt: Worktree, r: CodeReview) {
  const name = NAMES[r.reviewer];
  const findings = [...r.findings].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  const open = findings.filter((f) => f.status === 'open');
  const stale = wt.codeReviews[r.reviewer]?.stale;
  let head, body = '';
  if (r.status === 'running') {
    head = `${name} is reviewing against <code>${esc(r.baseRef)}</code>`;
    const so = findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'} so far, shown in the code` : 'Findings show in the code as they arrive';
    const note = `${so}.${r.reviewer === 'coderabbit' ? ' Reviews usually take 2–6 minutes and can take 15 or more.' : ''}`;
    body = `<div class="cr-working">${scanHtml(r)}<div class="cr-status"><div class="cr-activity" title="${esc(r.message || '')}">${esc(r.message || 'Working')}…</div><div class="muted small">${note}</div></div></div>`;
  } else if (r.status === 'done') {
    head = `${name} · ${findings.length ? `${open.length} open of ${findings.length} finding${findings.length === 1 ? '' : 's'}` : 'no findings'}`;
    if (!findings.length) body = `<p class="muted">${r.reviewedFiles.length ? `Reviewed ${r.reviewedFiles.length} file${r.reviewedFiles.length === 1 ? '' : 's'} and found` : 'Found'} nothing to flag.</p>`;
  } else {
    head = `${name} review ${r.status === 'cancelled' ? 'cancelled' : 'failed'}`;
    body = `<p class="error">${esc(r.error || 'Something went wrong.')}</p>`;
  }
  const facts = [r.status === 'running' ? `<span class="cr-elapsed" data-start="${r.startedAt}" title="How long it has been running">${elapsed(r.startedAt)}</span>` : ago(r.finishedAt || r.startedAt)];
  if (r.usage) facts.push(`${r.usage.remaining} of ${r.usage.limit} reviews left this hour`);
  if (r.effort) facts.push(`${r.effort} effort`);
  if (r.costUsd) facts.push(`<span title="As Claude Code reports it. On a Claude plan this counts toward your usage rather than being billed.">$${r.costUsd.toFixed(2)}</span>`);
  const shown = open.filter(inDiff), loose = open.filter((f) => !inDiff(f));
  const byCommit = S.view?.diff.mode === 'commits';
  if (r.status !== 'running') lastCount.delete(r.reviewer);
  return `<div class="panel cr-panel ${r.reviewer} ${r.status}" id="cr-panel-${r.reviewer}"${r.status === 'running' ? ` style="--ph:${phase(r).toFixed(2)}s"` : ''}>
    <div class="panel-head"><span>${head}</span><span class="actions"><span class="muted small">${facts.join(' · ')}</span>${r.status === 'running' ? `<button class="btn small" data-act="review-cancel" data-reviewer="${r.reviewer}">Cancel</button>` : ''}${open.length > 1 ? `<button class="btn small" data-act="cr-send-all" data-reviewer="${r.reviewer}">Send all to Claude</button>` : ''}</span></div>
    <div class="panel-body">
      ${stale ? `<div class="callout warn small">The code has changed since this review. Line numbers may be off; run ${name} again for a fresh look.</div>` : ''}
      ${body}
      ${shown.length ? indexHtml(shown) : ''}
      ${loose.length ? `<div class="cr-loose"><div class="muted small">${byCommit ? 'Switch to All changes to see these in the code.' : 'Not in this diff, so shown here:'}</div>
        <div class="threads cr-list">${loose.map((f) => findingHtml(f)).join('')}</div></div>` : ''}
      ${doneHtml(findings.filter((f) => f.status !== 'open'))}
    </div></div>`;
}

/** Each reviewer's latest review, in one element so the page's other panels keep their places. */
export function reviewPanelsHtml(wt: Worktree) {
  const panels = REVIEWERS.map((k) => S.view?.codeReviews?.[k]).filter((r) => !!r).map((r) => panelHtml(wt, r));
  return panels.length ? `<div class="cr-panels">${panels.join('')}</div>` : '';
}

export function indexFindings() {
  const v = view();
  const byAnchor = new Map<string, Finding[]>();
  v.crByAnchor = byAnchor;
  for (const f of findingsOf(v)) {
    if (f.status !== 'open' || !f.file) continue;
    const k = keyOf(f.file, 'new', f.endLine || f.startLine);
    const here = byAnchor.get(k);
    if (here) here.push(f); else byAnchor.set(k, [f]);
  }
}

export async function loadCodeReviews() {
  if (!S.view) return;
  try {
    const { reviews } = await api<CodeReviewsResponse>('GET', `/api/worktrees/${S.view.wtId}/code-reviews`);
    S.view.codeReviews = reviews;
    indexFindings();
  } catch {}
}
