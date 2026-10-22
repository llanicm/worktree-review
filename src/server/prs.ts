import type { PRState } from '../shared/api.ts';
import { cleanupStatus, checkBranchInPR } from './cleanup-status.ts';
import { errInfo, run } from './exec.ts';
import { removeWorktree } from './removal.ts';
import { changed, repos, wts } from './state.ts';
import type { PRNode } from './types.ts';
import { firstLine, isRecord, log, rec } from './util.ts';

// ---------- GitHub PRs & cleanup ----------

export let prError: string | null = null;

// The GraphQL reply is gh's, so each PR node is checked as it's picked out.
const isPRState = (v: unknown): v is PRState => v === 'OPEN' || v === 'CLOSED' || v === 'MERGED';
function prNode(v: unknown): PRNode | null {
  const nodes = rec(v).nodes;
  const n = rec(Array.isArray(nodes) ? nodes[0] : undefined);
  const { number, state, isDraft, url, title, headRefOid, mergedAt, baseRefName } = n;
  if (typeof number !== 'number' || !isPRState(state) || typeof isDraft !== 'boolean' || typeof url !== 'string'
    || typeof title !== 'string' || typeof headRefOid !== 'string' || (mergedAt !== null && typeof mergedAt !== 'string') || typeof baseRefName !== 'string') return null;
  return { number, state, isDraft, url, title, headRefOid, mergedAt, baseRefName };
}

export async function refreshPRs(): Promise<void> {
  for (const repo of repos.values()) {
    if (!repo.gh) continue;
    const repoWts = [...wts.values()].filter((w) => w.repoKey === repo.commonDir && w.branch && !w.isMain);
    const branches = [...new Set(repoWts.flatMap((w) => (w.branch ? [w.branch] : [])))];
    if (!branches.length) continue;
    const fields = 'nodes { number state isDraft url title headRefOid mergedAt baseRefName }';
    const aliases = branches.map((b, i) =>
      `b${i}: pullRequests(headRefName: ${JSON.stringify(b)}, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { ${fields} }`).join('\n');
    const query = `query { repository(owner: ${JSON.stringify(repo.gh.owner)}, name: ${JSON.stringify(repo.gh.name)}) { ${aliases} } }`;
    try {
      const reply: unknown = JSON.parse(await run('gh', ['api', 'graphql', '-f', `query=${query}`]));
      const data = rec(rec(reply).data).repository;
      if (!isRecord(data)) throw new Error('Unexpected reply from gh');
      const byBranch = new Map(branches.map((b, i) => [b, prNode(data[`b${i}`])]));
      for (const wt of repoWts) {
        const pr = wt.branch === null ? null : byBranch.get(wt.branch) ?? null;
        if (JSON.stringify(pr) !== JSON.stringify(wt.pr)) {
          wt.pr = pr;
          wt.headInMerged = null;
          wt.nextCheck = 0; // the PR base may change the diff base
          changed();
        }
      }
      prError = null;
    } catch (e) {
      const { message: msg, code } = errInfo(e);
      prError = code === 'ENOENT' ? 'Install the GitHub CLI (gh) to see PR status and clean up merged worktrees.'
        : /auth|login|401/i.test(msg) ? 'Run `gh auth login` to see PR status and clean up merged worktrees.'
        : `Couldn't fetch PR status for ${repo.name}.`;
      log(`PR refresh failed for ${repo.name}:`, firstLine(msg));
      changed();
    }
  }
  await runCleanup();
}

async function runCleanup(): Promise<void> {
  for (const wt of [...wts.values()]) {
    const pr = wt.pr;
    if (!pr || pr.state !== 'MERGED' || wt.isMain || !wt.head) continue;
    if (wt.headInMerged === null && !wt.error) {
      await checkBranchInPR(wt, pr).catch((e: unknown) => log('branch check failed', wt.path, errInfo(e).message));
      changed();
    }
    const cs = cleanupStatus(wt);
    if (cs?.kind === 'merged' && cs.eligible && cs.auto && !wt.busy) {
      try { await removeWorktree(wt, 'auto'); } catch (e) { log('auto-cleanup skipped', wt.path, errInfo(e).message); }
    }
  }
}
