#!/usr/bin/env node
// Worktree Review — a local, always-on dashboard for reviewing work in git
// worktrees before it becomes a PR. Zero dependencies; needs git and gh.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
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
  coderabbit: {}, // wtId -> last review { status, startedAt, finishedAt, baseRef, findings, reviewedFiles, error }
  ...loadJson(STATE_PATH, {}),
};
state.coderabbit ||= {};
// A review that was running when the server stopped can't be resumed.
for (const r of Object.values(state.coderabbit)) if (r.status === 'running') { r.status = 'failed'; r.error = 'Interrupted: the server restarted during the review.'; }

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
      if (err) { err.message += `\n${stderr}`; err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve(stdout);
    });
  });
}
// The useful part of a failed git command: its fatal:/error: line, not "Command failed: git ...".
function gitError(e) {
  const lines = String(e?.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const key = lines.find((l) => /^(fatal|error):/.test(l)) || lines[lines.length - 1];
  return (key || String(e?.message || e).split('\n')[0]).replace(/^(fatal|error):\s*/, '');
}

// Turn a git error about a worktree into something a person can act on.
function explainWorktreeError(msg, wt) {
  const m = msg.match(/not a git repository: (.+?)(?:\/\.git)?\/worktrees\//);
  if (m) {
    return {
      kind: 'broken-link',
      message: `This worktree's link to its repository is broken: it points to ${m[1]}, which isn't where the repository is now. This usually happens after the repository is moved. Repair runs \`git worktree repair\`, which rewrites the links for every worktree of this repository at once; no code in any worktree changes.`,
      detail: msg,
    };
  }
  if (/cannot be (moved or )?removed|containing submodules/.test(msg)) {
    return { kind: 'submodules', message: 'Git won\'t remove a worktree that contains submodules. Remove it by hand if you\'re sure.', detail: msg };
  }
  if (/contains modified or untracked files|is dirty/.test(msg)) {
    return { kind: 'dirty', message: 'Git found modified or untracked files in it, so it wasn\'t removed.', detail: msg };
  }
  if (/is locked|locked working tree/.test(msg)) {
    return { kind: 'locked', message: 'The worktree is locked. Something (often a Claude session) asked git to keep it.', detail: msg };
  }
  return { kind: 'other', message: msg, detail: msg };
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

const LOCKFILES = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|go\.sum|composer\.lock)$/;

// What kind of uncommitted changes these are, which decides whether removing the worktree could lose work.
function classifyDirty(entries) {
  if (!entries.length) return null;
  if (entries.every((e) => e.xy === ' D' || e.xy === 'D ')) return 'deleted-only'; // files missing from disk; still in the branch
  if (entries.every((e) => LOCKFILES.test(e.file) && /M/.test(e.xy))) return 'lockfile-only';
  return 'work';
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
      wt.unmatched = null;
      // Commits no remote has (lost with the branch if it's ever deleted), and, for a detached
      // HEAD, commits on no ref at all (lost with the worktree, since only its HEAD points at them).
      const count = async (args) => Number((await git(wt.path, ['rev-list', '--count', 'HEAD', '--not', ...args]).catch(() => '-1')).trim());
      wt.unpushed = await count(['--remotes']);
      wt.orphaned = wt.detached ? await count(['--branches', '--remotes', '--tags']) : 0;
    }
    wt.dirty = entries.length;
    wt.dirtyFiles = entries.slice(0, 50).map((e) => ({ xy: e.xy, file: e.file }));
    wt.dirtyKind = classifyDirty(entries);
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
    try {
      await refreshWorktree(wt);
      if (wt.error) { wt.error = null; changed(); }
    } catch (e) {
      const err = explainWorktreeError(gitError(e), wt);
      if (wt.error?.detail !== err.detail) { wt.error = err; changed(); }
    }
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

function cleanupStatus(wt, opts) {
  if (wt.isMain) return null;
  if (wt.pr?.state === 'MERGED' && wt.branch) return mergedStatus(wt, opts);
  return idleStatus(wt, opts);
}

// Reasons that apply to removing any worktree: what git can't do, and what would be lost.
function commonBlockers(wt, { ignoreBusy = false } = {}) {
  const reasons = [], notes = [];
  let forceable = true;
  const hard = (r) => { reasons.push(r); forceable = false; };
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

const dirtySummary = (wt) => (wt.dirty ? { kind: wt.dirtyKind, count: wt.dirty, files: wt.dirtyFiles.slice(0, 20) } : null);

// A worktree no Claude session is using and whose PR hasn't merged. Removing it is only ever
// manual, and its branch is always kept, so the only things at risk are uncommitted files
// and commits on a detached HEAD.
function idleStatus(wt, opts) {
  const { reasons, notes, hard, forceable } = commonBlockers(wt, opts);
  if (Date.now() - wt.lastActivity < 10 * 60_000) hard('changed in the last 10 minutes, so something may still be working in it');
  if (wt.detached && !(wt.orphaned >= 0)) hard("couldn't check whether the commits on its detached HEAD are on a branch");
  else if (wt.orphaned > 0) hard(`${wt.orphaned} commit${wt.orphaned === 1 ? '' : 's'} on its detached HEAD ${wt.orphaned === 1 ? "isn't" : "aren't"} on any branch; create a branch first (git switch -c <name>)`);
  if (wt.branch) {
    const unpushed = Math.min(wt.unpushed, wt.ahead);
    const pushed = unpushed > 0 ? `, ${unpushed === wt.ahead ? (wt.ahead === 1 ? 'not pushed' : 'none of them pushed') : `${unpushed} not pushed`}` : wt.unpushed === 0 ? ', all pushed' : '';
    notes.push(`the branch ${wt.branch} is kept${wt.ahead ? ` with its ${wt.ahead} commit${wt.ahead === 1 ? '' : 's'}${pushed}` : ''}`);
  } else if (wt.orphaned === 0) notes.push('detached HEAD; its commit is on a branch, so nothing is lost');
  if (wt.pr?.state === 'OPEN') notes.push(`PR #${wt.pr.number} is still open; removing the worktree doesn't affect it`);
  return {
    kind: 'idle', eligible: reasons.length === 0, reasons, notes, branchSafe: false,
    forceable: reasons.length > 0 && forceable(), dirty: dirtySummary(wt), unmatched: [], auto: false,
  };
}

function mergedStatus(wt, opts) {
  const pr = wt.pr;
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
    auto: config.autoCleanup && Date.parse(pr.mergedAt) >= state.installedAt,
  };
}

// Is the local branch's work all in the merged PR? Fetches the PR's head if it isn't local yet,
// and matches commits by content so a rebased PR still counts.
async function checkBranchInPR(wt) {
  const pr = wt.pr;
  const repo = repos.get(wt.repoKey);
  if (wt.head === pr.headRefOid) { wt.headInMerged = true; wt.unmatched = []; return; }
  if (!(await gitOk(repo.root, ['cat-file', '-e', `${pr.headRefOid}^{commit}`]))) {
    await run('git', ['fetch', '-q', 'origin', pr.headRefOid], { cwd: repo.root, timeout: 60_000 }).catch(() => {});
    if (!(await gitOk(repo.root, ['cat-file', '-e', `${pr.headRefOid}^{commit}`]))) {
      wt.headInMerged = false;
      wt.unmatched = [];
      return;
    }
  }
  if (await gitOk(wt.path, ['merge-base', '--is-ancestor', wt.head, pr.headRefOid])) { wt.headInMerged = true; wt.unmatched = []; return; }
  const cherry = await git(wt.path, ['cherry', pr.headRefOid, wt.head]).catch(() => '');
  const shas = cherry.split('\n').filter((l) => l.startsWith('+ ')).map((l) => l.slice(2).trim());
  wt.unmatched = [];
  for (const sha of shas.slice(0, 50)) {
    const subject = (await git(wt.path, ['log', '-1', '--format=%s', sha]).catch(() => '')).trim();
    wt.unmatched.push({ sha, subject });
  }
  // Every non-merge commit has an equivalent in the PR: the branch was rebased, nothing unique on it.
  wt.headInMerged = shas.length === 0;
}

async function runCleanup() {
  for (const wt of [...wts.values()]) {
    const pr = wt.pr;
    if (!pr || pr.state !== 'MERGED' || wt.isMain || !wt.head) continue;
    if (wt.headInMerged === null && !wt.error) {
      await checkBranchInPR(wt).catch((e) => log('branch check failed', wt.path, e.message));
      changed();
    }
    const cs = cleanupStatus(wt);
    if (cs?.kind === 'merged' && cs.eligible && cs.auto && !wt.busy) {
      try { await removeWorktree(wt, 'auto'); } catch (e) { log('auto-cleanup skipped', wt.path, e.message); }
    }
  }
}

async function removeWorktree(wt, how, { force = false } = {}) {
  const repo = repos.get(wt.repoKey);
  refreshSessions();
  try {
    await refreshWorktree(wt, { force: true });
    wt.error = null;
  } catch (e) {
    wt.error = explainWorktreeError(gitError(e), wt);
    changed();
  }
  const cs = cleanupStatus(wt, { ignoreBusy: true });
  if (!cs) throw new Error("The repository's main checkout can't be removed.");
  if (!cs.eligible && !(force && cs.forceable)) throw new Error(`Not safe to remove: ${cs.reasons.join('; ')}.`);
  // git refuses a dirty worktree without --force; only pass it when nothing unique can be lost or you asked for it.
  const forceGit = force || wt.dirtyKind === 'deleted-only';
  // No --force: git refuses if anything modified or untracked appeared in the meantime.
  try {
    await run('git', ['worktree', 'remove', ...(forceGit ? ['--force'] : []), wt.path], { cwd: repo.root });
  } catch (e) {
    const err = explainWorktreeError(gitError(e), wt);
    throw httpError(409, `Git refused to remove it: ${err.message}`);
  }
  let branchDeleted = false;
  let branchKept = null;
  if (cs.kind === 'idle') branchKept = wt.branch ? 'kept: it isn\'t merged' : null;
  else if (force) branchKept = 'kept because the worktree was removed with uncommitted changes';
  else if (!cs.branchSafe) branchKept = cs.notes.find((n) => n.startsWith('the branch is kept')) || 'kept: not all of its commits are in the merged PR';
  else {
    try {
      const tip = (await git(repo.root, ['rev-parse', `refs/heads/${wt.branch}`])).trim();
      if (tip === wt.head) { await git(repo.root, ['branch', '-D', wt.branch]); branchDeleted = true; }
      else branchKept = 'kept: the branch has moved since it was checked';
    } catch {}
  }
  await git(repo.root, ['worktree', 'prune']).catch(() => {});
  state.cleaned.unshift({
    path: wt.path, branch: wt.branch, sha: wt.head, repoRoot: repo.root, how: force ? 'forced' : how, branchDeleted, branchKept, at: Date.now(),
    lostFiles: force ? wt.dirtyFiles.map((f) => f.file) : undefined, reason: cs.kind,
    pr: wt.pr ? { number: wt.pr.number, url: wt.pr.url, title: wt.pr.title, state: wt.pr.state } : null,
  });
  state.cleaned = state.cleaned.slice(0, 100);
  delete state.worktrees[wt.id];
  wts.delete(wt.id);
  log(`removed worktree ${wt.path} (${how}, ${cs.kind === 'merged' ? `PR #${wt.pr.number} merged` : 'no session using it'})`);
  save();
  changed();
}

// ---------- background jobs (bulk cleanup, single removals) ----------
// Removing a worktree deletes its files, which takes seconds for a big repo, so
// removals run here and report progress over the live connection.

const jobs = [];
let pendingShutdown = null;

function shutdownNow(replacement) {
  if (replacement) {
    const out = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
    server.close();
    // Give the port a moment to free up before the replacement binds it.
    setTimeout(() => {
      spawn(process.execPath, [replacement], { cwd: path.resolve(path.dirname(replacement), '..'), detached: true, stdio: ['ignore', out, out], env: process.env }).unref();
      process.exit(0);
    }, 300);
  } else process.exit(0);
}

function startJob(kind, title, items, worker) {
  if (kind === 'cleanup' && jobs.some((j) => j.kind === 'cleanup' && j.status === 'running')) {
    throw httpError(409, 'A cleanup is already running.');
  }
  const job = {
    id: newId('j'), kind, title, total: items.length, done: 0, current: null,
    ok: [], failed: [], status: 'running', startedAt: Date.now(), finishedAt: null, dismissed: false,
  };
  jobs.unshift(job);
  jobs.splice(20);
  (async () => {
    for (const wt of items) {
      job.current = { id: wt.id, branch: wt.branch, path: wt.path, startedAt: Date.now() };
      wt.busy = kind;
      changed();
      try {
        await worker(wt);
        job.ok.push({ id: wt.id, branch: wt.branch, path: wt.path });
      } catch (e) {
        job.failed.push({ id: wt.id, branch: wt.branch, path: wt.path, error: e.message, kind: wt.error?.kind || null });
      } finally {
        wt.busy = null;
      }
      job.done++;
      changed();
    }
    job.current = null;
    job.status = 'done';
    job.finishedAt = Date.now();
    log(`${job.title}: ${job.ok.length} ok, ${job.failed.length} failed`, job.failed.map((f) => `${f.path}: ${f.error}`).join(' | '));
    changed();
    if (pendingShutdown && !jobs.some((j) => j.status === 'running')) setTimeout(() => shutdownNow(pendingShutdown.replacement), 1000);
  })();
  return job;
}

// `git worktree repair` rewrites the links between a repository and its worktrees after either moves.
async function repairWorktrees(list) {
  const fixed = [], failed = [];
  for (const wt of list) {
    const repo = repos.get(wt.repoKey);
    try {
      await run('git', ['worktree', 'repair', wt.path], { cwd: repo.root });
      wt.error = null;
      await refreshWorktree(wt, { force: true });
      fixed.push({ path: wt.path, branch: wt.branch });
      log(`repaired worktree link ${wt.path}`);
    } catch (e) {
      const err = explainWorktreeError(gitError(e), wt);
      wt.error = err;
      failed.push({ id: wt.id, path: wt.path, branch: wt.branch, error: err.message });
    }
  }
  changed();
  return { fixed, failed };
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

const DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/'];
const MAX_DIFF = 30 * 1024 * 1024;

async function branchCommits(wt) {
  // Oldest first, so commit #1 is where the branch starts.
  // Unit/record separators, because commit bodies span several lines.
  return (await git(wt.path, ['log', '--reverse', '--format=%H%x1f%ct%x1f%an%x1f%s%x1f%b%x1e', `${wt.mergeBase}..HEAD`]))
    .split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r, i) => {
      const [sha, ct, author, subject, body = ''] = r.split('\x1f');
      return { n: i + 1, sha, time: Number(ct) * 1000, author, subject, body: body.trim() };
    });
}

// Which commits touched each file (by commit number), plus 0 for uncommitted changes.
async function fileCommitMap(wt, commits, tree) {
  const map = {};
  const byShaN = new Map(commits.map((c) => [c.sha, c.n]));
  if (commits.length) {
    const out = await git(wt.path, ['log', '--reverse', '--format=@%H', '--name-only', '-M', `${wt.mergeBase}..HEAD`]);
    let n = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('@')) n = byShaN.get(line.slice(1));
      else if (line && n) (map[line] ||= []).includes(n) || map[line].push(n);
    }
  }
  const dirty = await git(wt.path, ['diff', '--name-only', '-M', 'HEAD', tree]);
  for (const f of dirty.split('\n').filter(Boolean)) (map[f] ||= []).push(0);
  return map;
}

// Per-line attribution for the working version of each changed file: runs of
// [startLine, endLine, commitNumber], where 0 means not committed yet.
async function blameWorktree(wt, files, commits) {
  const byShaN = new Map(commits.map((c) => [c.sha, c.n]));
  const result = {};
  await Promise.all(files.slice(0, 200).map(async (file) => {
    const abs = path.join(wt.path, file);
    try { if (fs.statSync(abs).size > 2 * 1024 * 1024) return; } catch { return; }
    let out;
    try { out = await git(wt.path, ['blame', '--porcelain', '--contents', abs, `${wt.mergeBase}..`, '--', file], { timeout: 20_000 }); } catch { return; }
    const runs = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
      if (!m) continue;
      const n = /^0{40}$/.test(m[1]) ? 0 : byShaN.get(m[1]);
      if (n === undefined) continue; // from before the branch
      const ln = Number(m[2]);
      const last = runs[runs.length - 1];
      if (last && last[2] === n && last[1] === ln - 1) last[1] = ln; else runs.push([ln, ln, n]);
    }
    if (runs.length) result[file] = runs;
  }));
  return result;
}

async function getBlame(wt) {
  await refreshWorktree(wt);
  if (!wt.mergeBase) throw httpError(409, wt.baseError || 'No merge base');
  if (wt.blame?.fp === wt.fingerprint) return wt.blame.data;
  const fp = wt.fingerprint;
  const tree = await snapshotTree(wt);
  const commits = await branchCommits(wt);
  const files = (await git(wt.path, ['diff', '--name-only', '--diff-filter=d', '-M', wt.mergeBase, tree])).split('\n').filter(Boolean);
  const data = { fingerprint: fp, lines: await blameWorktree(wt, files, commits) };
  wt.blame = { fp, data };
  return data;
}

async function getCommitDiffs(wt, tree, commits) {
  const shown = commits.slice(-100);
  let budget = MAX_DIFF;
  const out = [];
  for (const c of shown) {
    const diff = budget > 0 ? await git(wt.path, [...DIFF_ARGS, `${c.sha}^`, c.sha]).catch(() => '') : '';
    budget -= diff.length;
    out.push({ ...c, diff: diff.slice(0, Math.max(0, budget + diff.length)), truncated: budget < 0 });
  }
  const uncommitted = await git(wt.path, [...DIFF_ARGS, 'HEAD', tree]);
  return { commits: out, hiddenCommits: commits.length - shown.length, uncommitted: uncommitted.slice(0, MAX_DIFF) };
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
  const commits = await branchCommits(wt);
  const base = {
    sinceAvailable, reviewedAt: s.reviewedAt || null,
    fingerprint: wt.fingerprint, tree, mergeBase: wt.mergeBase,
    baseRef: wt.baseRef, baseSource: wt.baseSource, commits,
    viewed: s.viewed || {},
  };
  if (mode === 'commits') return { ...base, mode: 'commits', ...(await getCommitDiffs(wt, tree, commits)) };
  const diff = await git(wt.path, [...DIFF_ARGS, from, tree]);
  return {
    fileCommits: await fileCommitMap(wt, commits, tree),
    ...base,
    mode: from === wt.mergeBase ? 'full' : 'since',
    truncated: diff.length > MAX_DIFF,
    diff: diff.slice(0, MAX_DIFF),
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
    const where = c.commit ? ` (as of commit ${c.commit.slice(0, 8)}${c.commitSubject ? ` "${c.commitSubject}"` : ''})` : '';
    lines.push('', `### ${c.file}:${c.line}${c.side === 'old' ? ' (removed line)' : ''}${where}  [${c.id}]`);
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

// ---------- integrations (gh, CodeRabbit, Claude hooks) ----------

let lastHookAt = null;
let integrations = { at: 0, data: null, pending: null };
let crLogin = null; // { running, url, error, startedAt }

async function probe(cmd, args, opts = {}) {
  try {
    return { ok: true, out: await run(cmd, args, { timeout: 15_000, ...opts }) };
  } catch (e) {
    return { ok: false, missing: e.code === 'ENOENT', out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}
const lastJson = (text) => {
  const lines = String(text || '').trim().split('\n').reverse();
  for (const l of lines) { try { return JSON.parse(l); } catch {} }
  return null;
};

async function checkIntegrations() {
  const [ghV, ghAuth, crV, crStatus, crPlain] = await Promise.all([
    probe('gh', ['--version']),
    probe('gh', ['auth', 'status', '--hostname', 'github.com']),
    probe('coderabbit', ['--version']),
    probe('coderabbit', ['auth', 'status', '--agent']),
    probe('coderabbit', ['auth', 'status']),
  ]);
  const gh = { installed: !ghV.missing, version: ghV.out.match(/gh version (\S+)/)?.[1] || null, authed: ghAuth.ok };
  gh.account = ghAuth.out.match(/account (\S+)/)?.[1] || null;
  const st = lastJson(crStatus.out);
  const cr = { installed: !crV.missing, version: crV.ok ? crV.out.trim().split('\n')[0] : null, authed: !!st?.authenticated };
  if (st?.authenticated) {
    cr.user = st.user?.username || st.user?.name;
    cr.email = st.user?.email;
    cr.org = st.currentOrg?.name || null;
    cr.orgs = (st.organizations || []).map((o) => o.name);
    cr.plan = crPlain.out.match(/Plan\s*:\s*(.+)/)?.[1]?.trim() || null;
    cr.seat = crPlain.out.match(/Seat\s*:\s*(.+)/)?.[1]?.trim() || null;
  }
  return {
    gh, coderabbit: cr, coderabbitLogin: crLogin,
    claude: { lastHookAt, sessions: sessions.size, version: VERSION },
    node: process.version, dataDir: DATA_DIR, configPath: CONFIG_PATH,
  };
}

async function getIntegrations(force = false) {
  if (!force && integrations.data && Date.now() - integrations.at < 60_000) {
    return { ...integrations.data, coderabbitLogin: crLogin, claude: { lastHookAt, sessions: sessions.size, version: VERSION } };
  }
  integrations.pending ||= checkIntegrations().then((data) => {
    integrations = { at: Date.now(), data, pending: null };
    return data;
  }, (e) => { integrations.pending = null; throw e; });
  return integrations.pending;
}

function startCodeRabbitLogin() {
  if (crLogin?.running) return crLogin;
  crLogin = { running: true, url: null, error: null, startedAt: Date.now() };
  const child = spawn('coderabbit', ['auth', 'login', '--agent'], { env: process.env });
  let out = '';
  const onData = (d) => {
    out += d;
    const url = out.match(/https:\/\/app\.coderabbit\.ai\/login[^\s"'\]]*/)?.[0];
    if (url && !crLogin.url) { crLogin.url = url.replace(/&amp;/g, '&'); changed(); }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const timer = setTimeout(() => child.kill(), 5 * 60_000);
  child.on('error', (e) => { crLogin = { ...crLogin, running: false, error: e.code === 'ENOENT' ? 'CodeRabbit CLI is not installed.' : e.message }; changed(); });
  child.on('close', async (code) => {
    clearTimeout(timer);
    const result = lastJson(out);
    crLogin = { ...crLogin, running: false, error: code === 0 ? null : (result?.message || result?.error || 'Login did not finish.') };
    await getIntegrations(true).catch(() => {});
    changed();
  });
  changed();
  return crLogin;
}

// Read-only folder listing for the folder picker, limited to the home directory.
const SKIP_DIRS = new Set(['node_modules', '.git', '.Trash', 'Library', '.cache', '.npm', '.pnpm-store']);
function listDir(p, showHidden) {
  const full = path.resolve(expand(p || '~'));
  if (full !== HOME && !full.startsWith(HOME + path.sep)) throw httpError(403, 'Only folders inside your home directory can be browsed.');
  let dirents;
  try { dirents = fs.readdirSync(full, { withFileTypes: true }); } catch { throw httpError(404, `Can't open ${full}`); }
  const isRepo = (d) => fs.existsSync(path.join(d, '.git'));
  const entries = [];
  for (const e of dirents) {
    if (SKIP_DIRS.has(e.name) || (!showHidden && e.name.startsWith('.'))) continue;
    const child = path.join(full, e.name);
    let dir = e.isDirectory();
    if (!dir && e.isSymbolicLink()) { try { dir = fs.statSync(child).isDirectory(); } catch {} }
    if (!dir) continue;
    entries.push({ name: e.name, path: child, isRepo: isRepo(child) });
    if (entries.length >= 1000) break;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return {
    path: full,
    display: full === HOME ? '~' : full.startsWith(HOME + path.sep) ? '~' + full.slice(HOME.length) : full,
    parent: full === HOME ? null : path.dirname(full),
    isRepo: isRepo(full),
    repoChildren: entries.filter((e) => e.isRepo).length,
    entries,
  };
}

// ---------- CodeRabbit reviews ----------

const crChildren = new Map(); // wtId -> child process

function crUsage(wt) {
  return probe('coderabbit', ['usage', '--agent'], { cwd: wt.path }).then((r) => {
    const u = lastJson(r.out)?.includedReviews;
    return u?.state === 'available' ? { limit: u.limit, remaining: u.remaining, fullInMs: u.fullCapacityInMs, windowMs: u.rollingWindowMs, repository: u.repository } : null;
  });
}

const asText = (v) => (v == null ? '' : typeof v === 'string' ? v : Array.isArray(v) ? v.map(asText).filter(Boolean).join('\n\n') : typeof v === 'object' ? (v.text || v.code || v.suggestion || v.diff || v.command || JSON.stringify(v, null, 2)) : String(v));

function toFinding(ev) {
  const start = Number(ev.startLine ?? ev.line ?? ev.lineStart) || null;
  return {
    id: newId('f'),
    severity: String(ev.severity || 'info').toLowerCase(),
    file: ev.fileName || ev.file || ev.path || '',
    startLine: start,
    endLine: Number(ev.endLine ?? ev.lineEnd) || start,
    title: asText(ev.title),
    comment: asText(ev.comment),
    codegen: asText(ev.codegenInstructions),
    suggestions: asText(ev.suggestions),
    status: 'open',
  };
}

async function startCodeRabbit(wt) {
  const prev = state.coderabbit[wt.id];
  if (prev?.status === 'running') throw httpError(409, 'A CodeRabbit review is already running for this worktree.');
  const integ = await getIntegrations();
  if (!integ.coderabbit.installed) throw httpError(409, 'The CodeRabbit CLI is not installed. See Settings.');
  if (!integ.coderabbit.authed) throw httpError(409, 'Sign in to CodeRabbit in Settings first.');
  await refreshWorktree(wt);
  const usage = await crUsage(wt);
  if (usage && usage.remaining <= 0) {
    throw httpError(429, `No CodeRabbit reviews left for ${usage.repository} this hour. Try again in about ${Math.ceil(usage.fullInMs / 60000)} minutes.`);
  }
  const review = {
    status: 'running', startedAt: Date.now(), finishedAt: null, baseRef: wt.baseRef, fingerprint: wt.fingerprint,
    findings: [], reviewedFiles: [], error: null, heartbeatAt: Date.now(),
    usage: usage ? { ...usage, remaining: Math.max(0, usage.remaining - 1) } : null,
  };
  state.coderabbit[wt.id] = review;
  const child = spawn('coderabbit', ['review', '--agent', '--base', wt.baseRef, '--include-untracked'], { cwd: wt.path, env: process.env });
  crChildren.set(wt.id, child);
  let buf = '', errText = '';
  const handle = (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    review.heartbeatAt = Date.now();
    if (ev.type === 'finding') {
      const f = toFinding(ev);
      try {
        const lines = fs.readFileSync(path.join(wt.path, f.file), 'utf8').split('\n');
        if (f.startLine) f.snippet = lines.slice(f.startLine - 1, Math.min(f.endLine || f.startLine, f.startLine + 4)).join('\n');
      } catch {}
      review.findings.push(f);
    }
    else if (ev.type === 'complete') { review.reviewedFiles = ev.reviewedFiles || []; review.message = ev.message; }
    else if (ev.type === 'error') review.error = ev.message || ev.error || 'CodeRabbit reported an error.';
    else if (ev.type === 'status' && ev.message) review.message = ev.message;
    save();
    changed();
  };
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr.on('data', (d) => { errText = (errText + d).slice(-4000); });
  child.on('error', (e) => { review.status = 'failed'; review.error = e.message; save(); changed(); });
  child.on('close', (code, signal) => {
    if (buf.trim()) handle(buf);
    crChildren.delete(wt.id);
    review.finishedAt = Date.now();
    if (review.status === 'cancelled') { /* set by cancel */ }
    else if (code === 0 && !review.error) review.status = 'done';
    else {
      review.status = 'failed';
      review.error ||= signal ? `Stopped (${signal}).` : (errText.trim().split('\n').pop() || `CodeRabbit exited with code ${code}.`);
    }
    log(`CodeRabbit review ${review.status} for ${wt.path}: ${review.findings.length} findings`);
    save();
    changed();
  });
  save();
  changed();
  return review;
}

function getFinding(fid) {
  for (const [wtId, r] of Object.entries(state.coderabbit)) {
    const f = r.findings?.find((x) => x.id === fid);
    if (f) return { wtId, review: r, finding: f };
  }
  throw httpError(404, 'Unknown finding');
}

function findingToComment(wtId, f) {
  const wt = getWt(wtId);
  const parts = [`**CodeRabbit (${f.severity})${f.title ? `: ${f.title}` : ''}**`];
  if (f.comment && f.comment !== f.title) parts.push(f.comment);
  if (f.suggestions) parts.push(`Suggested change:\n\`\`\`\n${f.suggestions}\n\`\`\``);
  if (f.codegen && f.codegen !== f.comment) parts.push(`Fix guidance from CodeRabbit:\n${f.codegen}`);
  const c = {
    id: newId('c'), wtId: wt.id, wtPath: wt.path, file: f.file, line: f.endLine || f.startLine || 1, side: 'new',
    lineText: '', body: parts.join('\n\n'), status: 'draft', createdAt: Date.now(), replies: [], fromFinding: f.id,
  };
  try {
    const text = fs.readFileSync(path.join(wt.path, f.file), 'utf8').split('\n');
    c.lineText = text[(c.line || 1) - 1] ?? '';
  } catch {}
  state.comments.push(c);
  f.status = 'sent';
  f.commentId = c.id;
  return c;
}

const CONFIG_RULES = {
  autoCleanup: (v) => typeof v === 'boolean',
  editor: (v) => ['vscode', 'cursor', 'windsurf', 'zed', 'none'].includes(v),
  recentDays: (v) => Number.isInteger(v) && v >= 1 && v <= 90,
  prPollMinutes: (v) => Number.isInteger(v) && v >= 1 && v <= 60,
  roots: (v) => Array.isArray(v) && v.every((p) => typeof p === 'string'),
  extraRepos: (v) => Array.isArray(v) && v.every((p) => typeof p === 'string'),
};

async function updateConfig(body) {
  const errors = [];
  for (const [k, v] of Object.entries(body)) {
    if (!CONFIG_RULES[k]) continue;
    if (!CONFIG_RULES[k](v)) { errors.push(`Invalid value for ${k}`); continue; }
    if (k === 'roots' || k === 'extraRepos') {
      const missing = v.filter((p) => !fs.existsSync(expand(p.trim())));
      if (missing.length) { errors.push(`Folder not found: ${missing.join(', ')}`); continue; }
      config[k] = [...new Set(v.map((p) => p.trim()).filter(Boolean))];
    } else config[k] = v;
  }
  if (errors.length) throw httpError(400, errors.join('; '));
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  if ('roots' in body || 'extraRepos' in body) await discoverWorktrees();
  changed();
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
    config: {
      autoCleanup: config.autoCleanup, recentDays: cfgDays, editor: config.editor,
      prPollMinutes: config.prPollMinutes, roots: config.roots, extraRepos: config.extraRepos,
    },
    onboardedAt: state.onboardedAt || null,
    repos: [...repos.values()].map((r) => ({ name: r.name, root: r.root, github: r.gh ? `${r.gh.owner}/${r.gh.name}` : null })),
    coderabbitLogin: crLogin,
    jobs: jobs.filter((j) => !j.dismissed).slice(0, 5),
    coderabbitReady: !!(integrations.data?.coderabbit.installed && integrations.data?.coderabbit.authed),
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
        error: wt.error || null,
        busy: wt.busy || null,
        dirtyKind: wt.dirtyKind || null,
        coderabbit: (() => {
          const r = state.coderabbit[wt.id];
          if (!r) return null;
          return {
            status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, heartbeatAt: r.heartbeatAt,
            open: r.findings.filter((f) => f.status === 'open').length, total: r.findings.length,
            sig: sha1(r.status + r.findings.map((f) => f.id + f.status).join()).slice(0, 10),
          };
        })(),
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
  ['GET', /^\/api\/worktrees\/(\w+)\/blame$/, (m) => getBlame(getWt(m[1]))],
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
  ['POST', /^\/api\/worktrees\/(\w+)\/remove$/, (m, body) => {
    const wt = getWt(m[1]);
    if (wt.busy) throw httpError(409, 'This worktree is already being removed.');
    const force = body.force === true;
    return startJob('remove', `Removing ${wt.branch || 'worktree'}${force ? ' (anyway)' : ''}`, [wt], (w) => removeWorktree(w, 'manual', { force }));
  }],
  // Test-only (WTR_TEST_JOBS=1): a slow fake cleanup over pretend worktrees, to exercise the progress UI.
  ...(process.env.WTR_TEST_JOBS === '1' ? [['POST', /^\/api\/test\/job$/, (m, body) => {
    const items = Array.from({ length: body.count || 4 }, (_, i) => ({ id: `test${i}`, branch: `test/branch-${i + 1}`, path: `${HOME}/fake/wt-${i + 1}` }));
    return startJob('cleanup', `Removing ${items.length} merged worktrees`, items, async (w) => {
      await new Promise((r) => setTimeout(r, body.delay || 1500));
      if (w.id === `test${(body.failAt ?? -1)}`) throw new Error("Git refused to remove it: Git found modified or untracked files in it, so it wasn't removed.");
    });
  }]] : []),
  ['POST', /^\/api\/jobs\/(\w+)\/dismiss$/, (m) => {
    const job = jobs.find((j) => j.id === m[1]);
    if (job) job.dismissed = true;
    changed();
    return { ok: true };
  }],
  ['POST', /^\/api\/cleanup\/safe$/, () => {
    const items = [...wts.values()].filter((wt) => {
      const cs = !wt.busy && cleanupStatus(wt);
      return cs && cs.kind === 'merged' && cs.eligible;
    });
    if (!items.length) throw httpError(409, 'Nothing is safe to remove right now.');
    return startJob('cleanup', `Removing ${items.length} merged worktree${items.length === 1 ? '' : 's'}`, items, (wt) => removeWorktree(wt, 'manual'));
  }],
  // Remove the worktrees you picked on the clean-up page. Each is checked again just before removal.
  ['POST', /^\/api\/cleanup$/, (m, body) => {
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const items = ids.map((id) => wts.get(id)).filter((wt) => wt && !wt.busy && cleanupStatus(wt)?.eligible);
    if (!items.length) throw httpError(409, 'None of those can be removed right now.');
    return startJob('cleanup', `Removing ${items.length} worktree${items.length === 1 ? '' : 's'}`, items, (wt) => removeWorktree(wt, 'manual'));
  }],
  ['POST', /^\/api\/worktrees\/(\w+)\/repair$/, async (m) => repairWorktrees([getWt(m[1])])],
  ['POST', /^\/api\/repair$/, async () => repairWorktrees([...wts.values()].filter((w) => w.error?.kind === 'broken-link'))],
  ['POST', /^\/api\/config$/, async (m, body) => { await updateConfig(body); return { ok: true }; }],
  ['GET', /^\/api\/worktrees\/(\w+)\/coderabbit$/, async (m, body, url) => {
    const wt = getWt(m[1]);
    const review = state.coderabbit[wt.id] || null;
    return { review, usage: url.searchParams.has('usage') ? await crUsage(wt) : review?.usage || null };
  }],
  ['POST', /^\/api\/worktrees\/(\w+)\/coderabbit$/, (m) => startCodeRabbit(getWt(m[1]))],
  ['POST', /^\/api\/worktrees\/(\w+)\/coderabbit\/cancel$/, (m) => {
    const r = state.coderabbit[m[1]];
    const child = crChildren.get(m[1]);
    if (!r || r.status !== 'running') throw httpError(409, 'No review is running.');
    r.status = 'cancelled';
    r.error = 'Cancelled. CodeRabbit discards a review that is stopped early.';
    child?.kill();
    save();
    changed();
    return { ok: true };
  }],
  ['POST', /^\/api\/findings\/(\w+)\/(send|dismiss|restore)$/, (m) => {
    const { wtId, finding } = getFinding(m[1]);
    if (m[2] === 'send') findingToComment(wtId, finding);
    else if (m[2] === 'dismiss') finding.status = 'dismissed';
    else finding.status = 'open';
    save();
    changed();
    return finding;
  }],
  ['POST', /^\/api\/worktrees\/(\w+)\/coderabbit\/send-all$/, (m) => {
    const r = state.coderabbit[getWt(m[1]).id];
    const open = (r?.findings || []).filter((f) => f.status === 'open');
    for (const f of open) findingToComment(m[1], f);
    save();
    changed();
    return { sent: open.length };
  }],
  ['GET', /^\/api\/fs$/, (m, body, url) => listDir(url.searchParams.get('path'), url.searchParams.get('hidden') === '1')],
  ['GET', /^\/api\/integrations$/, (m, body, url) => getIntegrations(url.searchParams.has('refresh'))],
  ['POST', /^\/api\/integrations\/coderabbit\/login$/, () => startCodeRabbitLogin()],
  ['POST', /^\/api\/integrations\/coderabbit\/logout$/, async () => {
    await probe('coderabbit', ['auth', 'logout', '--agent']);
    return getIntegrations(true);
  }],
  ['POST', /^\/api\/onboarding$/, (m, body) => {
    state.onboardedAt = body.done === false ? null : Date.now();
    save();
    changed();
    return { ok: true };
  }],
  ['POST', /^\/api\/comments$/, (m, body) => {
    const wt = getWt(body.wtId);
    if (!body.body?.trim()) throw httpError(400, 'Empty comment');
    const c = {
      id: newId('c'), wtId: wt.id, wtPath: wt.path, file: body.file, line: body.line, side: body.side,
      lineText: body.lineText, body: body.body.trim(), status: 'draft', createdAt: Date.now(), replies: [],
      commit: /^[0-9a-f]{40}$/.test(body.commit || '') ? body.commit : undefined,
      commitSubject: body.commitSubject || undefined,
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
  ['POST', /^\/api\/shutdown$/, (m, body) => {
    // Never cut a removal off halfway: finish running jobs, then hand over to the replacement if one was named.
    const replacement = typeof body.restartWith === 'string' && body.restartWith.endsWith('server.mjs') && fs.existsSync(body.restartWith) ? body.restartWith : null;
    if (jobs.some((j) => j.status === 'running')) {
      pendingShutdown = { replacement };
      log(`shutdown requested; waiting for running jobs to finish${replacement ? `, then starting ${replacement}` : ''}`);
      return { ok: true, deferred: true };
    }
    setTimeout(() => shutdownNow(replacement), 100);
    return { ok: true };
  }],
  ['POST', /^\/api\/hook$/, (m, body) => {
    lastHookAt = Date.now();
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
      send(res, e.status || 500, { error: e.status ? e.message.split('\n')[0] : (e.stderr ? gitError(e) : e.message.split('\n')[0]) });
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
  setTimeout(() => loop(fn, ms), typeof ms === 'function' ? ms() : ms);
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { log(`Port ${PORT} is already in use; another copy is probably running.`); process.exit(0); }
  throw e;
});

server.listen(PORT, '127.0.0.1', async () => {
  log(`Worktree Review ${VERSION} on http://127.0.0.1:${PORT}  (data: ${DATA_DIR})`);
  await discoverWorktrees();
  refreshSessions();
  getIntegrations().then(changed, () => {});
  loop(discoverWorktrees, 30_000);
  loop(async () => refreshSessions(), 3_000);
  loop(pollWorktrees, 1_000);
  setTimeout(() => loop(refreshPRs, () => config.prPollMinutes * 60_000), 5_000);
});
