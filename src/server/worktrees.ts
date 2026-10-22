import fs from 'node:fs';
import path from 'node:path';
import type { BaseChoices, DirtyKind } from '../shared/api.ts';
import { explainWorktreeError, git, gitError, httpError } from './exec.ts';
import { discoverRepos } from './repos.ts';
import { changed, repos, state, wts, wtState } from './state.ts';
import type { Repo, WorktreeRecord } from './types.ts';
import { sha1 } from './util.ts';

export function getWt(id: string | undefined): WorktreeRecord {
  const wt = id === undefined ? undefined : wts.get(id);
  if (!wt) throw httpError(404, 'Unknown worktree');
  return wt;
}

export function repoOf(wt: WorktreeRecord): Repo {
  const repo = repos.get(wt.repoKey);
  if (!repo) throw new Error(`Unknown repository for ${wt.path}`);
  return repo;
}

interface ListedWorktree { path: string; head?: string; branch?: string; detached?: boolean; bare?: boolean; locked?: boolean; prunable?: boolean }

function parseWorktreeList(out: string): ListedWorktree[] {
  const list: ListedWorktree[] = [];
  let cur: ListedWorktree | null = null;
  for (const line of out.split('\n')) {
    if (!line) { if (cur) list.push(cur); cur = null; continue; }
    const sp = line.indexOf(' ');
    const k = sp === -1 ? line : line.slice(0, sp);
    const v = sp === -1 ? '' : line.slice(sp + 1);
    if (k === 'worktree') cur = { path: v };
    else if (!cur) continue;
    else if (k === 'HEAD') cur.head = v;
    else if (k === 'branch') cur.branch = v.replace(/^refs\/heads\//, '');
    else if (k === 'detached') cur.detached = true;
    else if (k === 'bare') cur.bare = true;
    else if (k === 'locked') cur.locked = true;
    else if (k === 'prunable') cur.prunable = true;
  }
  if (cur) list.push(cur);
  return list;
}

export async function discoverWorktrees(): Promise<void> {
  await discoverRepos();
  const seen = new Set<string>();
  for (const repo of repos.values()) {
    let list: ListedWorktree[];
    try { list = parseWorktreeList(await git(repo.root, ['worktree', 'list', '--porcelain'])); } catch { continue; }
    list.forEach((w, i) => {
      if (w.bare || w.prunable || !fs.existsSync(w.path)) return;
      const id = sha1(w.path).slice(0, 12);
      seen.add(id);
      let wt = wts.get(id);
      if (!wt) {
        wt = {
          id, path: w.path, repoKey: repo.commonDir, repoName: repo.name, isMain: i === 0,
          branch: null, detached: false, locked: false,
          fingerprint: null, dirty: 0, dirtyFiles: [], lastActivity: 0, ahead: 0, stats: null, nextCheck: 0,
          sessions: [], pr: undefined, headInMerged: null,
        };
        wts.set(id, wt);
        wtState(id, w.path);
      }
      wt.branch = w.branch || null;
      wt.detached = !!w.detached;
      wt.locked = !!w.locked;
    });
  }
  for (const id of wts.keys()) if (!seen.has(id)) wts.delete(id);
  changed();
}

// Nearest local branch that HEAD is stacked on (an ancestor branch not yet on the default base).
async function detectStackBase(wt: WorktreeRecord, repo: Repo): Promise<string | null> {
  if (!wt.branch) return null;
  let out: string;
  try {
    out = await git(wt.path, ['for-each-ref', '--format=%(refname:short)', '--merged', 'HEAD', '--no-merged', repo.defaultBase, 'refs/heads']);
  } catch { return null; }
  let best: string | null = null, bestN = Infinity;
  for (const c of out.split('\n').filter((b) => b && b !== wt.branch).slice(0, 30)) {
    const n = Number((await git(wt.path, ['rev-list', '--count', `${c}..HEAD`])).trim());
    if (n > 0 && n < bestN) { best = c; bestN = n; }
  }
  return best;
}

function resolveBase(wt: WorktreeRecord): { ref: string; source: string } {
  const s = state.worktrees[wt.id];
  if (s?.baseOverride) return { ref: s.baseOverride, source: 'set by you' };
  return automaticBase(wt);
}

/** The base the diff uses unless you pick one: the PR's base, the branch it's stacked on, or the repo default. */
export function automaticBase(wt: WorktreeRecord): { ref: string; source: string } {
  const repo = repoOf(wt);
  if (wt.pr?.baseRefName) return { ref: `origin/${wt.pr.baseRefName}`, source: `PR #${wt.pr.number} base` };
  if (wt.stackBase) return { ref: wt.stackBase, source: 'stacked on' };
  return { ref: repo.defaultBase, source: 'default' };
}

const LOCKFILES = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|go\.sum|composer\.lock)$/;

interface StatusEntry { xy: string; file: string }

// What kind of uncommitted changes these are, which decides whether removing the worktree could lose work.
function classifyDirty(entries: StatusEntry[]): DirtyKind | null {
  if (!entries.length) return null;
  if (entries.every((e) => e.xy === ' D' || e.xy === 'D ')) return 'deleted-only'; // files missing from disk; still in the branch
  if (entries.every((e) => LOCKFILES.test(e.file) && /M/.test(e.xy))) return 'lockfile-only';
  return 'work';
}

export function parseStatus(out: string): StatusEntry[] {
  const parts = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    entries.push({ xy: p.slice(0, 2), file: p.slice(3) });
    if (p[0] === 'R' || p[0] === 'C') i++;
  }
  return entries;
}

export function refreshWorktree(wt: WorktreeRecord, { force = false } = {}): Promise<void> {
  if (wt.checking) return wt.checking;
  const checking = (async () => {
    const repo = repoOf(wt);
    const head = (await git(wt.path, ['rev-parse', 'HEAD'])).trim();
    const status = await git(wt.path, ['status', '--porcelain=v1', '-z']);
    const entries = parseStatus(status);
    let maxMtime = 0;
    const stamps = entries.slice(0, 500).map((e) => {
      try {
        const st = fs.statSync(path.join(wt.path, e.file));
        maxMtime = Math.max(maxMtime, st.mtimeMs);
        return `${st.mtimeMs}:${st.size}`;
      } catch { return 'x'; }
    });
    const headChanged = head !== wt.head;
    if (headChanged) {
      wt.head = head;
      wt.commitTime = Number((await git(wt.path, ['log', '-1', '--format=%ct'])).trim()) * 1000;
      wt.stackBase = await detectStackBase(wt, repo);
      wt.headInMerged = null;
      wt.unmatched = null;
      // Commits no remote has (lost with the branch if it's ever deleted), and, for a detached
      // HEAD, commits on no ref at all (lost with the worktree, since only its HEAD points at them).
      const count = async (args: string[]): Promise<number> => Number((await git(wt.path, ['rev-list', '--count', 'HEAD', '--not', ...args]).catch(() => '-1')).trim());
      wt.unpushed = await count(['--remotes']);
      wt.orphaned = wt.detached ? await count(['--branches', '--remotes', '--tags']) : 0;
    }
    wt.dirty = entries.length;
    wt.dirtyFiles = entries.slice(0, 50).map((e) => ({ xy: e.xy, file: e.file }));
    wt.dirtyKind = classifyDirty(entries);
    const untracked = entries.filter((e) => e.xy === '??').length;
    wt.untracked = untracked;
    wt.lastActivity = Math.max(wt.commitTime || 0, maxMtime);
    const base = resolveBase(wt);
    // The base's commit is part of the state too: pushing, pulling or fetching moves it (e.g. origin/main
    // catching up with a pushed branch) without changing anything in the worktree itself.
    const baseSha = (await git(wt.path, ['rev-parse', '--verify', '--quiet', `${base.ref}^{commit}`]).catch(() => '')).trim();
    const fp = sha1([head, base.ref, baseSha, status, ...stamps].join('|'));
    if (fp !== wt.fingerprint || force) {
      wt.fingerprint = fp;
      wt.baseRef = base.ref;
      wt.baseSource = base.source;
      try {
        const mergeBase = (await git(wt.path, ['merge-base', base.ref, 'HEAD'])).trim();
        wt.mergeBase = mergeBase;
        wt.ahead = Number((await git(wt.path, ['rev-list', '--count', `${mergeBase}..HEAD`])).trim());
        const numstat = await git(wt.path, ['diff', '--numstat', mergeBase]);
        let files = 0, add = 0, del = 0;
        for (const line of numstat.split('\n')) {
          if (!line) continue;
          const [a, d] = line.split('\t');
          files++;
          add += Number(a) || 0;
          del += Number(d) || 0;
        }
        wt.stats = { files: files + untracked, add, del };
        wt.baseError = null;
      } catch {
        wt.mergeBase = null;
        wt.ahead = 0;
        wt.stats = null;
        wt.baseError = `Couldn't diff against ${base.ref}`;
      }
      changed();
    }
  })().finally(() => { wt.checking = null; });
  wt.checking = checking;
  return checking;
}

function isActive(wt: WorktreeRecord): boolean {
  return wt.sessions.length > 0 || Date.now() - wt.lastActivity < 2 * 3600_000;
}

export async function pollWorktrees(): Promise<void> {
  const now = Date.now();
  const due = [...wts.values()].filter((w) => w.nextCheck <= now && !w.checking);
  await Promise.all(due.map(async (wt) => {
    wt.nextCheck = now + (isActive(wt) ? 3_000 : 60_000);
    try {
      await refreshWorktree(wt);
      if (wt.error) { wt.error = null; changed(); }
    } catch (e) {
      const err = explainWorktreeError(gitError(e));
      if (wt.error?.detail !== err.detail) { wt.error = err; changed(); }
    }
  }));
}

/** What the "Compare with" menu offers: the automatic base, then recently used local and remote branches. */
export async function baseChoices(wt: WorktreeRecord): Promise<BaseChoices> {
  const refs = async (prefix: string, n: number) => (await git(wt.path, ['for-each-ref', '--sort=-committerdate', `--count=${n}`, '--format=%(refname:short)', prefix]).catch(() => ''))
    .split('\n').filter((r) => r && r !== wt.branch && !r.endsWith('/HEAD'));
  const [branches, remotes] = await Promise.all([refs('refs/heads', 25), refs('refs/remotes', 25)]);
  return { automatic: automaticBase(wt), current: { ref: wt.baseRef ?? '', source: wt.baseSource ?? '' }, branches, remotes };
}
