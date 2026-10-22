// ---------- background jobs (sidebar progress) ----------
import type { Job } from '../shared/api.ts';
import { renderMain } from './view.ts';
import { $, api, S } from './state.ts';
import { elapsed, elapsedBetween, esc, tilde } from './util.ts';

function jobHtml(j: Job) {
  const pct = j.total ? Math.round((j.done / j.total) * 100) : 100;
  const running = j.status === 'running';
  const verb = j.kind === 'repair' ? 'Repaired' : 'Removed';
  const line = running
    ? `${j.current ? `${j.kind === 'repair' ? 'Repairing' : 'Removing'} <strong>${esc(j.current.branch || tilde(j.current.path))}</strong>` : 'Starting…'} · ${j.done + 1 > j.total ? j.total : j.done + 1} of ${j.total}`
    : `${verb} ${j.ok.length}${j.failed.length ? ` · <span class="bad">${j.failed.length} failed</span>` : ''}`;
  return `<div class="job ${running ? 'running' : j.failed.length ? 'failed' : 'ok'}">
    <div class="job-top"><span class="job-title">${esc(j.title)}</span>
      <span class="muted small">${running ? `<span class="tick" data-start="${j.startedAt}">${elapsed(j.startedAt)}</span>` : elapsedBetween(j.startedAt, j.finishedAt)}</span></div>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${j.total}" aria-valuenow="${j.done}"><div class="fill" style="width:${running ? Math.max(pct, 4) : 100}%"></div></div>
    <div class="job-line">${line}</div>
    ${j.failed.slice(0, 3).map((f) => `<div class="job-fail"><button class="link-btn" data-act="result-open" data-id="${esc(f.id)}">${esc(f.branch || tilde(f.path))}</button>: ${esc(f.error)}</div>`).join('')}
    ${!running ? `<div class="actions">${j.failed.length > 3 || j.ok.length ? `<button class="link-btn" data-act="job-details" data-id="${j.id}">Details</button>` : ''}<span style="flex:1"></span><button class="link-btn" data-act="job-dismiss" data-id="${j.id}">Dismiss</button></div>` : ''}
  </div>`;
}

export function renderJobs() {
  const el = $('#jobs');
  if (!el) return;
  const list = S.st?.jobs || [];
  el.innerHTML = list.map(jobHtml).join('');
  for (const j of list) {
    if (j.status !== 'done' || S.seenJobs.has(j.id)) continue;
    S.seenJobs.add(j.id);
    for (const f of j.failed) S.removeErrors[f.id] = f.error;
    for (const o of j.ok) delete S.removeErrors[o.id];
    if (!j.failed.length) setTimeout(() => api('POST', `/api/jobs/${j.id}/dismiss`).catch(() => {}), 6000);
    if (j.failed.length && S.selId && j.failed.some((f) => f.id === S.selId)) renderMain();
  }
}
