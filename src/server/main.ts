// Worktree Review — a local, always-on dashboard for reviewing work in git
// worktrees before it becomes a PR. Zero dependencies; needs git and gh.
import fs from 'node:fs';
import { server } from './http.ts';
import { changed, state } from './state.ts';
import { getIntegrations } from './integrations.ts';
import { config } from './config.ts';
import { DATA_DIR, PORT, VERSION } from './paths.ts';
import { startBroadcast } from './public-state.ts';
import { refreshPRs } from './prs.ts';
import { deleteInBackground } from './removal.ts';
import { registerServer } from './jobs.ts';
import { refreshSessions } from './sessions.ts';
import { errInfo } from './exec.ts';
import { log } from './util.ts';
import { offerReviews } from './wake.ts';
import { discoverWorktrees, pollWorktrees } from './worktrees.ts';

// ---------- main loop ----------

async function loop(fn: () => Promise<void>, ms: number | (() => number)): Promise<void> {
  try { await fn(); } catch (e) { log('loop error', errInfo(e).message); }
  setTimeout(() => void loop(fn, ms), typeof ms === 'function' ? ms() : ms);
}

startBroadcast();
registerServer(server);

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') { log(`Port ${PORT} is already in use; another copy is probably running.`); process.exit(0); }
  throw e;
});

server.listen(PORT, '127.0.0.1', async () => {
  log(`Worktree Review ${VERSION} on http://127.0.0.1:${PORT}  (data: ${DATA_DIR})`);
  state.trash = state.trash.filter((p) => fs.existsSync(p));
  for (const p of state.trash) deleteInBackground(p);
  await discoverWorktrees();
  refreshSessions();
  getIntegrations().then(changed, () => {});
  void loop(discoverWorktrees, 30_000);
  void loop(async () => { refreshSessions(); offerReviews(); }, 3_000);
  void loop(pollWorktrees, 1_000);
  setTimeout(() => void loop(refreshPRs, () => config.prPollMinutes * 60_000), 5_000);
});
