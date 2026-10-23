// ---------- worktree header & clean-up callouts ----------
import type { BaseChoices, Worktree } from '../shared/api.ts';
import { agentChip, inUse, prChip, sessionChip } from './sidebar.ts';
import { api, errMsg, need, S, st } from './state.ts';
import { loadView } from './loading.ts';
import { ago, editorLink, editorName, esc, tilde, toast } from './util.ts';

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
  if (cs?.kind === 'idle' && !inUse(wt) && (cs.eligible || cs.forceable)) {
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
  if (wt.isMain && wt.pr?.state === 'MERGED') {
    cleanup = `<div class="callout merged small"><strong>PR merged.</strong> This is the repository's own folder, so it's never removed.
      Switch it back with <code>git switch ${esc(wt.pr.baseRefName)} &amp;&amp; git pull</code>.</div>`;
  }
  return `<div class="title-row"><h1>${esc(name)}${pr}</h1>
      <div class="actions">${prChip(wt.pr)}${wt.sessions.map(sessionChip).join('')}${wt.agents.map(agentChip).join('')}</div></div>
    ${wt.pr ? `<div class="meta">${esc(wt.pr.title)}</div>` : ''}
    ${headerMetaHtml(wt)}
    ${err}${removeErr}
    ${wt.baseError && !wt.error ? `<div class="callout warn">${esc(wt.baseError)}. Pick a different one in Compare with above.</div>` : ''}
    ${cleanup}`;
}

// ---------- where it lives, and what it's compared with ----------

const ICON_REPO = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8Z"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Zm5-5C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>';
const ICON_COMPARE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM6 12v-1.646a.25.25 0 0 1 .427-.177l2.396 2.396a.25.25 0 0 1 0 .354l-2.396 2.396A.25.25 0 0 1 6 15.146V13.5H5A2.5 2.5 0 0 1 2.5 11V5.372a2.25 2.25 0 1 1 1.5 0V11a1 1 0 0 0 1 1ZM4 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0ZM12.75 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>';

export const OTHER_REF = '__other';

/** Repo, path and editor on one row; what the diff is compared with, and how much there is, on the next. */
export function headerMetaHtml(wt: Worktree) {
  const editor = editorLink(wt.path);
  const counts = `${wt.ahead} commit${wt.ahead === 1 ? '' : 's'}${wt.dirty ? ` + ${wt.dirty} uncommitted` : ''}`;
  return `<div class="wt-meta">
    <div class="meta-row">
      <span class="meta-item" title="Repository">${ICON_REPO}${esc(wt.repoName)}</span>
      <span class="path-chip" title="${esc(wt.path)}"><span class="mono">${esc(tilde(wt.path))}</span><button class="icon-btn" data-act="copy-path" title="Copy path" aria-label="Copy path">${ICON_COPY}</button></span>
      ${editor ? `<a class="btn small" href="${esc(editor)}">Open in ${editorName()}</a>` : ''}
    </div>
    <div class="meta-row">
      <span class="meta-item compare" title="The diff shows what changed since this ref">${ICON_COMPARE}Compare with ${baseControlHtml(wt)}</span>
      <span class="muted">${counts} · updated ${ago(wt.lastActivity)}</span>
    </div>
  </div>`;
}

function baseControlHtml(wt: Worktree) {
  if (S.baseOther === wt.id) {
    return `<span class="base-other"><input id="base" value="${esc(wt.baseRef || '')}" placeholder="branch, tag or commit" spellcheck="false" data-act="base-input">
      <button class="btn small primary" data-act="set-base">Compare</button><button class="btn small" data-act="base-other-cancel">Cancel</button></span>`;
  }
  const c = S.bases.get(wt.id);
  const overridden = wt.baseSource === 'set by you';
  const auto = c?.automatic ?? (overridden ? null : { ref: wt.baseRef ?? '', source: wt.baseSource ?? '' });
  const opt = (value: string, label: string, selected: boolean) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
  const current = wt.baseRef ?? '';
  const listed = new Set([...(c?.branches ?? []), ...(c?.remotes ?? [])]);
  const options = [
    auto ? opt('', `${auto.ref} (automatic: ${auto.source})`, !overridden) : opt('', 'Automatic', !overridden),
    overridden && !listed.has(current) ? opt(current, current, true) : '',
    c?.branches.length ? `<optgroup label="Branches">${c.branches.map((b) => opt(b, b, overridden && b === current)).join('')}</optgroup>` : '',
    c?.remotes.length ? `<optgroup label="Remote branches">${c.remotes.map((b) => opt(b, b, overridden && b === current)).join('')}</optgroup>` : '',
    opt(OTHER_REF, 'Other branch, tag or commit…', false),
  ];
  return `<select class="base-select" data-act="base-select" aria-label="Compare with">${options.join('')}</select>`;
}

/** Fetches the "Compare with" choices once per worktree, then redraws just that row. */
export function loadBases(wt: Worktree) {
  if (S.bases.has(wt.id) || S.basesLoading.has(wt.id)) return;
  S.basesLoading.add(wt.id);
  api<BaseChoices>('GET', `/api/worktrees/${wt.id}/bases`).then((c) => {
    S.bases.set(wt.id, c);
    redrawHeaderMeta();
  }, () => {}).finally(() => S.basesLoading.delete(wt.id));
}

export function redrawHeaderMeta() {
  const wt = S.st?.worktrees.find((w) => w.id === S.selId);
  const el = need('#main').querySelector('.wt-meta');
  if (!wt || !el) return;
  el.outerHTML = headerMetaHtml(wt);
  if (S.baseOther === wt.id) need<HTMLInputElement>('#base').focus();
}

/** A pick from the "Compare with" menu: "" goes back to the automatic base. */
export async function chooseBase(value: string) {
  if (value === OTHER_REF) { S.baseOther = S.selId; redrawHeaderMeta(); return; }
  try {
    await api('POST', `/api/worktrees/${S.selId}/base`, { base: value });
    S.view = null;
    loadView();
  } catch (e) {
    toast(errMsg(e), true);
    redrawHeaderMeta();
  }
}
