import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { RepairResult } from '../shared/api.ts';
import { cleanupStatus } from './cleanup-status.ts';
import { errInfo, explainWorktreeError, git, gitError, httpError, run } from './exec.ts';
import { refreshSessions } from './sessions.ts';
import { changed, save, state, wts } from './state.ts';
import type { Repo, WorktreeRecord } from './types.ts';
import { log } from './util.ts';
import { parseStatus, refreshWorktree, repoOf } from './worktrees.ts';

export async function removeWorktree(wt: WorktreeRecord, how: 'auto' | 'manual', { force = false } = {}): Promise<void> {
  const repo = repoOf(wt);
  refreshSessions();
  try {
    await refreshWorktree(wt, { force: true });
    wt.error = null;
  } catch (e) {
    wt.error = explainWorktreeError(gitError(e));
    changed();
  }
  const cs = cleanupStatus(wt, { ignoreBusy: true });
  if (!cs) throw new Error("The repository's main checkout can't be removed.");
  if (!cs.eligible && !(force && cs.forceable)) throw new Error(`Not safe to remove: ${cs.reasons.join('; ')}.`);
  await detachWorktree(wt, repo, { force: force || wt.dirtyKind === 'deleted-only' });
  let branchDeleted = false;
  let branchKept: string | null = null;
  if (cs.kind === 'idle') branchKept = wt.branch ? 'kept: it isn\'t merged' : null;
  else if (force) branchKept = 'kept because the worktree was removed with uncommitted changes';
  else if (!cs.branchSafe) branchKept = cs.notes.find((n) => n.startsWith('the branch is kept')) || 'kept: not all of its commits are in the merged PR';
  else {
    try {
      if (!wt.branch) throw new Error('no branch'); // a merged worktree always has one
      const tip = (await git(repo.root, ['rev-parse', `refs/heads/${wt.branch}`])).trim();
      if (tip === wt.head) { await git(repo.root, ['branch', '-D', wt.branch]); branchDeleted = true; }
      else branchKept = 'kept: the branch has moved since it was checked';
    } catch {}
  }
  await git(repo.root, ['worktree', 'prune']).catch(() => {});
  state.cleaned.unshift({
    path: wt.path, branch: wt.branch, sha: wt.head ?? '', repoRoot: repo.root, how: force ? 'forced' : how, branchDeleted, branchKept, at: Date.now(),
    lostFiles: force ? wt.dirtyFiles.map((f) => f.file) : undefined, reason: cs.kind,
    pr: wt.pr ? { number: wt.pr.number, url: wt.pr.url, title: wt.pr.title, state: wt.pr.state } : null,
  });
  state.cleaned = state.cleaned.slice(0, 100);
  delete state.worktrees[wt.id];
  wts.delete(wt.id);
  log(`removed worktree ${wt.path} (${how}, ${cs.kind === 'merged' ? `PR #${wt.pr?.number} merged` : 'no session using it'})`);
  save();
  changed();
}

// Deleting a worktree's files is the slow part of removing it: a JS repo's node_modules is
// often 100k+ files. So once it's checked, the folder is renamed aside (instant), git forgets
// the worktree, and the files are deleted in the background.
async function detachWorktree(wt: WorktreeRecord, repo: Repo, { force }: { force: boolean }): Promise<void> {
  // Submodules have their own checkouts to protect, so leave those to git.
  if (fs.existsSync(path.join(wt.path, '.gitmodules'))) {
    try {
      await run('git', ['worktree', 'remove', ...(force ? ['--force'] : []), wt.path], { cwd: repo.root });
    } catch (e) {
      throw httpError(409, `Git refused to remove it: ${explainWorktreeError(gitError(e)).message}`);
    }
    return;
  }
  // The same check `git worktree remove` makes: nothing modified or untracked (ignored files don't count),
  // done again right before the move so nothing that appeared since the last check is lost.
  if (!force) {
    const entries = parseStatus(await git(wt.path, ['status', '--porcelain=v1', '-z']));
    if (entries.length) throw httpError(409, `Git found ${entries.length} modified or untracked file${entries.length === 1 ? '' : 's'} in it just now, so it wasn't removed.`);
  }
  const aside = path.join(path.dirname(wt.path), `.${path.basename(wt.path)}.removing-${Date.now()}`);
  try {
    fs.renameSync(wt.path, aside);
  } catch (e) {
    const { code, message } = errInfo(e);
    if (code !== 'EXDEV') throw httpError(409, `Couldn't move it aside to delete it: ${message}`);
    await run('git', ['worktree', 'remove', '--force', wt.path], { cwd: repo.root, timeout: 600_000 });
    return;
  }
  // Its folder is gone from where git expects it, so prune drops git's record of it.
  await git(repo.root, ['worktree', 'prune']);
  state.trash.push(aside);
  save();
  deleteInBackground(aside);
}

export function deleteInBackground(p: string): void {
  const done = (): void => {
    state.trash = state.trash.filter((t) => t !== p);
    save();
  };
  if (process.platform === 'win32') {
    fs.promises.rm(p, { recursive: true, force: true, maxRetries: 3 }).then(done, (e) => log('background delete failed', p, errInfo(e).message));
    return;
  }
  // A separate process, so the delete finishes even if the server restarts. Leftovers are retried at startup.
  const child = spawn('rm', ['-rf', p], { detached: true, stdio: 'ignore' });
  child.on('exit', (code) => (code === 0 ? done() : log('background delete failed', p, `rm exited ${code}`)));
  child.unref();
}

// `git worktree repair` rewrites the links between a repository and its worktrees after either moves.
export async function repairWorktrees(list: WorktreeRecord[]): Promise<RepairResult> {
  const fixed: RepairResult['fixed'] = [], failed: RepairResult['failed'] = [];
  for (const wt of list) {
    const repo = repoOf(wt);
    try {
      await run('git', ['worktree', 'repair', wt.path], { cwd: repo.root });
      wt.error = null;
      await refreshWorktree(wt, { force: true });
      fixed.push({ path: wt.path, branch: wt.branch });
      log(`repaired worktree link ${wt.path}`);
    } catch (e) {
      const err = explainWorktreeError(gitError(e));
      wt.error = err;
      failed.push({ id: wt.id, path: wt.path, branch: wt.branch, error: err.message });
    }
  }
  changed();
  return { fixed, failed };
}
