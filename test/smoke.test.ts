// End-to-end check of the server against the demo (extras/demo/demo.mjs): every API route,
// the removal rules, hook delivery, the security checks, and the page rendering in Chrome.
// Run with: npm test  (needs Node 22.18+ to run TypeScript directly; Chrome for the page check)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openPage } from './cdp.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.WTR_TEST_PORT || 4849);
const BASE = `http://127.0.0.1:${PORT}`;
const DEMO = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wtr-smoke-'));

type Json = any;
async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = { 'x-wtr': '1' }): Promise<{ status: number; json: Json }> {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Json = text;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const get = async (p: string) => (await api('GET', p)).json;
const post = async (p: string, body: unknown = {}) => {
  const r = await api('POST', p, body);
  assert.equal(r.status, 200, `POST ${p} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}
const state = () => get('/api/state');
const wtBy = async (branch: string) => (await state()).worktrees.find((w: Json) => w.branch === branch);
const repo = path.join(DEMO, 'home', 'code', 'shop');
const branches = () => execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean);

before(async () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'extras', 'demo', 'demo.mjs'), DEMO], { env: { ...process.env, WTR_PORT: String(PORT) }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  await until(async () => {
    const reviews = (await state()).worktrees.find((w: Json) => w.branch === 'feat/checkout-discounts')?.codeReviews;
    return reviews?.coderabbit?.status === 'done' && reviews?.claude?.status === 'done';
  }, 'the demo CodeRabbit and Claude reviews');
});

after(async () => {
  await api('POST', '/api/shutdown').catch(() => {});
  for (const pid of fs.readFileSync(path.join(DEMO, 'pids'), 'utf8').split('\n').filter(Boolean)) {
    try { process.kill(Number(pid)); } catch {}
  }
  await sleep(300);
  fs.rmSync(DEMO, { recursive: true, force: true });
});

test('state lists the demo worktrees, sessions and PRs', async () => {
  const st = await state();
  assert.match(st.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(st.repos.map((r: Json) => [r.name, r.github]), [['shop', 'acme/shop']]);
  assert.equal(st.sessions.length, 3);
  const by = Object.fromEntries(st.worktrees.map((w: Json) => [w.branch, w]));
  assert.deepEqual(Object.keys(by).sort(), ['chore/upgrade-node', 'feat/checkout-discounts', 'feat/search-filters', 'fix/tax-rounding', 'main', 'refactor/api-client', 'spike/graphql-gateway']);
  assert.ok(by.main.isMain);
  assert.deepEqual(by['feat/checkout-discounts'].sessions.map((s: Json) => s.name), ['shop-checkout']);
  assert.deepEqual(by['feat/search-filters'].sessions.map((s: Json) => s.name).sort(), ['shop-main', 'shop-search'], 'a session that went in with cd works there');
  assert.deepEqual(by['refactor/api-client'].sessions, [], 'only reading or mentioning a worktree is not working in it');
  // A running subagent counts as working where it works, under the session that started it; a finished one doesn't.
  assert.deepEqual(by['fix/tax-rounding'].sessions, []);
  assert.deepEqual(by['fix/tax-rounding'].agents.map((a: Json) => [a.parent.name, a.description, a.agentType]), [['shop-main', 'Round tax per line item', 'general-purpose']]);
  assert.deepEqual(by['spike/graphql-gateway'].agents, []);
  assert.deepEqual(by.main.agents, []);
  assert.equal(by['feat/checkout-discounts'].ahead, 3);
  assert.equal(by['feat/checkout-discounts'].dirty, 1);
  assert.deepEqual(by['feat/checkout-discounts'].comments.draft, 1);
  assert.deepEqual(by['feat/checkout-discounts'].comments.open, 1);
  assert.equal(by['feat/checkout-discounts'].codeReviews.coderabbit.open, 2);
  assert.equal(by['feat/checkout-discounts'].codeReviews.claude.open, 1);
  assert.equal(st.claudeReady, true);
  assert.equal(by['fix/tax-rounding'].pr.state, 'OPEN');
  assert.equal(by['chore/upgrade-node'].pr.state, 'MERGED');
  assert.equal(by['refactor/api-client'].dirtyKind, 'lockfile-only');
  assert.equal(st.cleaned.length, 1);
});

test('cleanup status explains each worktree', async () => {
  const by = Object.fromEntries((await state()).worktrees.map((w: Json) => [w.branch, w.cleanup]));
  assert.equal(by.main, null);
  assert.deepEqual([by['chore/upgrade-node'].kind, by['chore/upgrade-node'].eligible, by['chore/upgrade-node'].branchSafe, by['chore/upgrade-node'].auto], ['merged', true, true, false]);
  assert.deepEqual([by['refactor/api-client'].kind, by['refactor/api-client'].eligible, by['refactor/api-client'].forceable], ['merged', false, true]);
  assert.match(by['refactor/api-client'].reasons[0], /lockfile/);
  assert.deepEqual([by['spike/graphql-gateway'].kind, by['spike/graphql-gateway'].eligible], ['idle', true]);
  assert.match(by['spike/graphql-gateway'].notes[0], /kept with its 1 commit, not pushed/);
  assert.equal(by['feat/checkout-discounts'].eligible, false);
  assert.ok(by['feat/checkout-discounts'].reasons.some((r: string) => /in use by shop-checkout/.test(r)));
  assert.ok(by['fix/tax-rounding'].notes.some((n: string) => /PR #42 is still open/.test(n)));
  assert.ok(by['fix/tax-rounding'].reasons.some((r: string) => /in use by a subagent of shop-main/.test(r)));
});

test('diffs: full, by commit, blame', async () => {
  const wt = await wtBy('feat/checkout-discounts');
  const full = await get(`/api/worktrees/${wt.id}/diff?mode=full`);
  assert.equal(full.mode, 'full');
  assert.equal(full.commits.length, 3);
  assert.deepEqual(full.commits.map((c: Json) => c.subject), ['Add discount codes', 'Apply discount codes at checkout', 'Test expired and fixed-amount codes']);
  assert.match(full.commits[1].body, /subtotal before tax/);
  const files = [...full.diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m: Json) => m[1]).sort();
  assert.deepEqual(files, ['src/checkout.ts', 'src/discounts.ts', 'test/discounts.test.ts']);
  assert.deepEqual(full.fileCommits['src/checkout.ts'], [2, 0]);
  assert.equal(full.sinceAvailable, false);
  const byCommit = await get(`/api/worktrees/${wt.id}/diff?mode=commits`);
  assert.equal(byCommit.mode, 'commits');
  assert.equal(byCommit.commits.length, 3);
  assert.match(byCommit.commits[0].diff, /src\/discounts\.ts/);
  assert.match(byCommit.uncommitted, /DiscountError/);
  const blame = await get(`/api/worktrees/${wt.id}/blame`);
  assert.equal(blame.fingerprint, full.fingerprint);
  assert.ok(blame.lines['src/discounts.ts']);
  // Runs of [firstLine, lastLine, commitNumber]; uncommitted lines are commit 0.
  assert.ok(blame.lines['src/checkout.ts'].some((r: number[]) => r[2] === 0), 'uncommitted lines are commit 0');
  assert.ok(blame.lines['src/discounts.ts'].every((r: number[]) => r[2] === 1));
  // Full-history blame of one file: lines from before the branch, from its commits, and uncommitted.
  const fb = await get(`/api/worktrees/${wt.id}/blame/file?path=src/checkout.ts`);
  const who = (ln: number) => fb.commits[fb.runs.find((r: Json) => r[0] <= ln && ln <= r[1])[2]];
  assert.equal(who(1).n, null, 'line 1 is from before the branch');
  assert.equal(who(1).summary, 'Initial shop: cart and checkout');
  assert.equal(who(1).author, 'Sam Rivera');
  assert.equal(who(3).n, 2, "the discounts import came in commit #2");
  assert.equal(who(5).n, 0, 'the DiscountError class is uncommitted');
  assert.equal(who(5).summary, 'Not committed yet');
  assert.equal((await api('GET', `/api/worktrees/${wt.id}/blame/file?path=../../etc/passwd`)).status, 400);
  assert.equal((await api('GET', `/api/worktrees/${wt.id}/blame/file?path=nope.ts`)).status, 404);
  const missing = await api('GET', '/api/worktrees/nope/diff');
  assert.equal(missing.status, 404);
});

test('pushing a branch (its base moving) updates the diff', async () => {
  const wt = await wtBy('feat/search-filters');
  assert.equal(wt.ahead, 2);
  const before = execFileSync('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: repo, encoding: 'utf8' }).trim();
  const head = execFileSync('git', ['rev-parse', 'feat/search-filters'], { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: repo });
  try {
    await until(async () => (await wtBy('feat/search-filters')).ahead === 0, 'the diff to notice origin/main moved');
    assert.equal((await get(`/api/worktrees/${wt.id}/diff?mode=full`)).diff, '');
  } finally {
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', before], { cwd: repo });
    await until(async () => (await wtBy('feat/search-filters')).ahead === 2, 'origin/main to be put back');
  }
});

test('reviewed marks and since-last-review', async () => {
  const wt = await wtBy('feat/search-filters');
  const full = await get(`/api/worktrees/${wt.id}/diff?mode=full`);
  await post(`/api/worktrees/${wt.id}/reviewed`, { tree: full.tree, fingerprint: full.fingerprint });
  const since = await get(`/api/worktrees/${wt.id}/diff?mode=since`);
  assert.equal(since.sinceAvailable, true);
  assert.equal(since.mode, 'since');
  assert.equal(since.diff, '');
  assert.equal((await wtBy('feat/search-filters')).review.needsReview, false);
  await post(`/api/worktrees/${wt.id}/viewed`, { file: 'src/cart.ts', viewed: true, hash: 'abc' });
  assert.equal((await get(`/api/worktrees/${wt.id}/diff?mode=full`)).viewed['src/cart.ts'], 'abc');
});

test('base override', async () => {
  const wt = await wtBy('feat/search-filters');
  assert.equal((await api('POST', `/api/worktrees/${wt.id}/base`, { base: 'no-such-ref' })).status, 400);
  await post(`/api/worktrees/${wt.id}/base`, { base: 'main' });
  assert.equal((await wtBy('feat/search-filters')).baseSource, 'set by you');
  await post(`/api/worktrees/${wt.id}/base`, { base: '' });
  assert.notEqual((await wtBy('feat/search-filters')).baseSource, 'set by you');
});

test('comments: create, edit, reply, resolve, reopen, delete', async () => {
  const wt = await wtBy('feat/search-filters');
  const c = await post('/api/comments', { wtId: wt.id, file: 'src/search.ts', side: 'new', line: 4, lineText: 'x', body: '  Tidy this  ' });
  assert.equal(c.body, 'Tidy this');
  assert.equal(c.status, 'draft');
  const edited = (await api('PATCH', `/api/comments/${c.id}`, { body: 'Tidy this up' })).json;
  assert.equal(edited.body, 'Tidy this up');
  assert.equal((await api('POST', '/api/comments', { wtId: wt.id, file: 'a', line: 1, side: 'new', body: ' ' })).status, 400);
  const replied = await post(`/api/comments/${c.id}/reply`, { body: 'On it', author: 'claude' });
  assert.equal(replied.replies.length, 1);
  const resolved = await post(`/api/comments/${c.id}/resolve`, { note: 'Done' });
  assert.equal(resolved.status, 'resolved');
  assert.equal((await post(`/api/comments/${c.id}/reopen`)).status, 'delivered');
  const list = await get(`/api/worktrees/${wt.id}/comments`);
  assert.ok(list.comments.some((x: Json) => x.id === c.id));
  assert.equal((await api('DELETE', `/api/comments/${c.id}`)).status, 200);
  assert.equal((await api('POST', `/api/comments/${c.id}/resolve`, {})).status, 404);
});

test('a submitted review reaches the session through the hook', async () => {
  const wt = await wtBy('feat/checkout-discounts');
  const prompt = await get(`/api/worktrees/${wt.id}/prompt`);
  assert.match(prompt.text, /Add the same test for a percentage code/);
  const review = await post(`/api/worktrees/${wt.id}/submit`, { summary: 'Nearly there' });
  assert.equal(review.status, 'pending');
  assert.equal((await wtBy('feat/checkout-discounts')).comments.waiting, 1);
  const other = await post('/api/hook', { session_id: '22222222-bbbb-4bbb-8bbb-222222222222', cwd: path.join(DEMO, 'home', 'code', 'shop-worktrees', 'search-filters'), event: 'Stop' });
  assert.equal(other.text, null, 'a different session gets nothing');
  const mine = await post('/api/hook', { session_id: '11111111-aaaa-4aaa-8aaa-111111111111', cwd: wt.path, event: 'UserPromptSubmit' });
  assert.match(mine.text, /Code review on `feat\/checkout-discounts`/);
  assert.match(mine.text, /Nearly there/);
  assert.match(mine.text, /\/resolve/);
  assert.equal((await post('/api/hook', { session_id: '11111111-aaaa-4aaa-8aaa-111111111111', cwd: wt.path })).text, null, 'delivered once');
  assert.equal((await api('POST', `/api/worktrees/${wt.id}/submit`, {})).status, 400);
});

test("an idle session's waiter wakes it with a review sent to it", async () => {
  const main = '33333333-cccc-4ccc-8ccc-333333333333'; // shop-main, idle
  const wt = await wtBy('main');
  const wait = (session_id: string) => api('POST', '/api/wait', { session_id, cwd: wt.path });
  assert.deepEqual((await wait('no-such-session')).json, { text: null, done: true }, 'an ended session stops waiting');

  // A newer waiter for the same session replaces the old one.
  const first = wait(main);
  await sleep(200);
  const waiting = wait(main);
  assert.deepEqual((await first).json, { text: null, done: true });

  await post('/api/comments', { wtId: wt.id, file: 'README.md', side: 'new', line: 1, lineText: 'x', body: 'Say what the shop sells' });
  const review = await post(`/api/worktrees/${wt.id}/submit`, { targetSession: main });
  assert.deepEqual([review.status, review.deliveredTo?.name], ['delivered', 'shop-main'], 'handed straight to the waiter');
  const woken = await waiting;
  assert.equal(woken.json.done, true);
  assert.match(woken.json.text, /Say what the shop sells/);
  assert.equal((await post('/api/hook', { session_id: main, cwd: wt.path })).text, null, 'delivered once');

  // Claude Code says "shell" for a session that's idle with a background shell open: that's idle too.
  const sessionsDir = path.join(DEMO, 'home', '.claude', 'sessions');
  const file = path.join(sessionsDir, fs.readdirSync(sessionsDir).find((n) => fs.readFileSync(path.join(sessionsDir, n), 'utf8').includes(main))!);
  const before = fs.readFileSync(file, 'utf8');
  const status = (to: string) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(before), status: to }));
  const shows = (want: string) => until(async () => (await state()).sessions.some((s: Json) => s.sessionId === main && s.status === want), `shop-main shown ${want}`);
  try {
    status('busy');
    await shows('busy');
    status('shell');
    await shows('idle');
    const again = wait(main);
    await sleep(200);
    await post('/api/comments', { wtId: wt.id, file: 'README.md', side: 'new', line: 1, lineText: 'x', body: 'Add a contact page' });
    assert.equal((await post(`/api/worktrees/${wt.id}/submit`, { targetSession: main })).status, 'delivered', 'a shell session is woken');
    assert.match((await again).json.text, /Add a contact page/);
  } finally {
    fs.writeFileSync(file, before);
  }

  // A busy session's waiter leaves its reviews for the Stop hook.
  const search = await wtBy('feat/search-filters');
  const busy = '22222222-bbbb-4bbb-8bbb-222222222222';
  const ctrl = new AbortController();
  const held = fetch(`${BASE}/api/wait`, { method: 'POST', headers: { 'x-wtr': '1', 'content-type': 'application/json' }, body: JSON.stringify({ session_id: busy, cwd: search.path }), signal: ctrl.signal }).catch(() => null);
  await post('/api/comments', { wtId: search.id, file: 'src/search.ts', side: 'new', line: 1, lineText: 'x', body: 'Name the filter' });
  assert.equal((await post(`/api/worktrees/${search.id}/submit`, {})).status, 'pending');
  ctrl.abort();
  await held;
  assert.match((await post('/api/hook', { session_id: busy, cwd: search.path, event: 'Stop' })).text, /Name the filter/);
});

test('CodeRabbit findings can be sent, dismissed and restored', async () => {
  const wt = await wtBy('feat/checkout-discounts');
  const review = (await get(`/api/worktrees/${wt.id}/code-reviews`)).reviews.coderabbit;
  assert.equal(review.status, 'done');
  assert.equal(review.findings.length, 2);
  const [major, minor] = review.findings;
  assert.equal(major.severity, 'major');
  assert.equal(major.source, 'coderabbit');
  assert.ok(major.snippet.includes("d.kind === 'percent'"));
  await post(`/api/findings/${minor.id}/dismiss`);
  await post(`/api/findings/${minor.id}/restore`);
  const sent = await post(`/api/findings/${major.id}/send`);
  assert.ok(sent);
  const comments = (await get(`/api/worktrees/${wt.id}/comments`)).comments;
  assert.ok(comments.some((c: Json) => c.status === 'draft' && /CodeRabbit \(major\)/.test(c.body)));
  assert.equal((await api('POST', `/api/worktrees/${wt.id}/code-review/coderabbit/cancel`)).status, 409);
});

test('Claude reviews: effort, findings, cancelling, and the reviewer is not a session', async () => {
  const wt = await wtBy('feat/checkout-discounts');
  const { reviews } = await get(`/api/worktrees/${wt.id}/code-reviews`);
  assert.equal(reviews.coderabbit.findings.length, 2, "a Claude review leaves CodeRabbit's findings alone");
  const r = reviews.claude;
  assert.deepEqual([r.reviewer, r.status, r.effort, r.costUsd, r.findings.length], ['claude', 'done', 'medium', 0.18, 1]);
  const [f] = r.findings;
  assert.deepEqual([f.source, f.file, f.severity], ['claude', 'src/checkout.ts', 'major'], 'an absolute path comes back relative');
  assert.ok(f.snippet.includes('taxFor'));
  assert.match(f.suggestions, /Math\.max\(0, sub - discount\)/);
  await post(`/api/findings/${f.id}/send`);
  assert.ok((await get(`/api/worktrees/${wt.id}/comments`)).comments.some((c: Json) => c.status === 'draft' && /Claude \(major\)/.test(c.body)));

  assert.equal((await api('POST', `/api/worktrees/${wt.id}/code-review`, { reviewer: 'someone' })).status, 400);
  assert.equal((await api('POST', `/api/worktrees/${wt.id}/code-review`, { reviewer: 'claude', effort: 'enormous' })).status, 400);

  // Started with no effort, it uses the default from Settings. While it runs, the reviewer's own Claude Code
  // process is registered as a live session in the worktree, and must not be linked to it.
  const other = await wtBy('fix/tax-rounding');
  const started = await post(`/api/worktrees/${other.id}/code-review`, { reviewer: 'claude' });
  assert.deepEqual([started.status, started.effort], ['running', 'low']);
  assert.equal((await api('POST', `/api/worktrees/${other.id}/code-review`, { reviewer: 'claude' })).status, 409);
  const sessionsDir = path.join(DEMO, 'home', '.claude', 'sessions');
  const reviewer = await until(async () => fs.readdirSync(sessionsDir).find((n) => !/^[0-9a-f-]{36}\.json$/.test(n)), "the reviewer's session file");
  await post('/api/hook', { session_id: 'someone-else', cwd: other.path });
  const st = await state();
  assert.equal(st.sessions.length, 3, `${reviewer} is not counted as a session`);
  assert.deepEqual(st.worktrees.find((w: Json) => w.id === other.id).sessions, []);
  await until(async () => (await wtBy('fix/tax-rounding')).codeReviews.claude.status === 'done', 'the second Claude review');
  assert.equal((await get(`/api/worktrees/${other.id}/code-reviews`)).reviews.claude.findings.length, 0);

  await post(`/api/worktrees/${other.id}/code-review`, { reviewer: 'claude', effort: 'max' });
  await post(`/api/worktrees/${other.id}/code-review/claude/cancel`);
  const cancelled = (await get(`/api/worktrees/${other.id}/code-reviews`)).reviews.claude;
  assert.deepEqual([cancelled.status, cancelled.effort], ['cancelled', 'max']);
});

test('starting a review answers at once, and a problem found while setting up fails it', async () => {
  const wt = await wtBy('fix/tax-rounding');
  const usage = path.join(DEMO, 'home', '.cr-usage.json');
  fs.writeFileSync(usage, JSON.stringify({ ms: 1500, remaining: 0 }));
  try {
    const t = Date.now();
    const started = await post(`/api/worktrees/${wt.id}/code-review`, { reviewer: 'coderabbit' });
    assert.ok(Date.now() - t < 1000, `answered in ${Date.now() - t}ms, before CodeRabbit's allowance was checked`);
    assert.equal(started.status, 'running');
    assert.equal((await api('POST', `/api/worktrees/${wt.id}/code-review`, { reviewer: 'coderabbit' })).status, 409, 'already running while it sets up');
    await until(async () => (await wtBy('fix/tax-rounding')).codeReviews.coderabbit.status === 'failed', 'the review to fail');
    const { reviews } = await get(`/api/worktrees/${wt.id}/code-reviews`);
    assert.match(reviews.coderabbit.error, /No CodeRabbit reviews left for acme\/shop this hour/);
  } finally {
    fs.rmSync(usage, { force: true });
  }
});

test('a review goes stale only when the files themselves change', async () => {
  const branch = 'feat/checkout-discounts';
  const wt = await wtBy(branch);
  assert.equal(wt.codeReviews.claude.stale, false);
  const file = path.join(wt.path, 'src/checkout.ts'); // uncommitted, so touching it changes the worktree's fingerprint
  const text = fs.readFileSync(file, 'utf8');
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(file, later, later);
  await until(async () => (await wtBy(branch)).fingerprint !== wt.fingerprint, 'the touched file to be noticed');
  assert.equal((await wtBy(branch)).codeReviews.claude.stale, false, 'touching a file is not changing it');
  fs.writeFileSync(file, `${text}// one more line\n`);
  await until(async () => (await wtBy(branch)).codeReviews.claude.stale, 'the edit to make the review stale');
  fs.writeFileSync(file, text);
  await until(async () => !(await wtBy(branch)).codeReviews.claude.stale, 'undoing the edit to make it current again');
});

test('settings: integrations, config, folders, onboarding', async () => {
  const integ = await get('/api/integrations');
  assert.equal(integ.gh.authed, true);
  assert.equal(integ.gh.account, 'sam-rivera');
  assert.equal(integ.coderabbit.authed, true);
  assert.equal(integ.coderabbit.org, 'acme');
  assert.equal(integ.claude.cliVersion, '2.1.0');
  await post('/api/config', { reviewEffort: 'high' });
  assert.equal((await state()).config.reviewEffort, 'high');
  assert.equal((await api('POST', '/api/config', { reviewEffort: 'extreme' })).status, 400);
  await post('/api/config', { reviewEffort: 'low' });
  await post('/api/config', { recentDays: 5 });
  assert.equal((await state()).config.recentDays, 5);
  assert.equal((await api('POST', '/api/config', { recentDays: 'lots' })).status, 400);
  await post('/api/config', { recentDays: 3 });
  const fsList = await get(`/api/fs?path=${encodeURIComponent('~/code')}`);
  assert.ok(fsList.entries.some((e: Json) => e.name === 'shop' && e.isRepo));
  assert.equal((await api('GET', '/api/fs?path=/etc')).status, 403);
  await post('/api/onboarding', { done: true });
  assert.ok((await state()).onboardedAt);
});

test('security: mutations need x-wtr, and only localhost hosts are served', async () => {
  assert.equal((await api('POST', '/api/config', { recentDays: 4 }, {})).status, 403);
  // fetch won't send a different Host header, so use http directly.
  const status = (headers: Record<string, string>, p = '/api/state') => new Promise<number>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, headers }, (res) => { res.resume(); resolve(res.statusCode!); }).on('error', reject);
  });
  assert.equal(await status({ host: 'evil.example' }), 403, 'DNS-rebinding host');
  assert.equal(await status({ host: `localhost:${PORT}` }), 200);
  assert.equal(await status({ host: 'localhost' }, '/../../../etc/passwd'), 404, 'no path traversal');
  assert.equal((await api('GET', '/api/nope')).status, 404);
});

test('static files and live updates', async () => {
  const html = await (await fetch(`${BASE}/`)).text();
  assert.match(html, /<title>/);
  for (const f of ['app.js', 'app.css', 'sse-worker.js']) assert.equal((await fetch(`${BASE}/${f}`)).status, 200, f);
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /^event: state\ndata: \{/);
  ctrl.abort();
});

test('removal: idle, forced and merged clean-up keep the right branches', async () => {
  const spike = await wtBy('spike/graphql-gateway');
  const job = await post('/api/cleanup', { ids: [spike.id, (await wtBy('feat/search-filters')).id] });
  assert.equal(job.total, 1, 'the in-use worktree is skipped');
  await until(async () => !(await wtBy('spike/graphql-gateway')), 'the spike to be removed');
  assert.ok(branches().includes('spike/graphql-gateway'), 'an unmerged branch is kept');
  assert.ok(!fs.existsSync(spike.path));

  const apiWt = await wtBy('refactor/api-client');
  await post(`/api/worktrees/${apiWt.id}/remove`, { force: true });
  await until(async () => !(await wtBy('refactor/api-client')), 'the forced removal');
  assert.ok(branches().includes('refactor/api-client'), 'a forced removal keeps the branch');

  await post('/api/cleanup/safe');
  await until(async () => !(await wtBy('chore/upgrade-node')), 'the merged clean-up');
  assert.ok(!branches().includes('chore/upgrade-node'), 'a branch that is all in its merged PR is deleted');
  assert.equal((await api('POST', '/api/cleanup/safe')).status, 409);

  const st = await state();
  const cleaned = Object.fromEntries(st.cleaned.map((c: Json) => [c.branch, c]));
  assert.equal(cleaned['spike/graphql-gateway'].reason, 'idle');
  assert.equal(cleaned['refactor/api-client'].how, 'forced');
  assert.deepEqual(cleaned['refactor/api-client'].lostFiles, ['package-lock.json']);
  assert.equal(cleaned['chore/upgrade-node'].branchDeleted, true);
  assert.ok(st.jobs.every((j: Json) => j.status === 'done' && j.failed.length === 0));
  await until(async () => !fs.readdirSync(path.dirname(spike.path)).some((f) => f.includes('.removing-')), 'background deletes', 20_000);
});

test('the page renders a worktree without errors', { skip: !fs.existsSync(process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') && 'Chrome not found' }, async () => {
  const wt = await wtBy('feat/checkout-discounts');
  const page = await openPage(`${BASE}/#/${wt.id}`);
  try {
    const rows = await page.waitFor<number>("document.querySelectorAll('tr.line').length").catch(async (e) => {
      throw new Error(`${e.message}\nPage shows: ${await page.eval("document.querySelector('#main')?.innerText.slice(0, 300)")}`);
    });
    assert.ok(rows > 20, `rendered ${rows} diff rows`);
    assert.ok(await page.waitFor("document.querySelectorAll('.cr-finding.coderabbit').length"), 'CodeRabbit findings shown inline');
    assert.ok(await page.waitFor("document.querySelectorAll('.cr-panels > .cr-panel').length === 2"), 'a panel for each reviewer');
    // The tests above sent two of the three findings, so one is still open and two are tucked away as sent.
    assert.ok(await page.waitFor("document.querySelectorAll('.cr-panel .cr-index a.cr-item[data-act=\"cr-jump\"]').length === 1"), 'the panels list open findings as links');
    assert.ok(await page.waitFor("document.querySelectorAll('.cr-panel .cr-done li').length === 2"), 'sent findings are listed apart');
    assert.ok(await page.waitFor("!document.querySelector('.cr-panel .cr-finding')"), 'findings in the diff are read there, not in the panel');
    // Both reviewers are ready, so Run code review asks which one; picking Claude offers the effort, preset from Settings.
    await page.eval("document.querySelector('[data-act=review-menu]').click()");
    await page.waitFor("document.querySelector('.review-menu input[value=claude]')");
    await page.eval("(() => { const r = document.querySelector('.review-menu input[value=claude]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })()");
    assert.equal(await page.waitFor<string>("document.querySelector('.review-menu select[data-review=effort]')?.value"), 'low');
    await page.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    assert.ok(await page.waitFor("!document.querySelector('.review-menu')"), 'Escape closes the menu');
    // highlight.js comes from cdnjs, pinned by an integrity hash; a mismatch would leave the code unhighlighted.
    assert.ok(await page.waitFor("document.querySelector('td.code [class^=hljs-]')"), 'syntax highlighting loaded');
    assert.ok(await page.waitFor("document.querySelectorAll('.cbar, [class*=commit-c]').length || document.querySelectorAll('tr.line td').length"));
    // Blame: switch it on for one file, check the column, switch it off.
    await page.eval(`[...document.querySelectorAll('section.file')].find((s) => s.querySelector('.file-name')?.getAttribute('title') === 'src/checkout.ts').querySelector('[data-act=blame-file]').click()`);
    const blameText = await page.waitFor<string>("[...document.querySelectorAll('td.blame.start')].map((td) => td.textContent).join(' | ')");
    assert.match(blameText, /Sam Rivera/);
    assert.match(blameText, /#2/);
    assert.match(blameText, /Not committed yet/);
    await page.eval("document.querySelector('.blame-btn.on').click()");
    assert.ok(await page.waitFor("document.querySelectorAll('td.blame').length === 0"), 'blame switched off');
    await page.eval("document.querySelector('[data-act=mode][data-mode=commits]').click()");
    assert.ok(await page.waitFor("document.querySelectorAll('.commit-group').length >= 3"), 'a section per commit');
    for (const hash of ['#/cleanup', '#/settings']) {
      await page.eval(`location.hash = '${hash}'`);
      assert.ok(await page.waitFor("document.querySelector('#main h1')?.textContent"), hash);
    }
    // Compare with: the menu lists branches; picking one sets the base, picking automatic resets it.
    await page.eval(`location.hash = '#/${wt.id}'`);
    const opts = await page.waitFor<string[]>("document.querySelector('.base-select optgroup') && [...document.querySelectorAll('.base-select option')].map((o) => o.value)");
    assert.ok(opts.includes('main') && opts.includes('') && opts.includes('__other'), opts.join(','));
    const pick = (v: string) => page.eval(`(() => { const s = document.querySelector('.base-select'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await pick('main');
    await until(async () => (await wtBy('feat/checkout-discounts')).baseSource === 'set by you', 'the picked base');
    await page.waitFor("document.querySelector('.base-select')?.value === 'main'");
    await pick('');
    await until(async () => (await wtBy('feat/checkout-discounts')).baseSource !== 'set by you', 'the automatic base');
    await pick('__other');
    assert.ok(await page.waitFor("document.querySelector('input#base')"), 'free-text ref input');
    await page.eval("document.querySelector('[data-act=base-other-cancel]').click()");
    assert.ok(await page.waitFor("document.querySelector('.base-select')"));
    // Opening the dashboard with no worktree chosen goes straight to one to review, not to setup.
    await page.eval(`location.href = '${BASE}/'`);
    assert.match(await page.waitFor<string>("/^#\\/[0-9a-f]{12}$/.test(location.hash) && location.hash"), /^#\/[0-9a-f]{12}$/);
    assert.ok(await page.waitFor("document.querySelectorAll('tr.line').length"), 'the diff of that worktree is shown');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.close();
  }
});
