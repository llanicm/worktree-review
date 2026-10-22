#!/usr/bin/env node
// Worktree Review — a local, always-on dashboard for reviewing work in git
// worktrees before it becomes a PR. Zero dependencies; needs git and gh.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const PORT = Number(process.env.WTR_PORT || 4747);
const CLAUDE_DIR = path.join(HOME, '.claude');
const DATA_DIR = process.env.WTR_DATA_DIR || path.join(CLAUDE_DIR, 'worktree-review');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch { return 'dev'; }
})();
fs.mkdirSync(TMP_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), ...a);
const expand = (p) => (p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

// ---------- config & state ----------

const DEFAULT_CONFIG = {
  // Repos are found automatically from where Claude Code sessions have worked.
  // Add directories here to also scan their immediate children for git repos.
  roots: [],
  // Extra repo paths to always include.
  extraRepos: [],
  // Remove a worktree automatically once its PR is merged (only when safe).
  autoCleanup: true,
  // Worktrees touched within this many days count as "recent".
  recentDays: 3,
  prPollMinutes: 5,
  // Editor for "open" links: vscode, cursor, windsurf, zed, or none.
  editor: 'vscode',
};

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
const config = { ...DEFAULT_CONFIG, ...loadJson(CONFIG_PATH, {}) };
if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

const state = {
  installedAt: Date.now(),
  worktrees: {}, // id -> { path, baseOverride, reviewedTree, reviewedFp, reviewedAt, viewed: {file: hash} }
  comments: [],
  reviews: [],
  cleaned: [],
  ...loadJson(STATE_PATH, {}),
};

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
  }, 200);
}
save();

function wtState(id, p) {
  if (!state.worktrees[id]) state.worktrees[id] = { path: p, viewed: {} };
  return state.worktrees[id];
}

// ---------- process helpers ----------

function pool(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const gitPool = pool(6);

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...opts.env },
      maxBuffer: 256 * 1024 * 1024,
      timeout: opts.timeout ?? 60_000,
    }, (err, stdout, stderr) => {
      if (err) { err.message += `\n${stderr}`; reject(err); } else resolve(stdout);
    });
  });
}
const git = (cwd, args, opts) => gitPool(() => run('git', ['-c', 'core.quotepath=false', ...args], { ...opts, cwd }));
const gitOk = (cwd, args) => git(cwd, args).then(() => true, () => false);

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---------- repos & worktrees ----------

const repos = new Map(); // commonDir -> repo
const wts = new Map();   // id -> worktree

// Every directory Claude Code has worked in recently, read from transcript `cwd` fields.
let claudeCwds = { at: 0, dirs: [] };
const cwdScan = new Map(); // transcript path -> { offset, dirs, carry }
function recentClaudeCwds() {
  if (Date.now() - claudeCwds.at < 5 * 60_000) return claudeCwds.dirs;
  const dirs = new Set();
  const projects = path.join(CLAUDE_DIR, 'projects');
  const cutoff = Date.now() - 30 * 864e5;
  let files = [];
  try {
    for (const d of fs.readdirSync(projects)) {
      let entries = [];
      try { entries = fs.readdirSync(path.join(projects, d)); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(projects, d, f);
        try { const m = fs.statSync(p).mtimeMs; if (m > cutoff) files.push({ p, m }); } catch {}
      }
    }
  } catch {}
  files = files.sort((a, b) => b.m - a.m).slice(0, 300);
  for (const { p } of files) {
    // Read only what was appended since last time; transcripts only grow.
    let c = cwdScan.get(p);
    if (!c) { c = { offset: 0, dirs: new Set(), carry: '' }; cwdScan.set(p, c); }
    try {
      const fd = fs.openSync(p, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        if (size < c.offset) { c.offset = 0; c.dirs.clear(); c.carry = ''; }
        const buf = Buffer.alloc(4 * 1024 * 1024);
        while (c.offset < size) {
          const n = fs.readSync(fd, buf, 0, buf.length, c.offset);
          if (!n) break;
          c.offset += n;
          const text = c.carry + buf.toString('utf8', 0, n);
          const cut = text.lastIndexOf('\n');
          c.carry = cut === -1 ? text.slice(-8192) : text.slice(cut + 1).slice(-8192);
          for (const m of text.slice(0, cut + 1).matchAll(/"cwd":"((?:[^"\\]|\\.)+)"/g)) {
            try { c.dirs.add(JSON.parse(`"${m[1]}"`)); } catch {}
          }
        }
      } finally { fs.closeSync(fd); }
    } catch {}
    for (const d of c.dirs) dirs.add(d);
  }
  for (const s of sessions.values()) if (s.cwd) dirs.add(s.cwd);
  claudeCwds = { at: Date.now(), dirs: [...dirs].filter((d) => fs.existsSync(d)) };
  return claudeCwds.dirs;
}

async function discoverRepos() {
  const candidates = new Set(config.extraRepos.map(expand));
  const known = [...wts.values()].map((w) => w.path);
  for (const dir of recentClaudeCwds()) {
    if (known.some((p) => dir === p || dir.startsWith(p + '/'))) continue;
    try {
      const top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
      if (top) { candidates.add(top); known.push(top); }
    } catch {}
  }
  for (const root of config.roots.map(expand)) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(root, e.name);
      try { if (fs.statSync(path.join(p, '.git')).isDirectory()) candidates.add(p); } catch {}
    }
  }
  for (const p of candidates) {
    try {
      const common = fs.realpathSync(path.resolve(p, (await git(p, ['rev-parse', '--git-common-dir'])).trim()));
      if (repos.has(common)) continue;
      // Name the repo after its main checkout, not whichever worktree we found first.
      const mainDir = path.basename(common) === '.git' ? path.dirname(common) : p;
      const repo = { root: fs.existsSync(mainDir) ? mainDir : p, commonDir: common, name: path.basename(mainDir).replace(/\.git$/, ''), gh: null, defaultBase: 'origin/main' };
      try {
        const url = (await git(p, ['remote', 'get-url', 'origin'])).trim();
        const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
        if (m) repo.gh = { owner: m[1], name: m[2] };
      } catch {}
      try {
        repo.defaultBase = (await git(p, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
      } catch {
        if (!(await gitOk(p, ['rev-parse', '--verify', '--quiet', 'origin/main']))) repo.defaultBase = 'main';
      }
      repos.set(common, repo);
    } catch {}
  }
}

function parseWorktreeList(out) {
  const list = [];
  let cur = null;
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

async function discoverWorktrees() {
  await discoverRepos();
  const seen = new Set();
  for (const repo of repos.values()) {
    let list;
    try { list = parseWorktreeList(await git(repo.root, ['worktree', 'list', '--porcelain'])); } catch { continue; }
    list.forEach((w, i) => {
      if (w.bare || w.prunable || !fs.existsSync(w.path)) return;
      const id = sha1(w.path).slice(0, 12);
      seen.add(id);
      let wt = wts.get(id);
      if (!wt) {
        wt = {
          id, path: w.path, repoKey: repo.commonDir, repoName: repo.name, isMain: i === 0,
          fingerprint: null, dirty: 0, lastActivity: 0, ahead: 0, stats: null, nextCheck: 0,
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
async function detectStackBase(wt, repo) {
  if (!wt.branch) return null;
  let out;
  try {
    out = await git(wt.path, ['for-each-ref', '--format=%(refname:short)', '--merged', 'HEAD', '--no-merged', repo.defaultBase, 'refs/heads']);
  } catch { return null; }
  let best = null, bestN = Infinity;
  for (const c of out.split('\n').filter((b) => b && b !== wt.branch).slice(0, 30)) {
    const n = Number((await git(wt.path, ['rev-list', '--count', `${c}..HEAD`])).trim());
    if (n > 0 && n < bestN) { best = c; bestN = n; }
  }
  return best;
}

function resolveBase(wt) {
  const repo = repos.get(wt.repoKey);
  const s = state.worktrees[wt.id];
  if (s?.baseOverride) return { ref: s.baseOverride, source: 'set by you' };
  if (wt.pr?.baseRefName) return { ref: `origin/${wt.pr.baseRefName}`, source: `PR #${wt.pr.number} base` };
  if (wt.stackBase) return { ref: wt.stackBase, source: 'stacked on' };
  return { ref: repo.defaultBase, source: 'default' };
}

function parseStatus(out) {
  const parts = out.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    entries.push({ xy: p.slice(0, 2), file: p.slice(3) });
    if (p[0] === 'R' || p[0] === 'C') i++;
  }
  return entries;
}

async function refreshWorktree(wt, { force = false } = {}) {
  if (wt.checking) return wt.checking;
  wt.checking = (async () => {
    const repo = repos.get(wt.repoKey);
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
    }
    wt.dirty = entries.length;
    wt.untracked = entries.filter((e) => e.xy === '??').length;
    wt.lastActivity = Math.max(wt.commitTime || 0, maxMtime);
    const base = resolveBase(wt);
    const fp = sha1([head, base.ref, status, ...stamps].join('|'));
    if (fp !== wt.fingerprint || force) {
      wt.fingerprint = fp;
      wt.baseRef = base.ref;
      wt.baseSource = base.source;
      try {
        wt.mergeBase = (await git(wt.path, ['merge-base', base.ref, 'HEAD'])).trim();
        wt.ahead = Number((await git(wt.path, ['rev-list', '--count', `${wt.mergeBase}..HEAD`])).trim());
        const numstat = await git(wt.path, ['diff', '--numstat', wt.mergeBase]);
        let files = 0, add = 0, del = 0;
        for (const line of numstat.split('\n')) {
          if (!line) continue;
          const [a, d] = line.split('\t');
          files++;
          add += Number(a) || 0;
          del += Number(d) || 0;
        }
        wt.stats = { files: files + wt.untracked, add, del };
        wt.baseError = null;
      } catch (e) {
        wt.mergeBase = null;
        wt.ahead = 0;
        wt.stats = null;
        wt.baseError = `Couldn't diff against ${base.ref}`;
      }
      changed();
    }
  })().finally(() => { wt.checking = null; });
  return wt.checking;
}

function isActive(wt) {
  return wt.sessions.length > 0 || Date.now() - wt.lastActivity < 2 * 3600_000;
}

async function pollWorktrees() {
  const now = Date.now();
  const due = [...wts.values()].filter((w) => w.nextCheck <= now && !w.checking);
  await Promise.all(due.map(async (wt) => {
    wt.nextCheck = now + (isActive(wt) ? 3_000 : 60_000);
    try { await refreshWorktree(wt); } catch (e) { wt.error = String(e.message).split('\n')[0]; }
  }));
}

// ---------- Claude sessions ----------

const sessions = new Map(); // sessionId -> session
const transcriptCache = new Map(); // sessionId -> path

function findTranscript(sessionId) {
  if (transcriptCache.has(sessionId)) return transcriptCache.get(sessionId);
  const projects = path.join(CLAUDE_DIR, 'projects');
  try {
    for (const d of fs.readdirSync(projects)) {
      const p = path.join(projects, d, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) { transcriptCache.set(sessionId, p); return p; }
    }
  } catch {}
  return null;
}

function readTail(p, bytes) {
  const fd = fs.openSync(p, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

// Which worktrees has this session been working in? A path counts when the
// session's shell cwd was inside it, or it's mentioned repeatedly (a single
// mention, e.g. from `git worktree list`, doesn't count).
function linkSession(text, paths) {
  const result = [];
  for (const p of paths) {
    const nested = paths.filter((q) => q.length > p.length && q.startsWith(p + '/'));
    let count = 0, last = -1, cwdHit = false;
    let i = text.indexOf(p);
    while (i !== -1) {
      const ch = text[i + p.length];
      const boundary = ch === undefined || /[/"'\s\\`:),]/.test(ch);
      if (boundary && !nested.some((q) => text.startsWith(q, i))) {
        count++;
        last = i;
        if (text.startsWith('"cwd":"', i - 7)) cwdHit = true;
      }
      i = text.indexOf(p, i + p.length);
    }
    if (cwdHit || count >= 6) result.push({ path: p, last });
  }
  return result.sort((a, b) => b.last - a.last).map((r) => r.path);
}

function refreshSessions() {
  const dir = path.join(CLAUDE_DIR, 'sessions');
  const live = new Set();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {}
  const paths = [...wts.values()].map((w) => w.path);
  for (const f of files) {
    const info = loadJson(path.join(dir, f), null);
    if (!info?.sessionId || !info.pid || !pidAlive(info.pid)) continue;
    live.add(info.sessionId);
    let s = sessions.get(info.sessionId);
    if (!s) { s = { sessionId: info.sessionId, worktreePaths: [], scannedSize: -1, scannedAt: 0 }; sessions.set(info.sessionId, s); }
    Object.assign(s, { pid: info.pid, name: info.name || info.sessionId.slice(0, 8), status: info.status || 'unknown', cwd: info.cwd });
    const tp = findTranscript(s.sessionId);
    if (tp) {
      try {
        const size = fs.statSync(tp).size;
        if (size !== s.scannedSize && Date.now() - s.scannedAt > 8_000) {
          s.scannedSize = size;
          s.scannedAt = Date.now();
          s.worktreePaths = linkSession(readTail(tp, 3 * 1024 * 1024), paths);
        }
      } catch {}
    }
    if (s.cwd) {
      const own = paths.filter((p) => s.cwd === p || s.cwd.startsWith(p + '/')).sort((a, b) => b.length - a.length)[0];
      if (own && !s.worktreePaths.includes(own)) s.worktreePaths.unshift(own);
    }
  }
  for (const id of sessions.keys()) if (!live.has(id)) sessions.delete(id);
  for (const wt of wts.values()) {
    const linked = [...sessions.values()].filter((s) => s.worktreePaths.includes(wt.path));
    const sig = linked.map((s) => s.sessionId + s.status).join(',');
    if (sig !== wt.sessionSig) { wt.sessionSig = sig; changed(); }
    wt.sessions = linked;
  }
}

// ---------- GitHub PRs & cleanup ----------

let prError = null;
async function refreshPRs() {
  for (const repo of repos.values()) {
    if (!repo.gh) continue;
    const repoWts = [...wts.values()].filter((w) => w.repoKey === repo.commonDir && w.branch && !w.isMain);
    const branches = [...new Set(repoWts.map((w) => w.branch))];
    if (!branches.length) continue;
    const fields = 'nodes { number state isDraft url title headRefOid mergedAt baseRefName }';
    const aliases = branches.map((b, i) =>
      `b${i}: pullRequests(headRefName: ${JSON.stringify(b)}, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { ${fields} }`).join('\n');
    const query = `query { repository(owner: ${JSON.stringify(repo.gh.owner)}, name: ${JSON.stringify(repo.gh.name)}) { ${aliases} } }`;
    try {
      const data = JSON.parse(await run('gh', ['api', 'graphql', '-f', `query=${query}`])).data.repository;
      const byBranch = new Map(branches.map((b, i) => [b, data[`b${i}`]?.nodes?.[0] || null]));
      for (const wt of repoWts) {
        const pr = byBranch.get(wt.branch);
        if (JSON.stringify(pr) !== JSON.stringify(wt.pr)) {
          wt.pr = pr;
          wt.headInMerged = null;
          wt.nextCheck = 0; // the PR base may change the diff base
          changed();
        }
      }
      prError = null;
    } catch (e) {
      const msg = String(e.message);
      prError = e.code === 'ENOENT' ? 'Install the GitHub CLI (gh) to see PR status and clean up merged worktrees.'
        : /auth|login|401/i.test(msg) ? 'Run `gh auth login` to see PR status and clean up merged worktrees.'
        : `Couldn't fetch PR status for ${repo.name}.`;
      log(`PR refresh failed for ${repo.name}:`, msg.split('\n')[0]);
      changed();
    }
  }
  await runCleanup();
}

function openReviewItems(wtId) {
  return state.comments.filter((c) => c.wtId === wtId && (c.status === 'draft' || c.status === 'pending')).length;
}

function cleanupStatus(wt) {
  const pr = wt.pr;
  if (!pr || pr.state !== 'MERGED' || wt.isMain || !wt.branch) return null;
  const reasons = [];
  if (wt.locked) reasons.push('the worktree is locked');
  if (wt.dirty > 0) reasons.push(`${wt.dirty} uncommitted change${wt.dirty === 1 ? '' : 's'}`);
  if (wt.sessions.length) reasons.push(`in use by ${wt.sessions.map((s) => s.name).join(', ')}`);
  if (wt.head && wt.head !== pr.headRefOid && wt.headInMerged !== true) reasons.push('has commits that are not in the merged PR');
  if (openReviewItems(wt.id)) reasons.push('has unsent review comments');
  return {
    eligible: reasons.length === 0,
    reasons,
    auto: config.autoCleanup && Date.parse(pr.mergedAt) >= state.installedAt,
  };
}

async function runCleanup() {
  for (const wt of [...wts.values()]) {
    const pr = wt.pr;
    if (!pr || pr.state !== 'MERGED' || wt.isMain || !wt.head) continue;
    if (wt.head !== pr.headRefOid && wt.headInMerged === null) {
      wt.headInMerged = await gitOk(wt.path, ['merge-base', '--is-ancestor', wt.head, pr.headRefOid]);
      changed();
    }
    const cs = cleanupStatus(wt);
    if (cs?.eligible && cs.auto) {
      try { await removeWorktree(wt, 'auto'); } catch (e) { log('auto-cleanup skipped', wt.path, e.message); }
    }
  }
}

async function removeWorktree(wt, how) {
  const repo = repos.get(wt.repoKey);
  refreshSessions();
  await refreshWorktree(wt, { force: true });
  const cs = cleanupStatus(wt);
  if (!cs) throw new Error('This worktree has no merged PR.');
  if (!cs.eligible) throw new Error(`Not safe to remove: ${cs.reasons.join('; ')}.`);
  // No --force: git refuses if anything modified or untracked appeared in the meantime.
  await run('git', ['worktree', 'remove', wt.path], { cwd: repo.root });
  let branchDeleted = false;
  try {
    const tip = (await git(repo.root, ['rev-parse', `refs/heads/${wt.branch}`])).trim();
    if (tip === wt.head) { await git(repo.root, ['branch', '-D', wt.branch]); branchDeleted = true; }
  } catch {}
  await git(repo.root, ['worktree', 'prune']).catch(() => {});
  state.cleaned.unshift({
    path: wt.path, branch: wt.branch, sha: wt.head, repoRoot: repo.root, how, branchDeleted, at: Date.now(),
    pr: { number: wt.pr.number, url: wt.pr.url, title: wt.pr.title },
  });
  state.cleaned = state.cleaned.slice(0, 100);
  delete state.worktrees[wt.id];
  wts.delete(wt.id);
  log(`removed worktree ${wt.path} (${how}, PR #${wt.pr.number} merged)`);
  save();
  changed();
}

// ---------- diffs ----------

async function snapshotTree(wt) {
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

async function getDiff(wt, mode) {
  await refreshWorktree(wt);
  if (!wt.mergeBase) throw httpError(409, wt.baseError || 'No merge base');
  const tree = await snapshotTree(wt);
  const s = state.worktrees[wt.id];
  let from = wt.mergeBase;
  let sinceAvailable = false;
  if (s.reviewedTree) sinceAvailable = await gitOk(wt.path, ['cat-file', '-e', `${s.reviewedTree}^{tree}`]);
  if (mode === 'since' && sinceAvailable) from = s.reviewedTree;
  const diff = await git(wt.path, ['diff', '--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/', from, tree]);
  const commits = (await git(wt.path, ['log', '--format=%H%x09%ct%x09%an%x09%s', `${wt.mergeBase}..HEAD`]))
    .split('\n').filter(Boolean).map((l) => {
      const [sha, ct, author, ...subject] = l.split('\t');
      return { sha, time: Number(ct) * 1000, author, subject: subject.join('\t') };
    });
  return {
    mode: from === wt.mergeBase ? 'full' : 'since',
    sinceAvailable, reviewedAt: s.reviewedAt || null,
    fingerprint: wt.fingerprint, tree, mergeBase: wt.mergeBase,
    baseRef: wt.baseRef, baseSource: wt.baseSource, commits,
    viewed: s.viewed || {},
    truncated: diff.length > 30 * 1024 * 1024,
    diff: diff.slice(0, 30 * 1024 * 1024),
  };
}

// ---------- review comments → Claude sessions ----------

function reviewPrompt(wt, review, comments) {
  const lines = [];
  lines.push(`## Code review on \`${wt.branch || wt.head?.slice(0, 10)}\` (${wt.path})`);
  lines.push('');
  lines.push('This review was left in the Worktree Review dashboard. Address each comment in that worktree.');
  if (review?.summary) lines.push('', '### Overall', '', review.summary);
  for (const c of comments) {
    lines.push('', `### ${c.file}:${c.line}${c.side === 'old' ? ' (removed line)' : ''}  [${c.id}]`);
    if (c.lineText) lines.push('', '```', c.lineText, '```');
    lines.push('', c.body);
    for (const r of c.replies || []) lines.push('', `> **${r.author === 'you' ? 'Reviewer' : 'Claude'}:** ${r.body.replace(/\n/g, '\n> ')}`);
  }
  if (comments.length) {
    lines.push('', '---', 'When a comment is dealt with, mark it resolved so the dashboard shows it (say what you changed):',
      `curl -s -X POST http://127.0.0.1:${PORT}/api/comments/<comment-id>/resolve -H 'x-wtr: 1' -H 'content-type: application/json' -d '{"note":"..."}'`,
      'To answer a comment without resolving it (you disagree, or need clarification), use /reply instead of /resolve with {"body":"..."}.');
  }
  return lines.join('\n');
}

function submitReview(wt, { summary, targetSession }) {
  const drafts = state.comments.filter((c) => c.wtId === wt.id && c.status === 'draft');
  if (!drafts.length && !summary?.trim()) throw httpError(400, 'Nothing to submit');
  const review = {
    id: newId('r'), wtId: wt.id, wtPath: wt.path, summary: summary?.trim() || '',
    commentIds: drafts.map((c) => c.id), targetSession: targetSession || null,
    status: 'pending', createdAt: Date.now(),
  };
  for (const c of drafts) { c.status = 'pending'; c.reviewId = review.id; }
  state.reviews.push(review);
  save();
  changed();
  return review;
}

function claimReviews({ session_id, cwd }) {
  const session = sessions.get(session_id);
  const ownWt = [...wts.values()]
    .filter((w) => cwd && (cwd === w.path || cwd.startsWith(w.path + '/')))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const claimed = [];
  for (const r of state.reviews) {
    if (r.status !== 'pending') continue;
    const wt = wts.get(r.wtId);
    if (!wt) continue;
    const ok = r.targetSession
      ? r.targetSession === session_id
      : (session?.worktreePaths.includes(wt.path) || ownWt?.id === wt.id);
    if (!ok) continue;
    r.status = 'delivered';
    r.deliveredAt = Date.now();
    r.deliveredTo = { sessionId: session_id, name: session?.name || session_id?.slice(0, 8) };
    const comments = state.comments.filter((c) => r.commentIds.includes(c.id));
    for (const c of comments) if (c.status === 'pending') { c.status = 'delivered'; c.deliveredTo = r.deliveredTo; }
    claimed.push(reviewPrompt(wt, r, comments));
  }
  if (claimed.length) { save(); changed(); }
  return claimed.length ? claimed.join('\n\n') : null;
}

// ---------- public state & SSE ----------

let dirty = true;
function changed() { dirty = true; }

function publicState() {
  const cfgDays = config.recentDays;
  return {
    port: PORT,
    version: VERSION,
    home: HOME,
    prError,
    config: { autoCleanup: config.autoCleanup, recentDays: cfgDays, editor: config.editor },
    installedAt: state.installedAt,
    sessions: [...sessions.values()].map((s) => ({ sessionId: s.sessionId, name: s.name, status: s.status, cwd: s.cwd })),
    cleaned: state.cleaned.slice(0, 30),
    worktrees: [...wts.values()].map((wt) => {
      const s = state.worktrees[wt.id] || {};
      const mine = state.comments.filter((c) => c.wtId === wt.id);
      return {
        id: wt.id, path: wt.path, repoName: wt.repoName, branch: wt.branch, head: wt.head,
        isMain: wt.isMain, locked: wt.locked, detached: wt.detached,
        fingerprint: wt.fingerprint, dirty: wt.dirty, lastActivity: wt.lastActivity,
        ahead: wt.ahead, stats: wt.stats, baseRef: wt.baseRef, baseSource: wt.baseSource, baseError: wt.baseError,
        pr: wt.pr ? { number: wt.pr.number, state: wt.pr.state, isDraft: wt.pr.isDraft, url: wt.pr.url, title: wt.pr.title, mergedAt: wt.pr.mergedAt } : null,
        sessions: wt.sessions.map((x) => ({ sessionId: x.sessionId, name: x.name, status: x.status })),
        cleanup: cleanupStatus(wt),
        review: {
          reviewedAt: s.reviewedAt || null,
          needsReview: !!wt.fingerprint && (wt.stats?.files || 0) > 0 && s.reviewedFp !== wt.fingerprint,
        },
        comments: {
          draft: mine.filter((c) => c.status === 'draft').length,
          waiting: mine.filter((c) => c.status === 'pending').length,
          open: mine.filter((c) => c.status === 'delivered').length,
          sig: sha1(mine.map((c) => `${c.id}${c.status}${c.replies.length}${c.body.length}`).join()
            + state.reviews.filter((r) => r.wtId === wt.id).map((r) => r.status).join()).slice(0, 10),
        },
      };
    }),
  };
}

const clients = new Set();
let lastSent = '';
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  const json = JSON.stringify(publicState());
  if (json === lastSent) return;
  lastSent = json;
  for (const res of clients) res.write(`event: state\ndata: ${json}\n\n`);
}, 500);
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25_000);

// ---------- HTTP ----------

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 2e6) reject(httpError(413, 'Too large')); else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(httpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function getWt(id) {
  const wt = wts.get(id);
  if (!wt) throw httpError(404, 'Unknown worktree');
  return wt;
}
function getComment(id) {
  const c = state.comments.find((x) => x.id === id);
  if (!c) throw httpError(404, 'Unknown comment');
  return c;
}

const routes = [
  ['GET', /^\/api\/state$/, () => publicState()],
  ['GET', /^\/api\/worktrees\/(\w+)\/diff$/, (m, body, url) => getDiff(getWt(m[1]), url.searchParams.get('mode'))],
  ['GET', /^\/api\/worktrees\/(\w+)\/comments$/, (m) => {
    getWt(m[1]);
    return {
      comments: state.comments.filter((c) => c.wtId === m[1]),
      reviews: state.reviews.filter((r) => r.wtId === m[1] && r.status === 'pending'),
    };
  }],
  ['GET', /^\/api\/worktrees\/(\w+)\/prompt$/, (m) => {
    const wt = getWt(m[1]);
    const cs = state.comments.filter((c) => c.wtId === wt.id && (c.status === 'draft' || c.status === 'pending'));
    return { text: reviewPrompt(wt, null, cs) };
  }],
  ['POST', /^\/api\/worktrees\/(\w+)\/base$/, async (m, body) => {
    const wt = getWt(m[1]);
    const ref = (body.base || '').trim();
    if (ref && !(await gitOk(wt.path, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))) throw httpError(400, `Unknown ref: ${ref}`);
    state.worktrees[wt.id].baseOverride = ref || null;
    save();
    await refreshWorktree(wt, { force: true });
    return { ok: true };
  }],
  ['POST', /^\/api\/worktrees\/(\w+)\/reviewed$/, (m, body) => {
    const wt = getWt(m[1]);
    const s = state.worktrees[wt.id];
    s.reviewedTree = body.tree;
    s.reviewedFp = wt.snap?.tree === body.tree ? wt.snap.fp : body.fingerprint;
    s.reviewedAt = Date.now();
    save();
    changed();
    return { ok: true };
  }],
  ['POST', /^\/api\/worktrees\/(\w+)\/viewed$/, (m, body) => {
    const s = state.worktrees[getWt(m[1]).id];
    s.viewed ||= {};
    if (body.viewed) s.viewed[body.file] = body.hash; else delete s.viewed[body.file];
    save();
    return { ok: true };
  }],
  ['POST', /^\/api\/worktrees\/(\w+)\/submit$/, (m, body) => submitReview(getWt(m[1]), body)],
  ['POST', /^\/api\/worktrees\/(\w+)\/remove$/, async (m) => { await removeWorktree(getWt(m[1]), 'manual'); return { ok: true }; }],
  ['POST', /^\/api\/cleanup\/safe$/, async () => {
    const removed = [], failed = [];
    for (const wt of [...wts.values()]) {
      if (!cleanupStatus(wt)?.eligible) continue;
      try { await removeWorktree(wt, 'manual'); removed.push(wt.path); } catch (e) { failed.push({ path: wt.path, error: e.message }); }
    }
    return { removed, failed };
  }],
  ['POST', /^\/api\/config$/, (m, body) => {
    if (typeof body.autoCleanup === 'boolean') config.autoCleanup = body.autoCleanup;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
    changed();
    return { ok: true };
  }],
  ['POST', /^\/api\/comments$/, (m, body) => {
    const wt = getWt(body.wtId);
    if (!body.body?.trim()) throw httpError(400, 'Empty comment');
    const c = {
      id: newId('c'), wtId: wt.id, wtPath: wt.path, file: body.file, line: body.line, side: body.side,
      lineText: body.lineText, body: body.body.trim(), status: 'draft', createdAt: Date.now(), replies: [],
    };
    state.comments.push(c);
    save();
    changed();
    return c;
  }],
  ['PATCH', /^\/api\/comments\/(\w+)$/, (m, body) => {
    const c = getComment(m[1]);
    if (c.status !== 'draft') throw httpError(409, 'Only drafts can be edited');
    c.body = String(body.body || '').trim() || c.body;
    save();
    return c;
  }],
  ['DELETE', /^\/api\/comments\/(\w+)$/, (m) => {
    const c = getComment(m[1]);
    state.comments = state.comments.filter((x) => x !== c);
    save();
    changed();
    return { ok: true };
  }],
  ['POST', /^\/api\/comments\/(\w+)\/reply$/, (m, body) => {
    const c = getComment(m[1]);
    if (!body.body?.trim()) throw httpError(400, 'Empty reply');
    const author = body.author || 'claude';
    c.replies.push({ author, body: body.body.trim(), at: Date.now() });
    // A reply from you re-opens the thread and sends it back to Claude.
    if (author === 'you' && c.status !== 'draft') c.status = 'draft';
    save();
    changed();
    return c;
  }],
  ['POST', /^\/api\/comments\/(\w+)\/resolve$/, (m, body) => {
    const c = getComment(m[1]);
    c.status = 'resolved';
    c.resolvedAt = Date.now();
    if (body.note?.trim()) c.replies.push({ author: body.author || 'claude', body: body.note.trim(), at: Date.now() });
    save();
    changed();
    return c;
  }],
  ['POST', /^\/api\/comments\/(\w+)\/reopen$/, (m) => {
    const c = getComment(m[1]);
    c.status = 'delivered';
    save();
    changed();
    return c;
  }],
  ['POST', /^\/api\/reviews\/(\w+)\/cancel$/, (m) => {
    const r = state.reviews.find((x) => x.id === m[1] && x.status === 'pending');
    if (!r) throw httpError(404, 'No pending review');
    r.status = 'cancelled';
    for (const c of state.comments) if (r.commentIds.includes(c.id) && c.status === 'pending') c.status = 'draft';
    save();
    changed();
    return { ok: true };
  }],
  ['POST', /^\/api\/shutdown$/, () => { setTimeout(() => process.exit(0), 100); return { ok: true }; }],
  ['POST', /^\/api\/hook$/, (m, body) => {
    refreshSessions();
    return { text: claimReviews(body) };
  }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  // Only answer requests addressed to this machine (guards against DNS rebinding).
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost'].includes(host)) return send(res, 403, { error: 'Forbidden host' });

  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    // Mutations need a custom header, which cross-site pages can't send without a CORS preflight we never grant.
    if (req.method !== 'GET' && req.headers['x-wtr'] !== '1') return send(res, 403, { error: 'Missing x-wtr header' });
    const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
    if (!route) return send(res, 404, { error: 'Not found' });
    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      send(res, 200, await route[2](url.pathname.match(route[1]), body, url));
    } catch (e) {
      if (!e.status) log('error', req.method, url.pathname, e.message);
      send(res, e.status || 500, { error: e.message.split('\n')[0] });
    }
    return;
  }

  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const full = path.join(HERE, 'public', path.normalize(file));
  if (!full.startsWith(path.join(HERE, 'public'))) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, data, MIME[path.extname(full)] || 'application/octet-stream');
  });
});

// ---------- main loop ----------

async function loop(fn, ms) {
  try { await fn(); } catch (e) { log('loop error', e.message); }
  setTimeout(() => loop(fn, ms), ms);
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { log(`Port ${PORT} is already in use; another copy is probably running.`); process.exit(0); }
  throw e;
});

server.listen(PORT, '127.0.0.1', async () => {
  log(`Worktree Review ${VERSION} on http://127.0.0.1:${PORT}  (data: ${DATA_DIR})`);
  await discoverWorktrees();
  refreshSessions();
  loop(discoverWorktrees, 30_000);
  loop(async () => refreshSessions(), 3_000);
  loop(pollWorktrees, 1_000);
  setTimeout(() => loop(refreshPRs, config.prPollMinutes * 60_000), 5_000);
});
