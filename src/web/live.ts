// ---------- live updates ----------
import type { PublicState } from '../shared/api.ts';
import { loadCodeReviews, NAMES, REVIEWERS, reviewsSig } from './code-review.ts';
import { loadView, onHash, reloadComments } from './loading.ts';
import { loadIntegrations, setupSig } from './setup.ts';
import { renderSidebar } from './sidebar.ts';
import { curWt, need, S } from './state.ts';
import type { LiveMessage } from './types.ts';
import { toast } from './util.ts';
import { headerSig, renderMain } from './view.ts';

function maybeNotify(st: PublicState) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  for (const s of st.sessions) {
    const prev = S.prevStatus.get(s.sessionId);
    if (prev === 'busy' && s.status === 'idle') {
      const wts = st.worktrees.filter((w) => w.review.needsReview && w.sessions.some((x) => x.sessionId === s.sessionId));
      const first = wts[0];
      if (!first) continue;
      const n = new Notification(`${s.name} finished`, { body: `Ready to review: ${wts.map((w) => w.branch || w.path).join(', ')}`, tag: s.sessionId });
      n.onclick = () => { window.focus(); location.hash = `#/${first.id}`; };
    }
  }
  S.prevStatus = new Map(st.sessions.map((s) => [s.sessionId, s.status]));
  for (const w of st.worktrees) {
    for (const k of REVIEWERS) {
      const r = w.codeReviews[k];
      if (S.prevCr?.get(`${w.id} ${k}`) === 'running' && r && r.status !== 'running') {
        const n = new Notification(`${NAMES[k]} finished reviewing ${w.branch || 'a worktree'}`, { body: r.total ? `${r.total} finding${r.total === 1 ? '' : 's'}` : 'No findings', tag: `cr-${w.id}-${k}` });
        n.onclick = () => { window.focus(); location.hash = `#/${w.id}`; };
      }
    }
  }
  S.prevCr = new Map(st.worktrees.flatMap((w) => REVIEWERS.map((k) => [`${w.id} ${k}`, w.codeReviews[k]?.status] as const)));
}

function onState(st: PublicState) {
  // The server was upgraded: this page's code is now out of date too.
  if (S.st && st.version !== S.st.version) { location.reload(); return; }
  const first = !S.st;
  maybeNotify(st);
  S.st = st;
  renderSidebar();
  const wt = curWt();
  if (first) {
    if (!st.onboardedAt && location.hash !== '#/welcome') location.hash = '#/welcome';
    else onHash();
    return;
  }
  if (S.page) {
    const sig = setupSig(st);
    if (sig === S.setupSig) return;
    // The first element of the signature is the CodeRabbit login state (the jobs list on the clean-up page).
    const prevSig = S.setupSig ? (JSON.parse(S.setupSig) as ({ running?: boolean } | null)[]) : null;
    const loginFinished = prevSig?.[0]?.running && !st.coderabbitLogin?.running;
    S.setupSig = sig;
    if (loginFinished) loadIntegrations(true);
    else if (S.page === 'cleanup' || !document.activeElement?.matches('input, select, textarea')) renderMain();
    return;
  }
  const v = S.view;
  if (!wt || !v || v.wtId !== wt.id) { renderMain(); return; }
  if (wt.fingerprint !== v.diff.fingerprint) {
    const typing = [...S.editors.entries()].some(([k, val]) => k !== 'summary' && val !== undefined);
    if (typing) { S.stale = true; renderMain(); } else loadView({ quiet: true });
  } else if (reviewsSig(wt) !== v.crSig) {
    const was = REVIEWERS.map((k) => v.codeReviews?.[k]?.status);
    v.crSig = reviewsSig(wt);
    loadCodeReviews().then(() => {
      const cur = S.view;
      if (!cur) return;
      REVIEWERS.forEach((k, i) => {
        const r = cur.codeReviews?.[k];
        if (was[i] !== 'running' || !r || r.status === 'running') return;
        const n = r.findings.length;
        toast(r.status === 'done' ? `${NAMES[k]} finished: ${n ? `${n} finding${n === 1 ? '' : 's'}` : 'no findings'}` : `${NAMES[k]} review stopped`, r.status === 'failed');
      });
      if (wt.comments.sig !== cur.commentSig) { cur.commentSig = wt.comments.sig; reloadComments(); } else renderMain();
    });
  } else if (wt.comments.sig !== v.commentSig) {
    v.commentSig = wt.comments.sig;
    reloadComments();
  } else if (headerSig(wt) !== v.headerSig && !document.activeElement?.matches('textarea, input')) {
    renderMain();
  }
}

function onLiveMessage(msg: LiveMessage) {
  if (msg.type === 'state') {
    const st = JSON.parse(msg.data) as PublicState;
    need('#conn').textContent = `v${st.version}`;
    need('#conn').className = 'brand-sub';
    onState(st);
  } else {
    need('#conn').textContent = 'server not running — retrying';
    need('#conn').className = 'brand-sub down';
  }
}

export function connect() {
  if ('SharedWorker' in window) {
    try {
      const worker = new SharedWorker('/sse-worker.js', { name: 'worktree-review-live' });
      worker.port.onmessage = (e: MessageEvent<LiveMessage>) => onLiveMessage(e.data);
      worker.port.start();
      window.addEventListener('pagehide', () => worker.port.postMessage('close'));
      return;
    } catch {}
  }
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => { if (e instanceof MessageEvent) onLiveMessage({ type: 'state', data: String(e.data) }); });
  es.onerror = () => onLiveMessage({ type: 'error' });
}
