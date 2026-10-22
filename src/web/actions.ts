// ---------- actions (data-act event delegation) ----------
import type { CodeRabbitReview, Integrations, RepairResult } from '../shared/api.ts';
import { indexFindings, loadCodeRabbit } from './coderabbit.ts';
import { collapseAll, expandAll, toggleBody, toggleCommit, toggleFile } from './collapse.ts';
import { cleanPicked, cleanupGroups } from './cleanup.ts';
import { keyOf, parseKey, sameCommit } from './diff.ts';
import { fileCommitsOf, isCollapsed } from './file.ts';
import { loadView, reloadComments } from './loading.ts';
import { closePicker, openPicker } from './picker.ts';
import { closeResult, showResult } from './result.ts';
import { loadIntegrations, saveConfig } from './setup.ts';
import { grouped, renderSidebar } from './sidebar.ts';
import { api, curWt, errMsg, need, S, st, view } from './state.ts';
import { copy, expandHome, fnv, toast } from './util.ts';
import { renderMain } from './view.ts';

export type Action = (el: HTMLElement, e: Event) => void | Promise<void>;

const attr = (el: HTMLElement, name: string) => el.dataset[name] ?? '';
const isChecked = (el: HTMLElement) => el instanceof HTMLInputElement && el.checked;

function lineTextFor(key: string) {
  const { commit, file, side, line } = parseKey(key);
  const f = view().files.find((x) => x.path === file && sameCommit(x.commit, commit));
  for (const h of f?.hunks || []) for (const l of h.lines) {
    if ((side === 'old' ? l.o : l.n) === Number(line) && (side === 'old') === (l.t === 'del')) return l.text;
  }
  return '';
}

export async function saveEditor(ek: string) {
  const text = (S.editors.get(ek) || '').trim();
  if (!text) return;
  const [kind, rest] = [ek.slice(0, ek.indexOf(':')), ek.slice(ek.indexOf(':') + 1)];
  if (kind === 'new') {
    const { commit, file, side, line } = parseKey(rest);
    const c = commit && view().diff.commits.find((x) => x.sha === commit);
    await api('POST', '/api/comments', { wtId: view().wtId, file, side, line, lineText: lineTextFor(rest), body: text, commit: commit || undefined, commitSubject: c ? c.subject : undefined });
  } else if (kind === 'edit') {
    await api('PATCH', `/api/comments/${rest}`, { body: text });
  } else if (kind === 'reply') {
    await api('POST', `/api/comments/${rest}/reply`, { body: text, author: 'you' });
  }
  S.editors.delete(ek);
  await reloadComments();
}

export const actions: Record<string, Action> = {
  'new-comment': (el) => {
    const ek = `new:${attr(el, 'k')}`;
    if (!S.editors.has(ek)) S.editors.set(ek, '');
    S.focusEk = ek;
    renderMain();
  },
  'cancel-editor': (el) => { S.editors.delete(attr(el, 'ek')); renderMain(); },
  'save-editor': (el) => saveEditor(attr(el, 'ek')),
  edit: (el) => {
    const c = view().comments.find((x) => x.id === attr(el, 'id'));
    if (!c) return;
    S.editors.set(`edit:${c.id}`, c.body);
    S.focusEk = `edit:${c.id}`;
    renderMain();
  },
  reply: (el) => { S.editors.set(`reply:${attr(el, 'id')}`, ''); S.focusEk = `reply:${attr(el, 'id')}`; renderMain(); },
  delete: async (el) => { await api('DELETE', `/api/comments/${attr(el, 'id')}`); await reloadComments(); },
  resolve: async (el) => { await api('POST', `/api/comments/${attr(el, 'id')}/resolve`, { author: 'you' }); await reloadComments(); },
  reopen: async (el) => { await api('POST', `/api/comments/${attr(el, 'id')}/reopen`); await reloadComments(); },
  'toggle-file': (el) => {
    const f = view().files.find((x) => x.uid === attr(el, 'file'));
    if (f) toggleFile(f);
  },
  'collapse-all': () => collapseAll(view()),
  'expand-all': () => expandAll(view()),
  'toggle-body': (el) => toggleBody(Number(attr(el, 'n'))),
  'toggle-commit': (el) => {
    const n = Number(attr(el, 'n'));
    toggleCommit(n);
    // Keep the header you clicked in view; collapsing can pull the page up under the cursor.
    document.getElementById(`cg-${n}`)?.scrollIntoView({ block: 'nearest' });
  },
  'hl-commit': (el, e) => {
    e.preventDefault();
    const n = el.dataset.n === '' ? null : Number(el.dataset.n);
    S.hl = S.hl === n ? null : n;
    const hl = S.hl;
    if (hl !== null) for (const f of view().files) if (fileCommitsOf(f.path).includes(hl)) S.toggled.set(f.uid, false);
    renderMain();
  },
  'view-commit': (el, e) => {
    e.preventDefault();
    S.scrollTo = `cg-${attr(el, 'n')}`;
    S.shutCommits.delete(Number(attr(el, 'n')));
    if (view().diff.mode === 'commits') { renderMain(); return; }
    S.mode = 'commits';
    S.hl = null;
    loadView();
  },
  'force-render': (el) => { S.forceRender.add(attr(el, 'file')); renderMain(); },
  viewed: async (el) => {
    const f = view().files.find((x) => x.path === attr(el, 'file'));
    if (!f) return;
    const on = isChecked(el);
    await api('POST', `/api/worktrees/${view().wtId}/viewed`, { file: f.path, hash: f.hash, viewed: on });
    if (on) view().diff.viewed[f.path] = f.hash; else delete view().diff.viewed[f.path];
    S.toggled.delete(f.uid);
    renderMain();
  },
  jump: (el, e) => {
    e.preventDefault();
    const f = view().files.find((x) => x.path === attr(el, 'file') && !x.commit);
    if (!f) return;
    if (isCollapsed(f)) { S.toggled.set(f.uid, false); renderMain(); }
    document.getElementById(`f-${fnv(f.uid)}`)?.scrollIntoView({ block: 'start' });
  },
  mode: (el, e) => {
    e.preventDefault();
    const m = el.dataset.mode;
    if (m === 'full' || m === 'since' || m === 'commits') S.mode = m;
    S.hl = null;
    loadView();
  },
  refresh: () => { loadView(); },
  'mark-reviewed': async () => {
    const v = view();
    await api('POST', `/api/worktrees/${v.wtId}/reviewed`, { tree: v.diff.tree, fingerprint: v.diff.fingerprint });
    toast('Marked as reviewed. Next time you\'ll see only what changed.');
    S.mode = 'since';
    loadView();
  },
  'set-base': async () => {
    try { await api('POST', `/api/worktrees/${S.selId}/base`, { base: need<HTMLInputElement>('#base').value }); S.view = null; loadView(); } catch (e) { toast(errMsg(e), true); }
  },
  'reset-base': async () => { await api('POST', `/api/worktrees/${S.selId}/base`, { base: '' }); S.view = null; loadView(); },
  'copy-path': async () => { const wt = curWt(); if (wt) await copy(wt.path, 'Path copied'); },
  'copy-prompt': async () => { const { text } = await api<{ text: string }>('GET', `/api/worktrees/${S.selId}/prompt`); await copy(text, 'Review copied as a prompt'); },
  submit: async () => {
    const wt = curWt();
    if (!wt) return;
    await api('POST', `/api/worktrees/${wt.id}/submit`, { summary: S.summaries[wt.id] || '', targetSession: S.summaries[`${wt.id}:target`] || null });
    S.summaries[wt.id] = '';
    S.editors.delete('summary');
    toast(wt.sessions.length ? 'Sent. Claude gets it at the end of its current turn.' : 'Queued for the next Claude session that works here.');
    await reloadComments();
  },
  'cancel-review': async (el) => { await api('POST', `/api/reviews/${attr(el, 'id')}/cancel`); await reloadComments(); },
  remove: async () => {
    const wt = curWt();
    if (!wt) return;
    const msg = wt.cleanup?.kind === 'idle'
      ? `Remove this worktree?\n\nIts folder is deleted. ${wt.branch ? `The branch ${wt.branch} is kept, so its commits are safe` : 'Its commit is on a branch, so nothing is lost'}, and you can restore it from Cleaned up.`
      : 'Remove this worktree? Its branch is deleted too if it matches the merged PR.';
    if (!confirm(msg)) return;
    if (S.selId) delete S.removeErrors[S.selId];
    await api('POST', `/api/worktrees/${S.selId}/remove`);
  },
  'remove-anyway': async () => {
    const wt = curWt();
    const cs = wt?.cleanup;
    if (!wt || !cs) return;
    const lost = cs.dirty ? cs.dirty.files.map((f) => `  • ${f.file}`).join('\n') + (cs.dirty.count > cs.dirty.files.length ? `\n  …and ${cs.dirty.count - cs.dirty.files.length} more` : '') : '';
    const comments = wt.comments.draft + wt.comments.waiting;
    const msg = [`Remove ${wt.branch || 'this worktree'} anyway?`, '',
      lost ? `These uncommitted changes will be lost:\n${lost}` : '',
      comments ? `${comments} unsent review comment${comments === 1 ? '' : 's'} will stay in the dashboard's history but can't be delivered.` : '',
      '', wt.branch ? `The branch ${wt.branch} is kept, so its commits are safe.` : ''].filter((l, i, a) => l || a[i - 1]).join('\n');
    if (!confirm(msg)) return;
    delete S.removeErrors[wt.id];
    await api('POST', `/api/worktrees/${wt.id}/remove`, { force: true });
  },
  'cleanup-safe': async () => {
    const n = st().worktrees.filter((w) => w.cleanup?.kind === 'merged' && w.cleanup.eligible).length;
    if (!confirm(`Remove ${n} merged worktree${n === 1 ? '' : 's'} that are clean and not in use? This runs in the background.`)) return;
    await api('POST', '/api/cleanup/safe');
  },
  'clean-pick': (el) => { S.cleanSel.set(attr(el, 'id'), isChecked(el)); renderMain(); },
  'clean-all': (el) => { for (const w of cleanupGroups().ready) S.cleanSel.set(w.id, attr(el, 'on') === '1'); renderMain(); },
  'clean-run': async () => {
    const ids = cleanupGroups().ready.filter((w) => cleanPicked(w)).map((w) => w.id);
    if (!ids.length) return;
    const merged = ids.filter((id) => st().worktrees.find((w) => w.id === id)?.cleanup?.branchSafe).length;
    const msg = `Remove ${ids.length} worktree${ids.length === 1 ? '' : 's'}?\n\nTheir folders are deleted. ${merged ? `${merged} merged branch${merged === 1 ? ' is' : 'es are'} deleted too, because everything on ${merged === 1 ? 'it is' : 'them is'} in the merged PR. ` : ''}Every other branch is kept, and each removal can be restored from Cleaned up. This runs in the background.`;
    if (!confirm(msg)) return;
    await api('POST', '/api/cleanup', { ids });
    for (const id of ids) S.cleanSel.delete(id);
  },
  'job-dismiss': async (el) => { await api('POST', `/api/jobs/${attr(el, 'id')}/dismiss`); },
  'job-details': (el) => {
    const j = st().jobs.find((x) => x.id === attr(el, 'id'));
    if (!j) return;
    const verb = j.kind === 'repair' ? 'Repaired' : 'Removed';
    showResult({ title: j.title, ok: j.ok, okLabel: verb, failed: j.failed, failedLabel: j.kind === 'repair' ? "Couldn't repair" : "Couldn't remove" });
  },
  repair: async () => {
    const r = await api<RepairResult>('POST', `/api/worktrees/${S.selId}/repair`);
    if (r.failed.length && S.selId) { S.removeErrors[S.selId] = `Repair didn't work: ${r.failed[0]?.error}`; renderMain(); }
    else { if (S.selId) delete S.removeErrors[S.selId]; toast('Link repaired'); S.view = null; loadView(); }
  },
  'repair-all': async () => {
    const n = st().worktrees.filter((w) => w.error?.kind === 'broken-link').length;
    if (!confirm(`Repair the links for ${n} worktree${n === 1 ? '' : 's'}? This runs "git worktree repair" in each repository, which rewrites the link files for all of that repository's worktrees; your code isn't touched.`)) return;
    toast(`Repairing ${n} worktree link${n === 1 ? '' : 's'}…`);
    const r = await api<RepairResult>('POST', '/api/repair');
    if (!r.failed.length) { toast(`Repaired ${r.fixed.length} worktree link${r.fixed.length === 1 ? '' : 's'}`); return; }
    showResult({ title: 'Repair worktree links', ok: r.fixed, okLabel: 'Repaired', failed: r.failed, failedLabel: "Couldn't repair",
      note: r.fixed.length ? 'Repaired worktrees are checked again now. Clean, merged ones become removable within a few seconds.' : '' });
  },
  'close-result': () => closeResult(),
  'result-open': (el) => { closeResult(); location.hash = `#/${attr(el, 'id')}`; },
  'auto-cleanup': async (el) => { await api('POST', '/api/config', { autoCleanup: isChecked(el) }); },
  'toggle-older': () => { S.showOlder = !S.showOlder; renderSidebar(); },
  'toggle-cleaned': () => { S.showCleaned = !S.showCleaned; renderSidebar(); },
  'cr-run': async () => {
    const r = await api<CodeRabbitReview>('POST', `/api/worktrees/${S.selId}/coderabbit`);
    view().cr = r;
    indexFindings();
    toast('CodeRabbit started. This usually takes a few minutes.');
    renderMain();
  },
  'cr-cancel': async () => {
    if (!confirm('Cancel this CodeRabbit review? Its progress is thrown away.')) return;
    await api('POST', `/api/worktrees/${S.selId}/coderabbit/cancel`);
  },
  'cr-send': async (el) => { await api('POST', `/api/findings/${attr(el, 'id')}/send`); await loadCodeRabbit(); await reloadComments(); },
  'cr-dismiss': async (el) => { await api('POST', `/api/findings/${attr(el, 'id')}/dismiss`); await loadCodeRabbit(); renderMain(); },
  'cr-restore': async (el) => { await api('POST', `/api/findings/${attr(el, 'id')}/restore`); await loadCodeRabbit(); renderMain(); },
  'cr-send-all': async () => {
    const { sent } = await api<{ sent: number }>('POST', `/api/worktrees/${S.selId}/coderabbit/send-all`);
    toast(`Added ${sent} finding${sent === 1 ? '' : 's'} to your review as drafts`);
    await loadCodeRabbit();
    await reloadComments();
  },
  'cr-jump': (el, e) => {
    e.preventDefault();
    const f = view().files.find((x) => x.path === attr(el, 'file') && !x.commit);
    if (!f) { toast('That file isn\'t in this diff view'); return; }
    if (isCollapsed(f)) { S.toggled.set(f.uid, false); renderMain(); }
    const row = document.querySelector(`tr.line[data-k="${CSS.escape(keyOf(f.path, 'new', el.dataset.line))}"]`);
    (row || document.getElementById(`f-${fnv(f.path)}`))?.scrollIntoView({ block: 'center' });
  },
  recheck: () => { S.integ = null; renderMain(); return loadIntegrations(true); },
  'copy-text': (el) => copy(attr(el, 'text')),
  'cr-login': async () => { await api('POST', '/api/integrations/coderabbit/login'); },
  'cr-logout': async () => {
    if (!confirm('Sign out of the CodeRabbit CLI on this machine?')) return;
    S.integ = await api<Integrations>('POST', '/api/integrations/coderabbit/logout');
    renderMain();
  },
  'open-picker': () => openPicker(S.picker?.data?.path || '~'),
  'picker-go': (el) => openPicker(attr(el, 'path')),
  'picker-hidden': (el) => {
    const p = S.picker;
    if (!p?.data) return;
    p.hidden = isChecked(el);
    openPicker(p.data.path);
  },
  'picker-close': () => closePicker(),
  'picker-add': async () => {
    const d = S.picker?.data;
    if (!d) return;
    const key = d.isRepo ? 'extraRepos' : 'roots';
    if (st().config[key].map(expandHome).includes(d.path)) { toast('Already added'); return; }
    await saveConfig({ [key]: [...st().config[key], d.path] });
    closePicker();
  },
  'remove-folder': (el) => {
    const key = el.dataset.key;
    if (key !== 'roots' && key !== 'extraRepos') return;
    return saveConfig({ [key]: st().config[key].filter((p) => p !== el.dataset.path) });
  },
  'enable-notifications': () => Notification.requestPermission().then(() => { need('#notify').hidden = true; renderMain(); }),
  'rerun-setup': async () => { await api('POST', '/api/onboarding', { done: false }); location.hash = '#/welcome'; },
  'finish-setup': async () => {
    await api('POST', '/api/onboarding', { done: true });
    const first = grouped(st().worktrees).working[0] || st().worktrees[0];
    location.hash = first ? `#/${first.id}` : '#/';
  },
  'copy-restore': (el) => {
    const c = st().cleaned[Number(el.dataset.i)];
    if (!c) return;
    const cmd = !c.branch ? `git -C ${c.repoRoot} worktree add --detach ${c.path} ${c.sha}`
      : c.branchDeleted ? `git -C ${c.repoRoot} worktree add -b ${c.branch} ${c.path} ${c.sha}`
      : `git -C ${c.repoRoot} worktree add ${c.path} ${c.branch}`;
    copy(cmd, 'Restore command copied');
  },
};
