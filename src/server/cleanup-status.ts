import type { CleanupStatus } from '../shared/api.ts';
import { config } from './config.ts';
import { git, gitOk, run } from './exec.ts';
import { state } from './state.ts';
import type { PRNode, WorktreeRecord } from './types.ts';
import { repoOf } from './worktrees.ts';

export interface StatusOpts { ignoreBusy?: boolean }

function openReviewItems(wtId: string): number {
  return state.comments.filter((c) => c.wtId === wtId && (c.status === 'draft' || c.status === 'pending')).length;
}

export function cleanupStatus(wt: WorktreeRecord, opts?: StatusOpts): CleanupStatus | null {
  if (wt.isMain) return null;
  if (wt.pr?.state === 'MERGED' && wt.branch) return mergedStatus(wt, wt.pr, opts);
  return idleStatus(wt, opts);
}

// Reasons that apply to removing any worktree: what git can't do, and what would be lost.
function commonBlockers(wt: WorktreeRecord, { ignoreBusy = false }: StatusOpts = {}) {
  const reasons: string[] = [], notes: string[] = [];
  let forceable = true;
  const hard = (r: string): void => { reasons.push(r); forceable = false; };
  if (wt.error) hard(wt.error.kind === 'broken-link' ? "git can't read it (broken link to its repository)" : `git can't read it: ${wt.error.message}`);
  if (wt.locked) hard('the worktree is locked');
  if (wt.dirty > 0) {
    const n = `${wt.dirty} file${wt.dirty === 1 ? '' : 's'}`;
    if (wt.dirtyKind === 'deleted-only') notes.push(`${n} missing from disk, but they're still in the branch, so nothing is lost`);
    else if (wt.dirtyKind === 'lockfile-only') reasons.push(`only a lockfile changed (${[...new Set(wt.dirtyFiles.map((f) => f.file.split('/').pop()))].join(', ')}), usually from installing dependencies`);
    else reasons.push(`${n} with uncommitted changes`);
  }
  if (wt.sessions.length) hard(`in use by ${wt.sessions.map((s) => s.name).join(', ')}`);
  if (openReviewItems(wt.id)) reasons.push('has unsent review comments');
  if (wt.busy && !ignoreBusy) hard('being removed right now');
  return { reasons, notes, hard, forceable: () => forceable };
}

const dirtySummary = (wt: WorktreeRecord): CleanupStatus['dirty'] => (wt.dirty ? { kind: wt.dirtyKind ?? null, count: wt.dirty, files: wt.dirtyFiles.slice(0, 20) } : null);

// A worktree no Claude session is using and whose PR hasn't merged. Removing it is only ever
// manual, and its branch is always kept, so the only things at risk are uncommitted files
// and commits on a detached HEAD.
function idleStatus(wt: WorktreeRecord, opts?: StatusOpts): CleanupStatus {
  const { reasons, notes, hard, forceable } = commonBlockers(wt, opts);
  const orphaned = wt.orphaned ?? NaN; // unknown until the worktree has been checked once
  if (Date.now() - wt.lastActivity < 10 * 60_000) hard('changed in the last 10 minutes, so something may still be working in it');
  if (wt.detached && !(orphaned >= 0)) hard("couldn't check whether the commits on its detached HEAD are on a branch");
  else if (orphaned > 0) hard(`${orphaned} commit${orphaned === 1 ? '' : 's'} on its detached HEAD ${orphaned === 1 ? "isn't" : "aren't"} on any branch; create a branch first (git switch -c <name>)`);
  if (wt.branch) {
    const unpushed = Math.min(wt.unpushed ?? NaN, wt.ahead);
    const pushed = unpushed > 0 ? `, ${unpushed === wt.ahead ? (wt.ahead === 1 ? 'not pushed' : 'none of them pushed') : `${unpushed} not pushed`}` : wt.unpushed === 0 ? ', all pushed' : '';
    notes.push(`the branch ${wt.branch} is kept${wt.ahead ? ` with its ${wt.ahead} commit${wt.ahead === 1 ? '' : 's'}${pushed}` : ''}`);
  } else if (orphaned === 0) notes.push('detached HEAD; its commit is on a branch, so nothing is lost');
  if (wt.pr?.state === 'OPEN') notes.push(`PR #${wt.pr.number} is still open; removing the worktree doesn't affect it`);
  return {
    kind: 'idle', eligible: reasons.length === 0, reasons, notes, branchSafe: false,
    forceable: reasons.length > 0 && forceable(), dirty: dirtySummary(wt), unmatched: [], auto: false,
  };
}

function mergedStatus(wt: WorktreeRecord, pr: PRNode, opts?: StatusOpts): CleanupStatus {
  // Removing the worktree only risks uncommitted work; commits live on the branch, which
  // is only deleted when everything on it is in the merged PR.
  // reasons block removal; notes don't, but are worth knowing.
  const { reasons, notes, forceable } = commonBlockers(wt, opts);
  const branchSafe = !!wt.head && (wt.head === pr.headRefOid || wt.headInMerged === true);
  if (!branchSafe) {
    notes.push(wt.headInMerged === null ? 'still checking whether its commits are in the PR; the branch is kept until that is known'
      : wt.unmatched?.length
        ? `the branch is kept: ${wt.unmatched.length} commit${wt.unmatched.length === 1 ? ' has' : 's have'} no matching change in the merged PR (often commits from a stacked parent PR that merged separately)`
        : "the branch is kept: its commits couldn't be matched to the merged PR");
  }
  return {
    kind: 'merged', eligible: reasons.length === 0,
    reasons, notes, branchSafe,
    forceable: reasons.length > 0 && forceable(),
    dirty: dirtySummary(wt),
    unmatched: branchSafe ? [] : (wt.unmatched || []).slice(0, 12),
    auto: config.autoCleanup && Date.parse(pr.mergedAt ?? '') >= state.installedAt,
  };
}

// Is the local branch's work all in the merged PR? Fetches the PR's head if it isn't local yet,
// and matches commits by content so a rebased PR still counts.
export async function checkBranchInPR(wt: WorktreeRecord, pr: PRNode): Promise<void> {
  const repo = repoOf(wt);
  const head = (): string => wt.head ?? ''; // read live: a refresh can move HEAD while this runs
  if (head() === pr.headRefOid) { wt.headInMerged = true; wt.unmatched = []; return; }
  if (!(await gitOk(repo.root, ['cat-file', '-e', `${pr.headRefOid}^{commit}`]))) {
    await run('git', ['fetch', '-q', 'origin', pr.headRefOid], { cwd: repo.root, timeout: 60_000 }).catch(() => {});
    if (!(await gitOk(repo.root, ['cat-file', '-e', `${pr.headRefOid}^{commit}`]))) {
      wt.headInMerged = false;
      wt.unmatched = [];
      return;
    }
  }
  if (await gitOk(wt.path, ['merge-base', '--is-ancestor', head(), pr.headRefOid])) { wt.headInMerged = true; wt.unmatched = []; return; }
  const cherry = await git(wt.path, ['cherry', pr.headRefOid, head()]).catch(() => '');
  const shas = cherry.split('\n').filter((l) => l.startsWith('+ ')).map((l) => l.slice(2).trim());
  const unmatched: { sha: string; subject: string }[] = [];
  wt.unmatched = unmatched;
  for (const sha of shas.slice(0, 50)) {
    const subject = (await git(wt.path, ['log', '-1', '--format=%s', sha]).catch(() => '')).trim();
    unmatched.push({ sha, subject });
  }
  // Every non-merge commit has an equivalent in the PR: the branch was rebased, nothing unique on it.
  wt.headInMerged = shas.length === 0;
}
