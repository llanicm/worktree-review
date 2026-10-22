// ---------- results dialog (bulk cleanup / repair) ----------
import { $ } from './state.ts';
import { esc, tilde } from './util.ts';

// Jobs and repair results both fit this; `error` is only on failures, `id` only where there's a worktree to open.
interface ResultItem { id?: string; branch: string | null; path: string; error?: string }
interface ResultOpts { title: string; busy?: boolean; ok?: ResultItem[]; okLabel?: string; failed?: ResultItem[]; failedLabel?: string; note?: string }

export function showResult({ title, busy, ok = [], okLabel, failed = [], failedLabel, note }: ResultOpts) {
  let el = $('#result');
  if (!el) {
    const made = document.createElement('div');
    made.id = 'result';
    made.className = 'modal-backdrop';
    made.addEventListener('click', (e) => { if (e.target === made && !made.dataset.busy) closeResult(); });
    document.body.appendChild(made);
    el = made;
  }
  el.dataset.busy = busy ? '1' : '';
  const item = (x: ResultItem, bad: boolean) => `<div class="result-item ${bad ? 'bad' : ''}">
      <div><strong>${esc(x.branch || tilde(x.path))}</strong> <span class="muted mono">${esc(tilde(x.path))}</span></div>
      ${bad ? `<div class="result-err">${esc(x.error)}</div><button class="link-btn" data-act="result-open" data-id="${esc(x.id)}">Open this worktree</button>` : ''}
    </div>`;
  el.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><span>${esc(title)}</span>${busy ? '' : '<button class="link-btn" data-act="close-result" aria-label="Close">✕</button>'}</div>
    <div class="dir-list result-list">
      ${busy ? '<div class="file-note">Working… removing a worktree can take a few seconds each.</div>' : `
        ${failed.length ? `<h3 class="result-h bad">${failedLabel} (${failed.length})</h3>${failed.map((x) => item(x, true)).join('')}` : ''}
        ${ok.length ? `<h3 class="result-h">${okLabel} (${ok.length})</h3>${ok.map((x) => item(x, false)).join('')}` : ''}
        ${!ok.length && !failed.length ? '<div class="file-note">Nothing to do.</div>' : ''}
        ${note ? `<p class="muted small">${esc(note)}</p>` : ''}`}
    </div>
    ${busy ? '' : '<div class="modal-foot"><div class="actions" style="justify-content:flex-end"><button class="btn" data-act="close-result">Close</button></div></div>'}
  </div>`;
}
export function closeResult() { $('#result')?.remove(); }
