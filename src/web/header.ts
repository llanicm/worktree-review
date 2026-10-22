// ---------- worktree header & clean-up callouts ----------
import type { Worktree } from '../shared/api.ts';
import { prChip, sessionChip } from './sidebar.ts';
import { S, st } from './state.ts';
import { ago, editorLink, editorName, esc, tilde } from './util.ts';

const STATUS: Record<string, string> = { ' M': 'modified', 'M ': 'staged', MM: 'staged + modified', 'A ': 'new, staged', AM: 'new, staged', ' D': 'missing', 'D ': 'deleted, staged', '??': 'untracked', 'R ': 'renamed' };

export function headerHtml(wt: Worktree) {
  const name = wt.branch || `detached @ ${wt.head?.slice(0, 10)}`;
  const pr = wt.pr ? ` <a class="pr-no" href="${esc(wt.pr.url)}" target="_blank">#${wt.pr.number}</a>` : '';
  const cs = wt.cleanup;
  let cleanup = '';
  const err = wt.error
    ? `<div class="callout danger"><strong>${wt.error.kind === 'broken-link' ? 'Git can\'t read this worktree' : 'Git reported a problem with this worktree'}</strong>
        <p>${esc(wt.error.message)}</p>
        ${wt.error.detail && wt.error.detail !== wt.error.message ? `<details><summary>Git's message</summary><code class="cmd">${esc(wt.error.detail)}</code></details>` : ''}
        ${wt.error.kind === 'broken-link' ? '<div class="actions" style="margin-top:8px"><button class="btn primary" data-act="repair">Repair links</button></div>' : ''}</div>`
    : '';
  const removeErr = S.removeErrors[wt.id] ? `<div class="callout danger"><strong>Couldn't remove this worktree.</strong><p>${esc(S.removeErrors[wt.id])}</p></div>` : '';
  if (cs?.kind === 'idle' && !wt.sessions.length && (cs.eligible || cs.forceable)) {
    cleanup = `<div class="callout small">No Claude session is using this worktree.
      ${wt.busy ? '<span class="muted"><span class="dot busy"></span> Removing…</span>'
        : cs.eligible ? '<button class="link-btn" data-act="remove">Remove it</button> (the branch is kept)'
        : `<button class="link-btn" data-act="remove-anyway">Remove anyway…</button> <span class="muted">(${esc(cs.reasons.join('; '))})</span>`}
      · <a class="link-btn" href="#/cleanup">Clean up others</a></div>`;
  } else if (cs?.kind === 'merged') {
    const files = cs.dirty ? `<details ${cs.dirty.kind === 'work' && cs.dirty.count <= 20 ? 'open' : ''}><summary>${cs.dirty.count} uncommitted file${cs.dirty.count === 1 ? '' : 's'}</summary>
        <ul class="file-list">${cs.dirty.files.map((f) => `<li><code>${esc(f.file)}</code> <span class="muted small">${esc(STATUS[f.xy] || f.xy.trim())}</span></li>`).join('')}${cs.dirty.count > cs.dirty.files.length ? `<li class="muted">…and ${cs.dirty.count - cs.dirty.files.length} more</li>` : ''}</ul></details>` : '';
    const commits = cs.unmatched?.length ? `<details><summary>${cs.unmatched.length} commit${cs.unmatched.length === 1 ? '' : 's'} with no matching change in the PR (kept on the branch)</summary>
        <ul class="file-list">${cs.unmatched.map((c) => `<li><code>${esc(c.sha.slice(0, 8))}</code> ${esc(c.subject)}</li>`).join('')}</ul></details>` : '';
    const notes = cs.notes.length ? `<ul class="notes">${cs.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
    const busy = wt.busy ? '<span class="muted"><span class="dot busy"></span> Removing…</span>' : '';
    cleanup = cs.eligible
      ? `<div class="callout merged"><strong>PR merged.</strong> Nothing uncommitted would be lost and nothing is using it. ${cs.auto && st().config.autoCleanup ? 'It will be removed automatically in a moment.' : 'It was merged before auto-cleanup was set up, so it waits for you.'}
          ${notes}${files}${commits}
          <div class="actions" style="margin-top:8px">${busy || `<button class="btn danger" data-act="remove">Remove worktree${cs.branchSafe ? ' and branch' : ''}</button>`}</div></div>`
      : `<div class="callout warn"><strong>PR merged, but removing this worktree could lose something:</strong>
          <ul>${cs.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>${notes}${files}${commits}
          ${cs.forceable ? `<div class="actions" style="margin-top:8px">${busy || '<button class="btn danger" data-act="remove-anyway">Remove anyway…</button><span class="muted small">The branch is kept either way.</span>'}</div>` : ''}</div>`;
  }
  return `<div class="title-row"><h1>${esc(name)}${pr}</h1>
      <div class="actions">${prChip(wt.pr)}${wt.sessions.map(sessionChip).join('')}</div></div>
    ${wt.pr ? `<div class="meta">${esc(wt.pr.title)}</div>` : ''}
    <div class="meta">
      <span>${esc(wt.repoName)}</span>
      <span class="mono" title="${esc(wt.path)}">${esc(tilde(wt.path))}</span>
      <button class="link-btn" data-act="copy-path">copy path</button>
      ${editorLink(wt.path) ? `<a href="${esc(editorLink(wt.path))}">open in ${editorName()}</a>` : ''}
      <span class="base-edit">base <input id="base" value="${esc(wt.baseRef || '')}" title="${esc(wt.baseSource || '')}" spellcheck="false"><button class="btn small" data-act="set-base">Set</button>${wt.baseSource === 'set by you' ? '<button class="link-btn" data-act="reset-base">reset</button>' : `<span>(${esc(wt.baseSource || '')})</span>`}</span>
      <span>${wt.ahead} commit${wt.ahead === 1 ? '' : 's'}${wt.dirty ? ` + ${wt.dirty} uncommitted` : ''}</span>
      <span>updated ${ago(wt.lastActivity)}</span>
    </div>
    ${err}${removeErr}
    ${wt.baseError && !wt.error ? `<div class="callout warn">${esc(wt.baseError)}. Set a different base above.</div>` : ''}
    ${cleanup}`;
}
