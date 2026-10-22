// ---------- loading & routing ----------
import type { BlameResponse, CommentsResponse, DiffResponse, FileBlame } from '../shared/api.ts';
import { loadCodeRabbit } from './coderabbit.ts';
import { redrawFile } from './collapse.ts';
import { blameKey } from './file.ts';
import { parseDiff } from './diff.ts';
import { headerHtml } from './header.ts';
import { loadIntegrations, setupSig } from './setup.ts';
import { defaultWorktree, renderSidebar } from './sidebar.ts';
import { api, curWt, errMsg, need, S } from './state.ts';
import type { CommitGroup, View, ViewFile } from './types.ts';
import { esc } from './util.ts';
import { applyBlame, renderMain } from './view.ts';

export async function loadView({ quiet = false } = {}) {
  const wt = curWt();
  if (!wt) { renderMain(); return; }
  const seq = ++S.seq;
  const mode = S.mode || (wt.review.reviewedAt ? 'since' : 'full');
  try {
    const [diff, cm] = await Promise.all([
      api<DiffResponse>('GET', `/api/worktrees/${wt.id}/diff?mode=${mode}`),
      api<CommentsResponse>('GET', `/api/worktrees/${wt.id}/comments`),
    ]);
    if (seq !== S.seq) return;
    S.mode = diff.mode;
    let files: ViewFile[], groups: CommitGroup[] | null = null;
    if (diff.mode === 'commits') {
      const gs: CommitGroup[] = diff.commits.map((c) => ({ ...c, files: parseDiff(c.diff).map((f) => ({ ...f, commit: c.sha, commitN: c.n, uid: `${c.sha}~${f.path}` })) }));
      const unc: ViewFile[] = parseDiff(diff.uncommitted).map((f) => ({ ...f, commit: null, commitN: 0, uncommitted: true, uid: `u~${f.path}` }));
      if (unc.length) gs.push({ n: 0, sha: null, subject: 'Uncommitted changes', files: unc });
      groups = gs;
      files = gs.flatMap((g) => g.files);
    } else {
      // Order files by the first commit that touched them; uncommitted-only files last.
      const first = (p: string) => { const ns = (diff.fileCommits?.[p] || []).filter((n) => n > 0); return ns.length ? Math.min(...ns) : Infinity; };
      files = parseDiff(diff.diff).map((f): ViewFile => ({ ...f, commit: null, uid: f.path }))
        .map((f, i) => ({ f, i, k: first(f.path) })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.f);
    }
    const prev = S.view;
    const v: View = { wtId: wt.id, diff, files, groups, comments: cm.comments, reviews: cm.reviews, commentSig: wt.comments.sig, crSig: wt.coderabbit?.sig, blame: prev?.wtId === wt.id && prev.blame?.fingerprint === diff.fingerprint ? prev.blame : null };
    S.view = v;
    if (diff.mode !== 'commits' && !v.blame && diff.commits.length) {
      api<BlameResponse>('GET', `/api/worktrees/${wt.id}/blame`).then((b) => {
        if (seq !== S.seq || !S.view || b.fingerprint !== S.view.diff.fingerprint) return;
        S.view.blame = b;
        applyBlame();
      }, () => {});
    }
    await loadCodeRabbit();
    if (seq !== S.seq) return;
    S.stale = false;
    renderMain();
    refreshFileBlames(v);
  } catch (e) {
    if (seq !== S.seq) return;
    if (!quiet) need('#main').innerHTML = `<div class="page">${headerHtml(wt)}<div class="callout warn">${esc(errMsg(e))}</div></div>`;
  }
}

export async function reloadComments() {
  if (!S.view) return;
  const cm = await api<CommentsResponse>('GET', `/api/worktrees/${S.view.wtId}/comments`);
  // As before, S.view can have been cleared by switching worktree meanwhile; that throws (caught by the caller's toast).
  S.view.comments = cm.comments;
  S.view.reviews = cm.reviews;
  renderMain();
}

function select(id: string) {
  if (S.selId === id) return;
  S.selId = id;
  S.mode = null;
  S.view = null;
  S.toggled.clear();
  S.forceRender.clear();
  S.editors.clear();
  S.shutCommits.clear();
  S.openBodies.clear();
  S.hl = null;
  need('#main').scrollTop = 0;
  renderSidebar();
  renderMain();
  loadView();
}

export function onHash() {
  const id = location.hash.replace(/^#\/?/, '') || null;
  if (id === 'settings' || id === 'welcome' || id === 'cleanup') {
    S.page = id;
    S.selId = null;
    S.view = null;
    S.setupSig = S.st ? setupSig(S.st) : null;
    need('#main').scrollTop = 0;
    renderSidebar();
    renderMain();
    loadIntegrations();
    return;
  }
  S.page = null;
  // Opening a worktree means setup is done, even without pressing Start reviewing.
  if (id && S.st && !S.st.onboardedAt) api('POST', '/api/onboarding', { done: true }).catch(() => {});
  const fallback = !id && S.st?.onboardedAt ? defaultWorktree(S.st.worktrees) : undefined;
  if (fallback) { location.replace(`#/${fallback.id}`); return; }
  if (id) select(id); else { S.selId = null; renderSidebar(); renderMain(); }
}

// Files with their Blame column on keep it when the worktree changes: fetch the new blame and redraw them.
function refreshFileBlames(v: View) {
  for (const f of v.files) {
    if (!S.blameOn.has(f.uid) || f.commit || S.fileBlame.has(blameKey(f))) continue;
    const key = blameKey(f);
    api<FileBlame>('GET', `/api/worktrees/${v.wtId}/blame/file?path=${encodeURIComponent(f.path)}`).then((b) => {
      S.fileBlame.set(key, b);
      if (S.view === v) redrawFile(f);
    }, () => { S.blameOn.delete(f.uid); if (S.view === v) redrawFile(f); });
  }
}
