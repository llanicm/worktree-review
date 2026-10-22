// ---------- CodeRabbit ----------
import type { CodeRabbitResponse, Finding, Worktree } from '../shared/api.ts';
import { keyOf } from './diff.ts';
import { api, st, S, view } from './state.ts';
import { ago, elapsed, esc, md } from './util.ts';

const SEV_ORDER = ['critical', 'major', 'minor', 'trivial', 'info', 'none'];

export function crButtonHtml(wt: Worktree) {
  if (!st().coderabbitReady) return '<a class="btn" href="#/settings" title="Connect CodeRabbit in Settings">Set up CodeRabbit</a>';
  if (wt.coderabbit?.status === 'running') {
    return `<span class="cr-running"><span class="dot busy"></span>CodeRabbit reviewing <span class="cr-elapsed" data-start="${wt.coderabbit.startedAt}">${elapsed(wt.coderabbit.startedAt)}</span></span>
      <button class="btn small" data-act="cr-cancel">Cancel</button>`;
  }
  return `<button class="btn cr-btn" data-act="cr-run" title="Ask CodeRabbit to review these changes (uses one of your hourly CodeRabbit reviews)">Run CodeRabbit</button>`;
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
  return `<div class="thread cr-finding ${f.status}">
    <div class="msg"><div class="msg-head"><strong class="cr-name">CodeRabbit</strong><span class="sev ${esc(f.severity)}">${esc(f.severity)}</span>
      ${!inline && loc ? `<a href="#" class="mono" data-act="cr-jump" data-file="${esc(f.file)}" data-line="${f.endLine || f.startLine || ''}">${esc(loc)}</a>` : ''}</div>
      ${f.title ? `<div class="cr-title">${md(f.title)}</div>` : ''}
      ${f.status === 'open' || !inline ? detail : ''}</div>
    <div class="thread-actions">${acts}</div></div>`;
}

export function crPanelHtml(wt: Worktree) {
  const r = S.view?.cr;
  if (!r) return '';
  const findings = [...r.findings].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  const open = findings.filter((f) => f.status === 'open');
  const stale = r.status !== 'running' && r.fingerprint && r.fingerprint !== wt.fingerprint;
  let head, body = '';
  if (r.status === 'running') {
    head = `CodeRabbit is reviewing against <code>${esc(r.baseRef)}</code>`;
    body = `<p class="muted">Reviews usually take 2–6 minutes and can take 15 or more. You can leave this page; findings appear here and inline as they arrive.</p>`;
  } else if (r.status === 'done') {
    head = `CodeRabbit · ${findings.length ? `${open.length} open of ${findings.length} finding${findings.length === 1 ? '' : 's'}` : 'no findings'}`;
    if (!findings.length) body = `<p class="muted">Reviewed ${r.reviewedFiles.length} file${r.reviewedFiles.length === 1 ? '' : 's'} and found nothing to flag.</p>`;
  } else {
    head = `CodeRabbit review ${r.status === 'cancelled' ? 'cancelled' : 'failed'}`;
    body = `<p class="error">${esc(r.error || 'Something went wrong.')}</p>`;
  }
  const meta = `<span class="muted small">${r.status === 'running' ? `started ${ago(r.startedAt)}` : `${ago(r.finishedAt || r.startedAt)}`}${r.usage ? ` · ${r.usage.remaining} of ${r.usage.limit} reviews left this hour` : ''}</span>`;
  return `<div class="panel cr-panel">
    <div class="panel-head"><span>${head}</span><span class="actions">${meta}${open.length > 1 ? '<button class="btn small" data-act="cr-send-all">Send all to Claude</button>' : ''}</span></div>
    <div class="panel-body">
      ${stale ? '<div class="callout warn small">The code has changed since this review. Line numbers may be off; run CodeRabbit again for a fresh look.</div>' : ''}
      ${body}
      <div class="threads cr-list">${findings.map((f) => findingHtml(f)).join('')}</div>
    </div></div>`;
}

export function indexFindings() {
  const v = view();
  const byAnchor = new Map<string, Finding[]>();
  v.crByAnchor = byAnchor;
  for (const f of v.cr?.findings || []) {
    if (f.status !== 'open' || !f.file) continue;
    const k = keyOf(f.file, 'new', f.endLine || f.startLine);
    const here = byAnchor.get(k);
    if (here) here.push(f); else byAnchor.set(k, [f]);
  }
}

export async function loadCodeRabbit() {
  if (!S.view) return;
  try {
    const { review } = await api<CodeRabbitResponse>('GET', `/api/worktrees/${S.view.wtId}/coderabbit`);
    S.view.cr = review;
    indexFindings();
  } catch {}
}
