// ---------- folder picker ----------
import type { DirListing } from '../shared/api.ts';
import { $, api, errMsg, S, st } from './state.ts';
import { esc, expandHome, toast } from './util.ts';

const FOLDER_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/></svg>';
const REPO_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/></svg>';

export async function openPicker(p: string) {
  const picker = (S.picker ||= { hidden: false });
  try {
    picker.data = await api<DirListing>('GET', `/api/fs?path=${encodeURIComponent(p)}${picker.hidden ? '&hidden=1' : ''}`);
  } catch (e) { toast(errMsg(e), true); if (picker.data) return; picker.data = null; return; }
  renderPicker();
}

export function closePicker() {
  $('#picker')?.remove();
}

function renderPicker() {
  const picker = S.picker;
  const d = picker?.data;
  if (!picker || !d) return;
  const home = st().home;
  const parts = d.display.split('/').filter(Boolean);
  const crumbs = parts.map((name, i) => {
    const target = i === 0 ? home : `${home}/${parts.slice(1, i + 1).join('/')}`;
    return i === parts.length - 1 ? `<strong>${esc(name)}</strong>` : `<button class="link-btn" data-act="picker-go" data-path="${esc(target)}">${esc(name)}</button>`;
  }).join('<span class="muted">/</span>');
  const added = [...st().config.roots, ...st().config.extraRepos].map(expandHome);
  const already = added.includes(d.path);
  const verdict = d.isRepo
    ? `<strong>${esc(d.display)}</strong> is a git repo. Its worktrees will be listed.`
    : d.repoChildren
      ? `<strong>${esc(d.display)}</strong> contains ${d.repoChildren} git repo${d.repoChildren === 1 ? '' : 's'}. All of them, and their worktrees, will be listed.`
      : `No git repos directly inside <strong>${esc(d.display)}</strong>. Open a folder that has some, or pick a repo.`;
  let el = $('#picker');
  if (!el) {
    const made = document.createElement('div');
    made.id = 'picker';
    made.className = 'modal-backdrop';
    made.addEventListener('click', (e) => { if (e.target === made) closePicker(); });
    document.body.appendChild(made);
    el = made;
  }
  el.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Choose a folder">
    <div class="modal-head"><span>Choose a folder</span><button class="link-btn" data-act="picker-close" aria-label="Close">✕</button></div>
    <div class="crumbs">${d.parent ? `<button class="btn small" data-act="picker-go" data-path="${esc(d.parent)}" title="Up one level">↑</button>` : ''}${crumbs}</div>
    <div class="dir-list">${d.entries.length ? d.entries.map((e) => `
      <button class="dir ${e.isRepo ? 'repo' : ''}" data-act="picker-go" data-path="${esc(e.path)}">
        ${e.isRepo ? REPO_ICON : FOLDER_ICON}<span class="dir-name">${esc(e.name)}</span>${e.isRepo ? '<span class="chip open">git repo</span>' : ''}${added.includes(e.path) ? '<span class="chip">added</span>' : ''}
      </button>`).join('') : '<div class="file-note">No folders here.</div>'}</div>
    <div class="modal-foot">
      <div class="verdict">${verdict}</div>
      <div class="actions">
        <label class="toggle small"><input type="checkbox" data-act="picker-hidden" ${picker.hidden ? 'checked' : ''}> Show hidden</label>
        <span style="flex:1"></span>
        <button class="btn" data-act="picker-close">Cancel</button>
        <button class="btn primary" data-act="picker-add" ${already || (!d.isRepo && !d.repoChildren) ? 'disabled' : ''}>${already ? 'Already added' : d.isRepo ? 'Add this repo' : 'Add this folder'}</button>
      </div>
    </div>
  </div>`;
  const list = el.querySelector('.dir-list');
  if (list) list.scrollTop = 0;
}
