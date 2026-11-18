import fs from 'node:fs';
import path from 'node:path';
import type { Comment, PRThread, PRThreadComment, PRThreads, PRThreadsSummary } from '../shared/api.ts';
import { errInfo, git, httpError, run } from './exec.ts';
import { changed, repos, save, state, wts } from './state.ts';
import type { PRThreadsRecord, WorktreeRecord } from './types.ts';
import { asStr, firstLine, log, newId, rec, sha1 } from './util.ts';
import { getWt } from './worktrees.ts';

// ---------- GitHub PR review threads ----------
// Review comments on a worktree's open PR, from CodeRabbit or anyone else, pulled in to read and answer here.
// GitHub can't reach this server, so it polls: each minute one cheap query per repo reads every open PR's
// updatedAt and head, and only a PR where either moved has its threads fetched. For a while after a PR's head
// moves, when CodeRabbit is about to post, it checks more often.

const CHECK_MS = 60_000;
const BURST_MS = 20_000;
const BURST_FOR = 10 * 60_000;
/** Resolving a thread doesn't touch the PR's updatedAt, so threads are fetched at least this often anyway. */
const REFETCH_MS = 10 * 60_000;
const CODERABBIT = 'coderabbitai';

let burstUntil = 0;
export const syncInterval = (): number => (Date.now() < burstUntil ? BURST_MS : CHECK_MS);
const syncing = new Set<string>(); // wtIds being fetched now

// ---------- gh ----------

async function gql(query: string, vars: Record<string, string | number> = {}): Promise<Record<string, unknown>> {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  let out: string;
  try {
    out = await run('gh', args);
  } catch (e) {
    // gh exits non-zero on a GraphQL error, with GitHub's reply on stdout.
    const { stdout, stderr, message, code } = errInfo(e);
    if (code === 'ENOENT') throw new Error('Install the GitHub CLI (gh) to see PR comments.');
    const reply = rec(safeJson(stdout));
    const msg = Array.isArray(reply.errors) ? asStr(rec(reply.errors[0]).message) : undefined;
    throw new Error(msg || firstLine(stderr.trim()) || firstLine(message));
  }
  const reply = rec(safeJson(out));
  if (Array.isArray(reply.errors) && reply.errors.length) throw new Error(asStr(rec(reply.errors[0]).message) || 'GitHub returned an error.');
  return rec(reply.data);
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

// ---------- parsing GitHub's reply ----------

const COMMENT_FIELDS = 'id body createdAt url author { login __typename }';
const THREAD_FIELDS = `id path line startLine originalLine diffSide isResolved isOutdated viewerCanResolve viewerCanUnresolve viewerCanReply
  comments(first: 50) { nodes { ${COMMENT_FIELDS} } }`;

const nodesOf = (v: unknown): unknown[] => { const n = rec(v).nodes; return Array.isArray(n) ? n : []; };
const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);
/** Repeats the replace until nothing changes, so a removal can't join its neighbours into a new match. */
const stripAll = (s: string, re: RegExp): string => {
  for (let prev = ''; prev !== s;) { prev = s; s = s.replace(re, ''); }
  return s;
};
const stripHtmlComments = (s: string): string => stripAll(s, /<!--[\s\S]*?-->/g).trim();

function parseComment(v: unknown): PRThreadComment[] {
  const c = rec(v);
  const author = rec(c.author);
  if (typeof c.id !== 'string' || typeof c.body !== 'string') return [];
  return [{
    id: c.id,
    author: asStr(author.login) || 'ghost',
    bot: author.__typename === 'Bot',
    body: stripHtmlComments(c.body),
    createdAt: Date.parse(asStr(c.createdAt) || '') || 0,
    url: asStr(c.url) || '',
  }];
}

const unfence = (s: string): string => s.trim().replace(/^```[\w-]*\n?/, '').replace(/\n?```$/, '').trim();

/**
 * CodeRabbit's comments follow a pattern: a "_⚠️ Potential issue_ | _🟠 Major_" line, a bold title, the
 * explanation, then <details> blocks for a proposed fix, a committable suggestion and a prompt for AI agents.
 */
export function parseCodeRabbit(body: string): Pick<PRThread, 'severity' | 'title' | 'suggestions' | 'codegen'> & { comment: string } {
  const details = [...body.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)]
    .map((m) => ({ summary: m[1] ?? '', text: m[2] ?? '' }));
  const block = (re: RegExp): string => unfence(details.find((d) => re.test(d.summary))?.text ?? '');
  let head = body.split(/<details>/)[0] ?? '';
  const tag = head.match(/^\s*_[^\n]*_\s*(?:\n|$)/);
  const severity = (tag?.[0].match(/(?<![a-z])(Critical|Major|Minor|Trivial)(?![a-z])/i)?.[1] ?? 'info').toLowerCase();
  if (tag) head = head.slice(tag[0].length);
  const title = head.match(/^\s*\*\*([\s\S]+?)\*\*/);
  if (title) head = head.slice((title.index ?? 0) + title[0].length);
  return {
    severity,
    title: title?.[1]?.trim() ?? '',
    comment: stripAll(head, /<\/?[a-z][^>]*>/gi).trim(),
    suggestions: block(/Committable suggestion/i) || block(/Proposed fix|Suggested fix/i),
    codegen: block(/Prompt for AI Agents/i),
  };
}

function parseThread(v: unknown, prev: PRThread | undefined): PRThread | null {
  const t = rec(v);
  if (typeof t.id !== 'string' || typeof t.path !== 'string') return null;
  const comments = nodesOf(t.comments).flatMap(parseComment);
  const first = comments[0];
  if (!first) return null;
  let extra: Partial<PRThread> = {};
  if (first.author === CODERABBIT) {
    const { comment, ...rest } = parseCodeRabbit(first.body);
    extra = rest;
    first.body = comment || rest.title || first.body;
  }
  return {
    id: t.id, file: t.path, side: t.diffSide === 'LEFT' ? 'old' : 'new',
    line: numOrNull(t.line), startLine: numOrNull(t.startLine), originalLine: numOrNull(t.originalLine),
    localLine: prev?.localLine ?? null,
    isResolved: t.isResolved === true, isOutdated: t.isOutdated === true,
    canResolve: t.viewerCanResolve === true, canUnresolve: t.viewerCanUnresolve === true, canReply: t.viewerCanReply === true,
    comments, ...extra,
    status: prev?.status ?? 'open', commentId: prev?.commentId,
  };
}

// ---------- fetching ----------

async function fetchThreads(wt: WorktreeRecord): Promise<void> {
  const repo = repos.get(wt.repoKey);
  const pr = wt.pr;
  if (!repo?.gh || !pr) return;
  const old = state.prThreads[wt.id];
  const r: PRThreadsRecord = old && old.number === pr.number ? old
    : { number: pr.number, url: pr.url, updatedAt: null, headRefOid: null, fetchedAt: null, error: null, threads: [] };
  state.prThreads[wt.id] = r;
  syncing.add(wt.id);
  changed();
  const query = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) { url updatedAt headRefOid
      reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_FIELDS} } } } } }`;
  try {
    const prev = new Map(r.threads.map((t) => [t.id, t]));
    const threads: PRThread[] = [];
    let after: string | null = null, meta: Record<string, unknown> = {};
    for (let page = 0; page < 10; page++) {
      const vars: Record<string, string | number> = { owner: repo.gh.owner, name: repo.gh.name, number: pr.number };
      if (after) vars.after = after;
      meta = rec(rec((await gql(query, vars)).repository).pullRequest);
      const conn = rec(meta.reviewThreads);
      for (const n of nodesOf(conn)) { const t = parseThread(n, prev.get(asStr(rec(n).id) ?? '')); if (t) threads.push(t); }
      const info = rec(conn.pageInfo);
      after = info.hasNextPage === true ? asStr(info.endCursor) ?? null : null;
      if (!after) break;
    }
    r.threads = threads;
    r.url = asStr(meta.url) || r.url;
    r.updatedAt = asStr(meta.updatedAt) ?? null;
    r.headRefOid = asStr(meta.headRefOid) ?? null;
    r.fetchedAt = Date.now();
    r.error = null;
    await mapLines(wt, r);
  } catch (e) {
    r.error = `Couldn't fetch the PR's comments: ${errInfo(e).message}`;
    log(`PR threads fetch failed for ${wt.path}:`, r.error);
  } finally {
    syncing.delete(wt.id);
    save();
    changed();
  }
}

/** Fetches the threads of every open PR whose updatedAt or head moved since last time. */
export async function syncPRThreads(): Promise<void> {
  for (const repo of repos.values()) {
    if (!repo.gh) continue;
    const open = [...wts.values()].filter((w) => w.repoKey === repo.commonDir && w.pr?.state === 'OPEN');
    if (!open.length) continue;
    const aliases = open.map((w, i) => `p${i}: pullRequest(number: ${w.pr?.number}) { updatedAt headRefOid }`).join('\n');
    let data: Record<string, unknown>;
    try {
      data = rec((await gql(`query { repository(owner: ${JSON.stringify(repo.gh.owner)}, name: ${JSON.stringify(repo.gh.name)}) { ${aliases} } }`)).repository);
    } catch (e) {
      log(`PR threads check failed for ${repo.name}:`, errInfo(e).message);
      continue;
    }
    for (const [i, wt] of open.entries()) {
      const now = rec(data[`p${i}`]);
      const r = state.prThreads[wt.id];
      const head = asStr(now.headRefOid) ?? null;
      // A new head is when CodeRabbit reviews again, so look more often for a while.
      if (r?.headRefOid && head && r.headRefOid !== head) burstUntil = Date.now() + BURST_FOR;
      const stale = !r || r.number !== wt.pr?.number || r.updatedAt !== (asStr(now.updatedAt) ?? null) || r.headRefOid !== head
        || !r.fetchedAt || Date.now() - r.fetchedAt > REFETCH_MS;
      if (stale && !syncing.has(wt.id)) await fetchThreads(wt);
    }
  }
}

/** Fetches one worktree's threads now, e.g. when it's opened or you ask to. */
export async function syncWorktree(wt: WorktreeRecord): Promise<void> {
  if (wt.pr?.state !== 'OPEN') throw httpError(409, 'This worktree has no open PR.');
  if (!syncing.has(wt.id)) await fetchThreads(wt);
}

// ---------- where each thread is now ----------

/** Each file's hunks in a -U0 diff, as [old start, old count, new count]; a deleted file has null. */
function hunksByFile(diff: string): Map<string, number[][] | null> {
  const out = new Map<string, number[][] | null>();
  let from = '', cur: number[][] | null = null;
  for (const l of diff.split('\n')) {
    if (l.startsWith('--- ')) { from = l.slice(4).replace(/^a\//, ''); cur = null; continue; }
    if (l.startsWith('+++ ')) {
      cur = l === '+++ /dev/null' ? null : [];
      out.set(l === '+++ /dev/null' ? from : l.slice(4).replace(/^b\//, ''), cur);
      continue;
    }
    const m = cur && l.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (cur && m) cur.push([Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), m[3] === undefined ? 1 : Number(m[3])]);
  }
  return out;
}

/** Line `n` of the PR's head, moved past the edits made since; null when that line itself was changed. */
export function shiftLine(n: number, hunks: number[][]): number | null {
  let off = 0;
  for (const [a = 0, b = 0, d = 0] of hunks) {
    if (b === 0) { if (n > a) off += d; else break; } // lines added after line a
    else if (n < a) break;
    else if (n < a + b) return null;
    else off += d - b;
  }
  return n + off;
}

/** Works out localLine for each thread: the PR head's line, followed through what changed in the worktree since. */
async function mapLines(wt: WorktreeRecord, r: PRThreadsRecord): Promise<void> {
  r.mappedFp = wt.fingerprint;
  const placed = r.threads.filter((t) => t.side === 'new' && t.line);
  for (const t of r.threads) t.localLine = null;
  if (!placed.length || !r.headRefOid) return;
  const files = [...new Set(placed.map((t) => t.file))];
  let diff: string;
  try {
    diff = await git(wt.path, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', r.headRefOid, '--', ...files]);
  } catch {
    // The PR's head isn't here (not fetched yet): its lines are only right if this is that commit.
    if (wt.head === r.headRefOid) for (const t of placed) t.localLine = t.line;
    return;
  }
  const hunks = hunksByFile(diff);
  for (const t of placed) {
    const h = hunks.get(t.file);
    // Not in the diff: the file is as it was in the PR. Deleted (null): nowhere to put it.
    if (t.line !== null && h !== null) t.localLine = h ? shiftLine(t.line, h) : t.line;
  }
}

// ---------- what the page gets ----------

export function prThreadsSummary(wt: WorktreeRecord): PRThreadsSummary | null {
  const r = state.prThreads[wt.id];
  if (!r || wt.pr?.number !== r.number) return null;
  const isSyncing = syncing.has(wt.id);
  return {
    number: r.number,
    open: r.threads.filter((t) => !t.isResolved && t.status === 'open').length,
    total: r.threads.length,
    syncing: isSyncing,
    error: r.error,
    sig: sha1(JSON.stringify([isSyncing, r.error, r.fetchedAt, r.threads.map((t) => [t.id, t.isResolved, t.status, t.comments.length, t.localLine])])).slice(0, 10),
  };
}

export async function getPRThreads(wt: WorktreeRecord): Promise<PRThreads> {
  const r = state.prThreads[wt.id];
  if (!r || wt.pr?.number !== r.number) {
    return { number: wt.pr?.number ?? 0, url: wt.pr?.url ?? '', fetchedAt: null, syncing: syncing.has(wt.id), error: null, threads: [], claudeReplies: {} };
  }
  if (r.mappedFp !== wt.fingerprint && r.fetchedAt) { await mapLines(wt, r); changed(); }
  const claudeReplies: Record<string, string> = {};
  for (const t of r.threads) {
    const c = t.commentId ? state.comments.find((x) => x.id === t.commentId) : undefined;
    const reply = c?.replies.filter((x) => x.author !== 'you').pop();
    if (reply) claudeReplies[t.id] = reply.body;
  }
  return { number: r.number, url: r.url, fetchedAt: r.fetchedAt, syncing: syncing.has(wt.id), error: r.error, threads: r.threads, claudeReplies };
}

export function getThread(id: string | undefined): { wt: WorktreeRecord; r: PRThreadsRecord; thread: PRThread } {
  for (const [wtId, r] of Object.entries(state.prThreads)) {
    const thread = r.threads.find((t) => t.id === id);
    if (thread) return { wt: getWt(wtId), r, thread };
  }
  throw httpError(404, 'Unknown PR thread');
}

// ---------- answering on GitHub ----------

export async function replyToThread(id: string | undefined, body: string): Promise<PRThread> {
  const { thread } = getThread(id);
  if (!body.trim()) throw httpError(400, 'Empty reply');
  const data = await gql(`mutation($id: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { ${COMMENT_FIELDS} } } }`,
  { id: thread.id, body: body.trim() }).catch((e: unknown) => { throw httpError(502, `GitHub didn't take the reply: ${errInfo(e).message}`); });
  thread.comments.push(...parseComment(rec(rec(data.addPullRequestReviewThreadReply).comment)));
  save();
  changed();
  return thread;
}

export async function setResolved(id: string | undefined, resolved: boolean): Promise<PRThread> {
  const { thread } = getThread(id);
  const op = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  const data = await gql(`mutation($id: ID!) { ${op}(input: { threadId: $id }) { thread { isResolved } } }`, { id: thread.id })
    .catch((e: unknown) => { throw httpError(502, `GitHub didn't ${resolved ? 'resolve' : 'unresolve'} it: ${errInfo(e).message}`); });
  thread.isResolved = rec(rec(data[op]).thread).isResolved === true;
  save();
  changed();
  return thread;
}

// ---------- handing a thread to Claude ----------

const who = (login: string): string => (login === CODERABBIT ? 'CodeRabbit' : `@${login}`);

export function threadToComment(wt: WorktreeRecord, r: PRThreadsRecord, t: PRThread): Comment {
  const [first, ...rest] = t.comments;
  const parts = [`**${first ? who(first.author) : 'A reviewer'} on PR #${r.number}${t.severity ? ` (${t.severity})` : ''}${t.title ? `: ${t.title}` : ''}**`];
  if (first?.body && first.body !== t.title) parts.push(first.body);
  if (t.suggestions) parts.push(`Suggested change:\n\`\`\`\n${t.suggestions}\n\`\`\``);
  if (t.codegen) parts.push(`Fix guidance from CodeRabbit:\n${t.codegen}`);
  if (rest.length) parts.push(`Replies on GitHub:\n${rest.map((c) => `> ${who(c.author)}: ${c.body.replace(/\n/g, '\n> ')}`).join('\n>\n')}`);
  if (t.localLine === null) parts.push(`(On ${t.file}${t.line || t.originalLine ? ` line ${t.line ?? t.originalLine} of the PR` : ''}; that line has changed here since.)`);
  const line = t.localLine ?? t.line ?? t.originalLine ?? 1;
  const c: Comment = {
    id: newId('c'), wtId: wt.id, wtPath: wt.path, file: t.file, line, side: 'new',
    lineText: '', body: parts.join('\n\n'), status: 'draft', createdAt: Date.now(), replies: [], fromThread: t.id,
  };
  try { c.lineText = fs.readFileSync(path.join(wt.path, t.file), 'utf8').split('\n')[line - 1] ?? ''; } catch {}
  state.comments.push(c);
  t.status = 'sent';
  t.commentId = c.id;
  return c;
}
