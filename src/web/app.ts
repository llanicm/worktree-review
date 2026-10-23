// Worktree Review — client. Plain DOM, rendered from state; the server pushes updates over SSE.
// Entry point: event wiring and startup. The rest lives in the neighbouring modules.
import { actions, saveEditor } from './actions.ts';
import { closePicker } from './picker.ts';
import { closeResult } from './result.ts';
import { renderSidebar } from './sidebar.ts';
import { connect } from './live.ts';
import { onHash } from './loading.ts';
import { saveConfig } from './setup.ts';
import { chooseBase, redrawHeaderMeta } from './header.ts';
import type { ReviewEffort, Reviewer } from '../shared/api.ts';
import { reviewPick } from './code-review.ts';
import { $, curWt, errMsg, need, S, view } from './state.ts';
import { elapsed, toast } from './util.ts';
import { renderMain } from './view.ts';

// Anything with a .value the user can edit.
const valueOf = (el: Element) => (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? el.value : '');

setInterval(() => {
  for (const el of document.querySelectorAll<HTMLElement>('.cr-elapsed, .tick')) el.textContent = elapsed(Number(el.dataset.start));
}, 1000);

document.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (S.reviewMenu && !target.closest('.review-run')) { S.reviewMenu = null; renderMain(); }
  const el = target.closest<HTMLElement>('[data-act]');
  if (!el || el.tagName === 'SELECT' || (el instanceof HTMLInputElement && el.type === 'checkbox' && e.type === 'click' && !['viewed', 'auto-cleanup', 'picker-hidden', 'clean-pick'].includes(el.dataset.act ?? ''))) return;
  const fn = actions[el.dataset.act ?? ''];
  if (!fn) return;
  if (el.tagName === 'A') e.preventDefault();
  Promise.resolve(fn(el, e)).catch((err) => toast(errMsg(err), true));
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  if (el.dataset.act === 'target') S.summaries[`${S.selId}:target`] = valueOf(el);
  if (el.dataset.act === 'base-select') chooseBase(valueOf(el));
  if (el.dataset.review) {
    const wt = curWt();
    if (!wt) return;
    const pick = reviewPick(wt);
    S.reviewPick = el.dataset.review === 'reviewer' ? { ...pick, reviewer: valueOf(el) as Reviewer } : { ...pick, effort: valueOf(el) as ReviewEffort };
    renderMain();
  }
  if (el.dataset.cfg) {
    const key = el.dataset.cfg;
    const value = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el instanceof HTMLInputElement && el.type === 'number' ? Number(el.value) : valueOf(el);
    saveConfig({ [key]: value });
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  if (el.id === 'filter') { S.filter = valueOf(el); renderSidebar(); return; }
  const ek = el.dataset.ek;
  if (!ek) return;
  if (ek === 'summary') {
    S.summaries[S.selId ?? ''] = valueOf(el);
    const btn = $<HTMLButtonElement>('[data-act="submit"]');
    if (btn) btn.disabled = !valueOf(el).trim() && !view().comments.some((c) => c.status === 'draft');
  } else S.editors.set(ek, valueOf(el));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#picker')) { closePicker(); return; }
  if (e.key === 'Escape' && $('#result') && !$('#result')?.dataset.busy) { closeResult(); return; }
  if (e.key === 'Escape' && S.reviewMenu) { S.reviewMenu = null; renderMain(); return; }
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  if (el.dataset.act === 'base-input') {
    if (e.key === 'Enter') { e.preventDefault(); need<HTMLButtonElement>('[data-act="set-base"]').click(); }
    if (e.key === 'Escape') { S.baseOther = null; redrawHeaderMeta(); }
    return;
  }
  const ek = el.dataset.ek;
  if (!ek || ek === 'summary') return;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEditor(ek).catch((err) => toast(errMsg(err), true)); }
  if (e.key === 'Escape') { S.editors.delete(ek); renderMain(); }
});

window.addEventListener('hashchange', onHash);

const nb = need('#notify');
if ('Notification' in window && Notification.permission === 'default') {
  nb.hidden = false;
  nb.onclick = () => Notification.requestPermission().then(() => { nb.hidden = true; });
}

connect();
