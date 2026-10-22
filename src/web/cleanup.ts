// ---------- clean-up page ----------
// Every worktree no Claude session is using, merged or not, sorted by whether it can go.
import type { CleanupStatus, Worktree } from '../shared/api.ts';
import { prChip } from './sidebar.ts';
import { S, st } from './state.ts';
import { ago, esc, shortPath } from './util.ts';

export type CleanWt = Worktree & { cleanup: CleanupStatus };
const hasCleanup = (w: Worktree): w is CleanWt => !!w.cleanup;

export function cleanupGroups() {
  const g: Record<'ready' | 'look' | 'blocked', CleanWt[]> = { ready: [], look: [], blocked: [] };
  for (const w of st().worktrees) {
    if (!hasCleanup(w) || w.sessions.length) continue;
    const cs = w.cleanup;
    (cs.eligible && !w.busy ? g.ready : cs.forceable ? g.look : g.blocked).push(w);
  }
  for (const items of Object.values(g)) items.sort((a, b) => a.lastActivity - b.lastActivity);
  return g;
}

// Picked unless you unticked it. Anything touched in the last few days starts unticked.
export function cleanPicked(w: CleanWt) {
  const t = S.cleanSel.get(w.id);
  if (t !== undefined) return t;
  return w.cleanup.kind === 'merged' || w.pr?.state === 'CLOSED' || Date.now() - w.lastActivity > st().config.recentDays * 864e5;
}

interface RowOpts { pick?: boolean; open?: boolean; tools?: string }

function cleanRow(w: CleanWt, { pick = false, open = false }: RowOpts = {}) {
  const cs = w.cleanup;
  const name = w.branch || `detached @ ${w.head?.slice(0, 8) || '?'}`;
  const notes = [...(pick ? [] : cs.reasons), ...cs.notes];
  return `<label class="clean-row ${pick ? '' : 'static'}">
    ${pick ? `<input type="checkbox" data-act="clean-pick" data-id="${w.id}" ${cleanPicked(w) ? 'checked' : ''}>` : ''}
    <div class="clean-main">
      <div><strong>${esc(name)}</strong> ${prChip(w.pr)} ${w.busy ? '<span class="chip busy-chip"><span class="dot busy"></span>removing…</span>' : ''}
        <span class="muted small">${esc(w.repoName)} · ${esc(shortPath(w.path))} · ${ago(w.lastActivity)}</span>
        ${open ? `<a class="link-btn" href="#/${w.id}">open</a>` : ''}</div>
      ${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    </div></label>`;
}

export function cleanupPageHtml() {
  const state = st();
  const g = cleanupGroups();
  const picked = g.ready.filter(cleanPicked).length;
  const running = state.jobs.some((j) => j.kind === 'cleanup' && j.status === 'running');
  const inUse = state.worktrees.filter((w) => w.cleanup && w.sessions.length).length;
  const sec = (title: string, sub: string, items: CleanWt[], opts: RowOpts) => items.length ? `<section class="clean-sec"><h2>${title} <span class="count">${items.length}</span>${opts.tools || ''}</h2>
      ${sub ? `<p class="muted small">${sub}</p>` : ''}${items.map((w) => cleanRow(w, opts)).join('')}</section>` : '';
  return `<div class="page setup clean-page">
    <h1>Clean up worktrees</h1>
    <p class="muted">Worktrees no Claude session is using${inUse ? ` (${inUse} in use ${inUse === 1 ? 'is' : 'are'} left out)` : ''}. Removing one deletes its folder.
      Branches are kept, except a merged branch whose commits are all in its PR, and every removal can be restored from <em>Cleaned up</em> in the sidebar.</p>
    ${!g.ready.length && !g.look.length && !g.blocked.length ? '<div class="empty">Nothing to clean up.</div>' : ''}
    ${sec('Ready to remove', `Nothing uncommitted would be lost. Ones changed in the last ${state.config.recentDays} days start unticked.`, g.ready, {
      pick: true,
      tools: ` <span class="clean-tools"><button class="link-btn" data-act="clean-all" data-on="1">all</button> <button class="link-btn" data-act="clean-all" data-on="0">none</button></span>`,
    })}
    ${sec('Need a look first', 'Removing these would lose uncommitted changes or unsent comments. Open one to see the files and use <em>Remove anyway</em>.', g.look, { open: true })}
    ${sec("Can't be removed", '', g.blocked, { open: true })}
    ${g.ready.length ? `<div class="clean-foot"><button class="btn danger" data-act="clean-run" ${picked && !running ? '' : 'disabled'}>Remove ${picked} worktree${picked === 1 ? '' : 's'}</button>
      ${running ? '<span class="muted small">A clean-up is running; see the sidebar.</span>' : ''}</div>` : ''}
  </div>`;
}
