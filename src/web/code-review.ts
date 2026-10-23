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
  return `<span class="cr-running ${k}"><span class="dot busy"></span>${NAMES[k]} reviewing <span class="cr-elapsed" data-start="${r.startedAt}">${elapsed(r.startedAt)}</span></span>
    <button class="btn small" data-act="review-cancel" data-reviewer="${k}">Cancel</button>`;
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
  return `<div class="thread cr-finding ${f.source} ${f.status}">
    <div class="msg"><div class="msg-head"><strong class="cr-name">${NAMES[f.source]}</strong><span class="sev ${esc(f.severity)}">${esc(f.severity)}</span>
      ${!inline && loc ? `<a href="#" class="mono" data-act="cr-jump" data-file="${esc(f.file)}" data-line="${f.endLine || f.startLine || ''}">${esc(loc)}</a>` : ''}</div>
      ${f.title ? `<div class="cr-title">${md(f.title)}</div>` : ''}
      ${f.status === 'open' || !inline ? detail : ''}</div>
    <div class="thread-actions">${acts}</div></div>`;
}

function panelHtml(wt: Worktree, r: CodeReview) {
  const name = NAMES[r.reviewer];
  const findings = [...r.findings].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  const open = findings.filter((f) => f.status === 'open');
  const stale = r.status !== 'running' && r.fingerprint && r.fingerprint !== wt.fingerprint;
  let head, body = '';
  if (r.status === 'running') {
    head = `${name} is reviewing against <code>${esc(r.baseRef)}</code>`;
    body = r.reviewer === 'coderabbit'
      ? `<p class="muted">Reviews usually take 2–6 minutes and can take 15 or more. You can leave this page; findings appear here and inline as they arrive.</p>`
      : `<p class="muted">${r.message ? `${esc(r.message)}…` : 'Starting…'}</p><p class="muted">Findings appear here and inline when it's done. You can leave this page.</p>`;
  } else if (r.status === 'done') {
    head = `${name} · ${findings.length ? `${open.length} open of ${findings.length} finding${findings.length === 1 ? '' : 's'}` : 'no findings'}`;
    if (!findings.length) body = `<p class="muted">${r.reviewedFiles.length ? `Reviewed ${r.reviewedFiles.length} file${r.reviewedFiles.length === 1 ? '' : 's'} and found` : 'Found'} nothing to flag.</p>`;
  } else {
    head = `${name} review ${r.status === 'cancelled' ? 'cancelled' : 'failed'}`;
    body = `<p class="error">${esc(r.error || 'Something went wrong.')}</p>`;
  }
  const facts = [r.status === 'running' ? `started ${ago(r.startedAt)}` : ago(r.finishedAt || r.startedAt)];
  if (r.usage) facts.push(`${r.usage.remaining} of ${r.usage.limit} reviews left this hour`);
  if (r.effort) facts.push(`${r.effort} effort`);
  if (r.costUsd) facts.push(`<span title="As Claude Code reports it. On a Claude plan this counts toward your usage rather than being billed.">$${r.costUsd.toFixed(2)}</span>`);
  return `<div class="panel cr-panel ${r.reviewer}">
    <div class="panel-head"><span>${head}</span><span class="actions"><span class="muted small">${facts.join(' · ')}</span>${open.length > 1 ? `<button class="btn small" data-act="cr-send-all" data-reviewer="${r.reviewer}">Send all to Claude</button>` : ''}</span></div>
    <div class="panel-body">
      ${stale ? `<div class="callout warn small">The code has changed since this review. Line numbers may be off; run ${name} again for a fresh look.</div>` : ''}
      ${body}
      <div class="threads cr-list">${findings.map((f) => findingHtml(f)).join('')}</div>
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
