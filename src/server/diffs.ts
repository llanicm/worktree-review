import fs from 'node:fs';
import path from 'node:path';
import type { BlameResponse, BlameRun, Commit, CommitDiff, CommitsDiff, DiffResponse, FullDiff } from '../shared/api.ts';
import { git, gitOk, httpError } from './exec.ts';
import { TMP_DIR } from './paths.ts';
import { wtState } from './state.ts';
import type { WorktreeRecord } from './types.ts';
import { refreshWorktree } from './worktrees.ts';

async function snapshotTree(wt: WorktreeRecord): Promise<string> {
  if (wt.snap && wt.snap.fp === wt.fingerprint) return wt.snap.tree;
  const fp = wt.fingerprint;
  const index = path.resolve(wt.path, (await git(wt.path, ['rev-parse', '--git-path', 'index'])).trim());
  const tmp = path.join(TMP_DIR, `${wt.id}-${Date.now()}.index`);
  try {
    try { fs.copyFileSync(index, tmp); } catch {}
    // A throwaway index captures the working tree, untracked files included,
    // without touching the real index Claude or you may be using.
    const env = { GIT_INDEX_FILE: tmp };
    await git(wt.path, ['add', '-A'], { env });
    const tree = (await git(wt.path, ['write-tree'], { env })).trim();
    wt.snap = { fp, tree };
    return tree;
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(tmp + '.lock', { force: true });
  }
}

// Diffs only change when the worktree's fingerprint does (HEAD, base, working tree), so each
// piece of git work is done once per fingerprint and shared by every request that needs it,
// including ones that arrive while it's still running. A failure isn't kept.
function memo<T>(wt: WorktreeRecord, key: string, fn: () => Promise<T>): Promise<T> {
  if (wt.memo?.fp !== wt.fingerprint) wt.memo = { fp: wt.fingerprint, results: new Map() };
  const results = wt.memo.results;
  let p = results.get(key) as Promise<T> | undefined;
  if (!p) {
    p = fn();
    results.set(key, p);
    p.catch(() => { if (results.get(key) === p) results.delete(key); });
  }
  return p;
}

const DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/'];
const MAX_DIFF = 30 * 1024 * 1024;

async function branchCommits(wt: WorktreeRecord, mergeBase: string): Promise<Commit[]> {
  // Oldest first, so commit #1 is where the branch starts.
  // Unit/record separators, because commit bodies span several lines.
  return (await git(wt.path, ['log', '--reverse', '--format=%H%x1f%ct%x1f%an%x1f%s%x1f%b%x1e', `${mergeBase}..HEAD`]))
    .split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r, i) => {
      const [sha = '', ct, author = '', subject = '', body = ''] = r.split('\x1f');
      return { n: i + 1, sha, time: Number(ct) * 1000, author, subject, body: body.trim() };
    });
}

// Which commits touched each file (by commit number), plus 0 for uncommitted changes.
async function fileCommitMap(wt: WorktreeRecord, mergeBase: string, commits: Commit[], tree: string): Promise<Record<string, number[]>> {
  const map: Record<string, number[]> = {};
  const byShaN = new Map(commits.map((c) => [c.sha, c.n]));
  if (commits.length) {
    const out = await git(wt.path, ['log', '--reverse', '--format=@%H', '--name-only', '-M', `${mergeBase}..HEAD`]);
    let n: number | null | undefined = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('@')) n = byShaN.get(line.slice(1));
      else if (line && n) {
        const nums = (map[line] ||= []);
        if (!nums.includes(n)) nums.push(n);
      }
    }
  }
  const dirty = await git(wt.path, ['diff', '--name-only', '-M', 'HEAD', tree]);
  for (const f of dirty.split('\n').filter(Boolean)) (map[f] ||= []).push(0);
  return map;
}

// Per-line attribution for the working version of each changed file: runs of
// [startLine, endLine, commitNumber], where 0 means not committed yet.
async function blameWorktree(wt: WorktreeRecord, mergeBase: string, files: string[], commits: Commit[]): Promise<Record<string, BlameRun[]>> {
  const byShaN = new Map(commits.map((c) => [c.sha, c.n]));
  const result: Record<string, BlameRun[]> = {};
  await Promise.all(files.slice(0, 200).map(async (file) => {
    const abs = path.join(wt.path, file);
    try { if (fs.statSync(abs).size > 2 * 1024 * 1024) return; } catch { return; }
    let out: string;
    try { out = await git(wt.path, ['blame', '--porcelain', '--contents', abs, `${mergeBase}..`, '--', file], { timeout: 20_000 }); } catch { return; }
    const runs: BlameRun[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
      if (!m) continue;
      const sha = m[1] ?? '';
      const n = /^0{40}$/.test(sha) ? 0 : byShaN.get(sha);
      if (n === undefined) continue; // from before the branch
      const ln = Number(m[2]);
      const last = runs[runs.length - 1];
      if (last && last[2] === n && last[1] === ln - 1) last[1] = ln; else runs.push([ln, ln, n]);
    }
    if (runs.length) result[file] = runs;
  }));
  return result;
}

export async function getBlame(wt: WorktreeRecord): Promise<BlameResponse> {
  await refreshWorktree(wt);
  const mergeBase = wt.mergeBase;
  if (!mergeBase) throw httpError(409, wt.baseError || 'No merge base');
  return blameFor(wt, mergeBase);
}

function blameFor(wt: WorktreeRecord, mergeBase: string): Promise<BlameResponse> {
  const fp = wt.fingerprint;
  return memo(wt, `blame:${mergeBase}`, async () => {
    const [tree, commits] = await Promise.all([snapshot(wt), commitsFor(wt, mergeBase)]);
    const files = (await git(wt.path, ['diff', '--name-only', '--diff-filter=d', '-M', mergeBase, tree])).split('\n').filter(Boolean);
    return { fingerprint: fp, lines: await blameWorktree(wt, mergeBase, files, commits) };
  });
}

const snapshot = (wt: WorktreeRecord) => memo(wt, 'tree', () => snapshotTree(wt));
const commitsFor = (wt: WorktreeRecord, mergeBase: string) => memo(wt, `commits:${mergeBase}`, () => branchCommits(wt, mergeBase));

// Each commit's own diff (a merge against its first parent), from one `git log -p` rather than a
// git process per commit. Falls back to one `git diff` per commit on a git too old for
// --diff-merges (before 2.31).
async function perCommitDiffs(wt: WorktreeRecord, shown: Commit[]): Promise<Map<string, string>> {
  const byCommit = new Map<string, string>();
  const first = shown[0], last = shown[shown.length - 1];
  if (!first || !last) return byCommit;
  try {
    const out = await git(wt.path, ['log', ...DIFF_ARGS.slice(1), '-p', '--diff-merges=first-parent', '--format=%x00%H', `${first.sha}^..${last.sha}`]);
    for (const chunk of out.split('\0')) {
      const nl = chunk.indexOf('\n');
      if (nl === -1) continue;
      byCommit.set(chunk.slice(0, nl), chunk.slice(nl + 1).replace(/^\n/, ''));
    }
    if (shown.every((c) => byCommit.has(c.sha))) return byCommit;
  } catch {}
  byCommit.clear();
  for (const c of shown) byCommit.set(c.sha, await git(wt.path, [...DIFF_ARGS, `${c.sha}^`, c.sha]).catch(() => ''));
  return byCommit;
}

async function getCommitDiffs(wt: WorktreeRecord, tree: string, commits: Commit[]): Promise<{ commits: CommitDiff[]; hiddenCommits: number; uncommitted: string }> {
  const shown = commits.slice(-100);
  const [byCommit, uncommitted] = await Promise.all([perCommitDiffs(wt, shown), git(wt.path, [...DIFF_ARGS, 'HEAD', tree])]);
  let budget = MAX_DIFF;
  const out: CommitDiff[] = [];
  for (const c of shown) {
    const diff = budget > 0 ? byCommit.get(c.sha) ?? '' : '';
    budget -= diff.length;
    out.push({ ...c, diff: diff.slice(0, Math.max(0, budget + diff.length)), truncated: budget < 0 });
  }
  return { commits: out, hiddenCommits: commits.length - shown.length, uncommitted: uncommitted.slice(0, MAX_DIFF) };
}

export async function getDiff(wt: WorktreeRecord, mode: string | null): Promise<DiffResponse> {
  await refreshWorktree(wt);
  const mergeBase = wt.mergeBase;
  if (!mergeBase) throw httpError(409, wt.baseError || 'No merge base');
  const s = wtState(wt.id, wt.path);
  const reviewedTree = s.reviewedTree;
  const [tree, commits, sinceAvailable] = await Promise.all([
    snapshot(wt),
    commitsFor(wt, mergeBase),
    reviewedTree ? memo(wt, `has:${reviewedTree}`, () => gitOk(wt.path, ['cat-file', '-e', `${reviewedTree}^{tree}`])) : Promise.resolve(false),
  ]);
  let from = mergeBase;
  if (mode === 'since' && sinceAvailable) from = reviewedTree ?? from;
  const base = {
    sinceAvailable, reviewedAt: s.reviewedAt || null,
    fingerprint: wt.fingerprint, tree, mergeBase,
    baseRef: wt.baseRef, baseSource: wt.baseSource, commits,
    viewed: s.viewed || {},
  };
  // The client asks for blame once the diff arrives, so start it as soon as the diff is done.
  const warmBlame = <T>(r: T): T => { setImmediate(() => blameFor(wt, mergeBase).catch(() => {})); return r; };
  if (mode === 'commits') {
    const result: CommitsDiff = { ...base, mode: 'commits', ...(await memo(wt, `bycommit:${mergeBase}`, () => getCommitDiffs(wt, tree, commits))) };
    return warmBlame(result);
  }
  const [diff, fileCommits] = await Promise.all([
    memo(wt, `diff:${from}`, () => git(wt.path, [...DIFF_ARGS, from, tree])),
    memo(wt, `files:${mergeBase}`, () => fileCommitMap(wt, mergeBase, commits, tree)),
  ]);
  const result: FullDiff = {
    fileCommits,
    ...base,
    mode: from === mergeBase ? 'full' : 'since',
    truncated: diff.length > MAX_DIFF,
    diff: diff.slice(0, MAX_DIFF),
  };
  return warmBlame(result);
}
