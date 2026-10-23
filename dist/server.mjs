// Generated from src/ by build.mjs. Edit the TypeScript source, not this file.

// src/server/main.ts
import fs15 from "node:fs";

// src/server/http.ts
import fs14 from "node:fs";
import http from "node:http";
import path11 from "node:path";

// src/server/exec.ts
import { execFile } from "node:child_process";

// src/server/util.ts
import crypto from "node:crypto";
import fs from "node:fs";
var log = (...a) => console.log((/* @__PURE__ */ new Date()).toISOString(), ...a);
var sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
var newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
var asStr = (v) => typeof v === "string" ? v : void 0;
var rec = (v) => isRecord(v) ? v : {};
var firstLine = (s) => s.split("\n")[0] ?? "";
function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

// src/server/exec.ts
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
var prop = (e, k) => typeof e === "object" && e !== null ? e[k] : void 0;
function errInfo(e) {
  const code = prop(e, "code"), status = prop(e, "status");
  return {
    message: String(prop(e, "message") || e),
    code: typeof code === "string" || typeof code === "number" ? code : void 0,
    stdout: String(prop(e, "stdout") || ""),
    stderr: String(prop(e, "stderr") || ""),
    status: typeof status === "number" ? status : void 0
  };
}
function pool(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n) return;
    const start = queue.shift();
    if (!start) return;
    active++;
    start();
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push(() => {
      fn().then(resolve, reject).finally(() => {
        active--;
        next();
      });
    });
    next();
  });
}
var gitPool = pool(6);
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...opts.env },
      maxBuffer: 256 * 1024 * 1024,
      timeout: opts.timeout ?? 6e4
    }, (err, stdout, stderr) => {
      if (err) {
        err.message += `
${stderr}`;
        reject(Object.assign(err, { stdout, stderr }));
      } else resolve(stdout);
    });
  });
}
function gitError(e) {
  const { stderr, message } = errInfo(e);
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const key = lines.find((l) => /^(fatal|error):/.test(l)) || lines[lines.length - 1];
  return (key || firstLine(message)).replace(/^(fatal|error):\s*/, "");
}
function explainWorktreeError(msg) {
  const m = msg.match(/not a git repository: (.+?)(?:\/\.git)?\/worktrees\//);
  if (m) {
    return {
      kind: "broken-link",
      message: `This worktree's link to its repository is broken: it points to ${m[1]}, which isn't where the repository is now. This usually happens after the repository is moved. Repair runs \`git worktree repair\`, which rewrites the links for every worktree of this repository at once; no code in any worktree changes.`,
      detail: msg
    };
  }
  if (/cannot be (moved or )?removed|containing submodules/.test(msg)) {
    return { kind: "submodules", message: "Git won't remove a worktree that contains submodules. Remove it by hand if you're sure.", detail: msg };
  }
  if (/contains modified or untracked files|is dirty/.test(msg)) {
    return { kind: "dirty", message: "Git found modified or untracked files in it, so it wasn't removed.", detail: msg };
  }
  if (/is locked|locked working tree/.test(msg)) {
    return { kind: "locked", message: "The worktree is locked. Something (often a Claude session) asked git to keep it.", detail: msg };
  }
  return { kind: "other", message: msg, detail: msg };
}
var git = (cwd, args, opts) => gitPool(() => run("git", ["-c", "core.quotepath=false", ...args], { ...opts, cwd }));
var gitOk = (cwd, args) => git(cwd, args).then(() => true, () => false);
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errInfo(e).code === "EPERM";
  }
}

// src/server/paths.ts
import fs2 from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
var HERE = path.dirname(fileURLToPath(import.meta.url));
var HOME = os.homedir();
var PORT = Number(process.env.WTR_PORT || 4747);
var CLAUDE_DIR = path.join(HOME, ".claude");
var DATA_DIR = process.env.WTR_DATA_DIR || path.join(CLAUDE_DIR, "worktree-review");
var CONFIG_PATH = path.join(DATA_DIR, "config.json");
var STATE_PATH = path.join(DATA_DIR, "state.json");
var TMP_DIR = path.join(DATA_DIR, "tmp");
var VERSION = (() => {
  try {
    const manifest = JSON.parse(fs2.readFileSync(path.join(HERE, "..", ".claude-plugin", "plugin.json"), "utf8"));
    return isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : "dev";
  } catch {
    return "dev";
  }
})();
fs2.mkdirSync(TMP_DIR, { recursive: true });
var expand = (p) => p.startsWith("~") ? path.join(HOME, p.slice(1)) : p;

// src/server/config.ts
import fs3 from "node:fs";
var DEFAULT_CONFIG = {
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
  editor: "vscode",
  // Effort preselected for Claude code reviews: low, medium, high, xhigh, or max.
  reviewEffort: "low"
};
var EDITORS = ["vscode", "cursor", "windsurf", "zed", "none"];
var isEditor = (v) => typeof v === "string" && EDITORS.includes(v);
var EFFORTS = ["low", "medium", "high", "xhigh", "max"];
var isEffort = (v) => typeof v === "string" && EFFORTS.includes(v);
function loadConfig() {
  const saved = loadJson(CONFIG_PATH, {});
  const o = isRecord(saved) ? saved : {};
  const d = DEFAULT_CONFIG;
  return {
    roots: isStringArray(o.roots) ? o.roots : d.roots,
    extraRepos: isStringArray(o.extraRepos) ? o.extraRepos : d.extraRepos,
    autoCleanup: typeof o.autoCleanup === "boolean" ? o.autoCleanup : d.autoCleanup,
    recentDays: typeof o.recentDays === "number" ? o.recentDays : d.recentDays,
    prPollMinutes: typeof o.prPollMinutes === "number" ? o.prPollMinutes : d.prPollMinutes,
    editor: isEditor(o.editor) ? o.editor : d.editor,
    reviewEffort: isEffort(o.reviewEffort) ? o.reviewEffort : d.reviewEffort
  };
}
var config = loadConfig();
if (!fs3.existsSync(CONFIG_PATH)) fs3.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

// src/server/state.ts
import fs4 from "node:fs";
var repos = /* @__PURE__ */ new Map();
var wts = /* @__PURE__ */ new Map();
var sessions = /* @__PURE__ */ new Map();
var reviewerPids = /* @__PURE__ */ new Set();
function fromCodeRabbit(old) {
  if (!isRecord(old)) return {};
  const out = {};
  for (const [id, r] of Object.entries(old)) {
    out[id] = { coderabbit: { ...r, reviewer: "coderabbit", findings: r.findings.map((f) => ({ ...f, source: "coderabbit" })) } };
  }
  return out;
}
function loadState() {
  const saved = loadJson(STATE_PATH, {});
  const o = isRecord(saved) ? saved : {};
  const state2 = {
    installedAt: typeof o.installedAt === "number" ? o.installedAt : Date.now(),
    worktrees: isRecord(o.worktrees) ? o.worktrees : {},
    comments: Array.isArray(o.comments) ? o.comments : [],
    reviews: Array.isArray(o.reviews) ? o.reviews : [],
    cleaned: Array.isArray(o.cleaned) ? o.cleaned : [],
    trash: Array.isArray(o.trash) ? o.trash : [],
    codeReviews: isRecord(o.codeReviews) ? o.codeReviews : fromCodeRabbit(o.coderabbit)
  };
  if (typeof o.onboardedAt === "number" || o.onboardedAt === null) state2.onboardedAt = o.onboardedAt;
  else if (state2.comments.length || state2.cleaned.length || Object.values(state2.worktrees).some((w) => w.reviewedAt)) state2.onboardedAt = Date.now();
  return state2;
}
var state = loadState();
for (const byReviewer of Object.values(state.codeReviews)) {
  for (const r of Object.values(byReviewer)) if (r.status === "running") {
    r.status = "failed";
    r.error = "Interrupted: the server restarted during the review.";
  }
}
var saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STATE_PATH + ".tmp";
    fs4.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs4.renameSync(tmp, STATE_PATH);
  }, 200);
}
save();
function wtState(id, p) {
  let s = state.worktrees[id];
  if (!s) {
    s = { path: p, viewed: {} };
    state.worktrees[id] = s;
  }
  return s;
}
var dirty = true;
function changed() {
  dirty = true;
}
function takeChanged() {
  const was = dirty;
  dirty = false;
  return was;
}

// src/server/worktrees.ts
import fs6 from "node:fs";
import path3 from "node:path";

// src/server/repos.ts
import fs5 from "node:fs";
import path2 from "node:path";
var claudeCwds = { at: 0, dirs: [] };
var cwdScan = /* @__PURE__ */ new Map();
function recentClaudeCwds() {
  if (Date.now() - claudeCwds.at < 5 * 6e4) return claudeCwds.dirs;
  const dirs = /* @__PURE__ */ new Set();
  const projects = path2.join(CLAUDE_DIR, "projects");
  const cutoff = Date.now() - 30 * 864e5;
  let files = [];
  try {
    for (const d of fs5.readdirSync(projects)) {
      let entries = [];
      try {
        entries = fs5.readdirSync(path2.join(projects, d));
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith(".jsonl")) continue;
        const p = path2.join(projects, d, f);
        try {
          const m = fs5.statSync(p).mtimeMs;
          if (m > cutoff) files.push({ p, m });
        } catch {
        }
      }
    }
  } catch {
  }
  files = files.sort((a, b) => b.m - a.m).slice(0, 300);
  for (const { p } of files) {
    let c = cwdScan.get(p);
    if (!c) {
      c = { offset: 0, dirs: /* @__PURE__ */ new Set(), carry: "" };
      cwdScan.set(p, c);
    }
    try {
      const fd = fs5.openSync(p, "r");
      try {
        const size = fs5.fstatSync(fd).size;
        if (size < c.offset) {
          c.offset = 0;
          c.dirs.clear();
          c.carry = "";
        }
        const buf = Buffer.alloc(4 * 1024 * 1024);
        while (c.offset < size) {
          const n = fs5.readSync(fd, buf, 0, buf.length, c.offset);
          if (!n) break;
          c.offset += n;
          const text = c.carry + buf.toString("utf8", 0, n);
          const cut = text.lastIndexOf("\n");
          c.carry = cut === -1 ? text.slice(-8192) : text.slice(cut + 1).slice(-8192);
          for (const m of text.slice(0, cut + 1).matchAll(/"cwd":"((?:[^"\\]|\\.)+)"/g)) {
            try {
              c.dirs.add(JSON.parse(`"${m[1]}"`));
            } catch {
            }
          }
        }
      } finally {
        fs5.closeSync(fd);
      }
    } catch {
    }
    for (const d of c.dirs) dirs.add(d);
  }
  for (const s of sessions.values()) if (s.cwd) dirs.add(s.cwd);
  claudeCwds = { at: Date.now(), dirs: [...dirs].filter((d) => fs5.existsSync(d)) };
  return claudeCwds.dirs;
}
async function discoverRepos() {
  const candidates = new Set(config.extraRepos.map(expand));
  const known = [...wts.values()].map((w) => w.path);
  for (const dir of recentClaudeCwds()) {
    if (known.some((p) => dir === p || dir.startsWith(p + "/"))) continue;
    try {
      const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
      if (top) {
        candidates.add(top);
        known.push(top);
      }
    } catch {
    }
  }
  for (const root of config.roots.map(expand)) {
    let entries = [];
    try {
      entries = fs5.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path2.join(root, e.name);
      try {
        if (fs5.statSync(path2.join(p, ".git")).isDirectory()) candidates.add(p);
      } catch {
      }
    }
  }
  for (const p of candidates) {
    try {
      const common = fs5.realpathSync(path2.resolve(p, (await git(p, ["rev-parse", "--git-common-dir"])).trim()));
      if (repos.has(common)) continue;
      const mainDir = path2.basename(common) === ".git" ? path2.dirname(common) : p;
      const repo = { root: fs5.existsSync(mainDir) ? mainDir : p, commonDir: common, name: path2.basename(mainDir).replace(/\.git$/, ""), gh: null, defaultBase: "origin/main" };
      try {
        const url = (await git(p, ["remote", "get-url", "origin"])).trim();
        const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
        if (m && m[1] && m[2]) repo.gh = { owner: m[1], name: m[2] };
      } catch {
      }
      try {
        repo.defaultBase = (await git(p, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
      } catch {
        if (!await gitOk(p, ["rev-parse", "--verify", "--quiet", "origin/main"])) repo.defaultBase = "main";
      }
      repos.set(common, repo);
    } catch {
    }
  }
}

// src/server/worktrees.ts
function getWt(id) {
  const wt = id === void 0 ? void 0 : wts.get(id);
  if (!wt) throw httpError(404, "Unknown worktree");
  return wt;
}
function repoOf(wt) {
  const repo = repos.get(wt.repoKey);
  if (!repo) throw new Error(`Unknown repository for ${wt.path}`);
  return repo;
}
function parseWorktreeList(out) {
  const list = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (!line) {
      if (cur) list.push(cur);
      cur = null;
      continue;
    }
    const sp = line.indexOf(" ");
    const k = sp === -1 ? line : line.slice(0, sp);
    const v = sp === -1 ? "" : line.slice(sp + 1);
    if (k === "worktree") cur = { path: v };
    else if (!cur) continue;
    else if (k === "HEAD") cur.head = v;
    else if (k === "branch") cur.branch = v.replace(/^refs\/heads\//, "");
    else if (k === "detached") cur.detached = true;
    else if (k === "bare") cur.bare = true;
    else if (k === "locked") cur.locked = true;
    else if (k === "prunable") cur.prunable = true;
  }
  if (cur) list.push(cur);
  return list;
}
async function discoverWorktrees() {
  await discoverRepos();
  const seen = /* @__PURE__ */ new Set();
  for (const repo of repos.values()) {
    let list;
    try {
      list = parseWorktreeList(await git(repo.root, ["worktree", "list", "--porcelain"]));
    } catch {
      continue;
    }
    list.forEach((w, i) => {
      if (w.bare || w.prunable || !fs6.existsSync(w.path)) return;
      const id = sha1(w.path).slice(0, 12);
      seen.add(id);
      let wt = wts.get(id);
      if (!wt) {
        wt = {
          id,
          path: w.path,
          repoKey: repo.commonDir,
          repoName: repo.name,
          isMain: i === 0,
          branch: null,
          detached: false,
          locked: false,
          fingerprint: null,
          dirty: 0,
          dirtyFiles: [],
          lastActivity: 0,
          ahead: 0,
          stats: null,
          nextCheck: 0,
          sessions: [],
          agents: [],
          pr: void 0,
          headInMerged: null
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
async function detectStackBase(wt, repo) {
  if (!wt.branch) return null;
  let out;
  try {
    out = await git(wt.path, ["for-each-ref", "--format=%(refname:short)", "--merged", "HEAD", "--no-merged", repo.defaultBase, "refs/heads"]);
  } catch {
    return null;
  }
  let best = null, bestN = Infinity;
  for (const c of out.split("\n").filter((b) => b && b !== wt.branch).slice(0, 30)) {
    const n = Number((await git(wt.path, ["rev-list", "--count", `${c}..HEAD`])).trim());
    if (n > 0 && n < bestN) {
      best = c;
      bestN = n;
    }
  }
  return best;
}
function resolveBase(wt) {
  const s = state.worktrees[wt.id];
  if (s?.baseOverride) return { ref: s.baseOverride, source: "set by you" };
  return automaticBase(wt);
}
function automaticBase(wt) {
  const repo = repoOf(wt);
  if (wt.pr?.baseRefName) return { ref: `origin/${wt.pr.baseRefName}`, source: `PR #${wt.pr.number} base` };
  if (wt.stackBase) return { ref: wt.stackBase, source: "stacked on" };
  return { ref: repo.defaultBase, source: "default" };
}
var LOCKFILES = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|go\.sum|composer\.lock)$/;
function classifyDirty(entries) {
  if (!entries.length) return null;
  if (entries.every((e) => e.xy === " D" || e.xy === "D ")) return "deleted-only";
  if (entries.every((e) => LOCKFILES.test(e.file) && /M/.test(e.xy))) return "lockfile-only";
  return "work";
}
function parseStatus(out) {
  const parts = out.split("\0");
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    entries.push({ xy: p.slice(0, 2), file: p.slice(3) });
    if (p[0] === "R" || p[0] === "C") i++;
  }
  return entries;
}
function refreshWorktree(wt, { force = false } = {}) {
  if (wt.checking) return wt.checking;
  const checking = (async () => {
    const repo = repoOf(wt);
    const head = (await git(wt.path, ["rev-parse", "HEAD"])).trim();
    const status = await git(wt.path, ["status", "--porcelain=v1", "-z"]);
    const entries = parseStatus(status);
    let maxMtime = 0;
    const stamps = entries.slice(0, 500).map((e) => {
      try {
        const st = fs6.statSync(path3.join(wt.path, e.file));
        maxMtime = Math.max(maxMtime, st.mtimeMs);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return "x";
      }
    });
    const headChanged = head !== wt.head;
    if (headChanged) {
      wt.head = head;
      wt.commitTime = Number((await git(wt.path, ["log", "-1", "--format=%ct"])).trim()) * 1e3;
      wt.stackBase = await detectStackBase(wt, repo);
      wt.headInMerged = null;
      wt.unmatched = null;
      const count = async (args) => Number((await git(wt.path, ["rev-list", "--count", "HEAD", "--not", ...args]).catch(() => "-1")).trim());
      wt.unpushed = await count(["--remotes"]);
      wt.orphaned = wt.detached ? await count(["--branches", "--remotes", "--tags"]) : 0;
    }
    wt.dirty = entries.length;
    wt.dirtyFiles = entries.slice(0, 50).map((e) => ({ xy: e.xy, file: e.file }));
    wt.dirtyKind = classifyDirty(entries);
    const untracked = entries.filter((e) => e.xy === "??").length;
    wt.untracked = untracked;
    wt.lastActivity = Math.max(wt.commitTime || 0, maxMtime);
    const base = resolveBase(wt);
    const baseSha = (await git(wt.path, ["rev-parse", "--verify", "--quiet", `${base.ref}^{commit}`]).catch(() => "")).trim();
    const fp = sha1([head, base.ref, baseSha, status, ...stamps].join("|"));
    if (fp !== wt.fingerprint || force) {
      wt.fingerprint = fp;
      wt.baseRef = base.ref;
      wt.baseSource = base.source;
      try {
        const mergeBase = (await git(wt.path, ["merge-base", base.ref, "HEAD"])).trim();
        wt.mergeBase = mergeBase;
        wt.ahead = Number((await git(wt.path, ["rev-list", "--count", `${mergeBase}..HEAD`])).trim());
        const numstat = await git(wt.path, ["diff", "--numstat", mergeBase]);
        let files = 0, add = 0, del = 0;
        for (const line of numstat.split("\n")) {
          if (!line) continue;
          const [a, d] = line.split("	");
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
  })().finally(() => {
    wt.checking = null;
  });
  wt.checking = checking;
  return checking;
}
function isActive(wt) {
  return wt.sessions.length > 0 || wt.agents.length > 0 || Date.now() - wt.lastActivity < 2 * 36e5;
}
async function pollWorktrees() {
  const now = Date.now();
  const due = [...wts.values()].filter((w) => w.nextCheck <= now && !w.checking);
  await Promise.all(due.map(async (wt) => {
    wt.nextCheck = now + (isActive(wt) ? 3e3 : 6e4);
    try {
      await refreshWorktree(wt);
      if (wt.error) {
        wt.error = null;
        changed();
      }
    } catch (e) {
      const err = explainWorktreeError(gitError(e));
      if (wt.error?.detail !== err.detail) {
        wt.error = err;
        changed();
      }
    }
  }));
}
async function baseChoices(wt) {
  const refs = async (prefix, n) => (await git(wt.path, ["for-each-ref", "--sort=-committerdate", `--count=${n}`, "--format=%(refname:short)", prefix]).catch(() => "")).split("\n").filter((r) => r && r !== wt.branch && !r.endsWith("/HEAD"));
  const [branches, remotes] = await Promise.all([refs("refs/heads", 25), refs("refs/remotes", 25)]);
  return { automatic: automaticBase(wt), current: { ref: wt.baseRef ?? "", source: wt.baseSource ?? "" }, branches, remotes };
}

// src/server/cleanup-status.ts
function openReviewItems(wtId) {
  return state.comments.filter((c) => c.wtId === wtId && (c.status === "draft" || c.status === "pending")).length;
}
function cleanupStatus(wt, opts) {
  if (wt.isMain) return null;
  if (wt.pr?.state === "MERGED" && wt.branch) return mergedStatus(wt, wt.pr, opts);
  return idleStatus(wt, opts);
}
function commonBlockers(wt, { ignoreBusy = false } = {}) {
  const reasons = [], notes = [];
  let forceable = true;
  const hard = (r) => {
    reasons.push(r);
    forceable = false;
  };
  if (wt.error) hard(wt.error.kind === "broken-link" ? "git can't read it (broken link to its repository)" : `git can't read it: ${wt.error.message}`);
  if (wt.locked) hard("the worktree is locked");
  if (wt.dirty > 0) {
    const n = `${wt.dirty} file${wt.dirty === 1 ? "" : "s"}`;
    if (wt.dirtyKind === "deleted-only") notes.push(`${n} missing from disk, but they're still in the branch, so nothing is lost`);
    else if (wt.dirtyKind === "lockfile-only") reasons.push(`only a lockfile changed (${[...new Set(wt.dirtyFiles.map((f) => f.file.split("/").pop()))].join(", ")}), usually from installing dependencies`);
    else reasons.push(`${n} with uncommitted changes`);
  }
  if (wt.sessions.length) hard(`in use by ${wt.sessions.map((s) => s.name).join(", ")}`);
  if (wt.agents.length) hard(`in use by ${wt.agents.map((a) => `a subagent of ${a.parent.name}`).join(", ")}`);
  if (openReviewItems(wt.id)) reasons.push("has unsent review comments");
  if (wt.busy && !ignoreBusy) hard("being removed right now");
  return { reasons, notes, hard, forceable: () => forceable };
}
var dirtySummary = (wt) => wt.dirty ? { kind: wt.dirtyKind ?? null, count: wt.dirty, files: wt.dirtyFiles.slice(0, 20) } : null;
function idleStatus(wt, opts) {
  const { reasons, notes, hard, forceable } = commonBlockers(wt, opts);
  const orphaned = wt.orphaned ?? NaN;
  if (Date.now() - wt.lastActivity < 10 * 6e4) hard("changed in the last 10 minutes, so something may still be working in it");
  if (wt.detached && !(orphaned >= 0)) hard("couldn't check whether the commits on its detached HEAD are on a branch");
  else if (orphaned > 0) hard(`${orphaned} commit${orphaned === 1 ? "" : "s"} on its detached HEAD ${orphaned === 1 ? "isn't" : "aren't"} on any branch; create a branch first (git switch -c <name>)`);
  if (wt.branch) {
    const unpushed = Math.min(wt.unpushed ?? NaN, wt.ahead);
    const pushed = unpushed > 0 ? `, ${unpushed === wt.ahead ? wt.ahead === 1 ? "not pushed" : "none of them pushed" : `${unpushed} not pushed`}` : wt.unpushed === 0 ? ", all pushed" : "";
    notes.push(`the branch ${wt.branch} is kept${wt.ahead ? ` with its ${wt.ahead} commit${wt.ahead === 1 ? "" : "s"}${pushed}` : ""}`);
  } else if (orphaned === 0) notes.push("detached HEAD; its commit is on a branch, so nothing is lost");
  if (wt.pr?.state === "OPEN") notes.push(`PR #${wt.pr.number} is still open; removing the worktree doesn't affect it`);
  return {
    kind: "idle",
    eligible: reasons.length === 0,
    reasons,
    notes,
    branchSafe: false,
    forceable: reasons.length > 0 && forceable(),
    dirty: dirtySummary(wt),
    unmatched: [],
    auto: false
  };
}
function mergedStatus(wt, pr, opts) {
  const { reasons, notes, forceable } = commonBlockers(wt, opts);
  const branchSafe = !!wt.head && (wt.head === pr.headRefOid || wt.headInMerged === true);
  if (!branchSafe) {
    notes.push(wt.headInMerged === null ? "still checking whether its commits are in the PR; the branch is kept until that is known" : wt.unmatched?.length ? `the branch is kept: ${wt.unmatched.length} commit${wt.unmatched.length === 1 ? " has" : "s have"} no matching change in the merged PR (often commits from a stacked parent PR that merged separately)` : "the branch is kept: its commits couldn't be matched to the merged PR");
  }
  return {
    kind: "merged",
    eligible: reasons.length === 0,
    reasons,
    notes,
    branchSafe,
    forceable: reasons.length > 0 && forceable(),
    dirty: dirtySummary(wt),
    unmatched: branchSafe ? [] : (wt.unmatched || []).slice(0, 12),
    auto: config.autoCleanup && Date.parse(pr.mergedAt ?? "") >= state.installedAt
  };
}
async function checkBranchInPR(wt, pr) {
  const repo = repoOf(wt);
  const head = () => wt.head ?? "";
  if (head() === pr.headRefOid) {
    wt.headInMerged = true;
    wt.unmatched = [];
    return;
  }
  if (!await gitOk(repo.root, ["cat-file", "-e", `${pr.headRefOid}^{commit}`])) {
    await run("git", ["fetch", "-q", "origin", pr.headRefOid], { cwd: repo.root, timeout: 6e4 }).catch(() => {
    });
    if (!await gitOk(repo.root, ["cat-file", "-e", `${pr.headRefOid}^{commit}`])) {
      wt.headInMerged = false;
      wt.unmatched = [];
      return;
    }
  }
  if (await gitOk(wt.path, ["merge-base", "--is-ancestor", head(), pr.headRefOid])) {
    wt.headInMerged = true;
    wt.unmatched = [];
    return;
  }
  const cherry = await git(wt.path, ["cherry", pr.headRefOid, head()]).catch(() => "");
  const shas = cherry.split("\n").filter((l) => l.startsWith("+ ")).map((l) => l.slice(2).trim());
  const unmatched = [];
  wt.unmatched = unmatched;
  for (const sha of shas.slice(0, 50)) {
    const subject = (await git(wt.path, ["log", "-1", "--format=%s", sha]).catch(() => "")).trim();
    unmatched.push({ sha, subject });
  }
  wt.headInMerged = shas.length === 0;
}

// src/server/integrations.ts
import { spawn } from "node:child_process";
var lastHookAt = null;
function markHook() {
  lastHookAt = Date.now();
}
var integrations = { at: 0, data: null, pending: null };
var crLogin = null;
var coderabbitReady = () => !!(integrations.data?.coderabbit.installed && integrations.data?.coderabbit.authed);
var claudeReady = () => !!integrations.data?.claude.cliVersion;
var claudePath = "claude";
var claudeBin = () => claudePath;
async function probeClaude() {
  const onPath = await probe("claude", ["--version"]);
  const exec = process.env.CLAUDE_CODE_EXECPATH;
  if (!onPath.missing || !exec) {
    claudePath = "claude";
    return onPath;
  }
  claudePath = exec;
  return probe(exec, ["--version"]);
}
async function probe(cmd, args, opts = {}) {
  try {
    return { ok: true, out: await run(cmd, args, { timeout: 15e3, ...opts }) };
  } catch (e) {
    const { code, stdout, stderr } = errInfo(e);
    return { ok: false, missing: code === "ENOENT", out: `${stdout}${stderr}` };
  }
}
function lastJson(text) {
  const lines = text.trim().split("\n").reverse();
  for (const l of lines) {
    try {
      return JSON.parse(l);
    } catch {
    }
  }
  return null;
}
async function checkIntegrations() {
  const [ghV, ghAuth, crV, crStatus, crPlain, claudeV] = await Promise.all([
    probe("gh", ["--version"]),
    probe("gh", ["auth", "status", "--hostname", "github.com"]),
    probe("coderabbit", ["--version"]),
    probe("coderabbit", ["auth", "status", "--agent"]),
    probe("coderabbit", ["auth", "status"]),
    probeClaude()
  ]);
  const gh = { installed: !ghV.missing, version: ghV.out.match(/gh version (\S+)/)?.[1] || null, authed: ghAuth.ok, account: null };
  gh.account = ghAuth.out.match(/account (\S+)/)?.[1] || null;
  const st = rec(lastJson(crStatus.out));
  const cr = { installed: !crV.missing, version: crV.ok ? crV.out.trim().split("\n")[0] ?? null : null, authed: !!st.authenticated };
  if (st.authenticated) {
    const user = rec(st.user);
    cr.user = asStr(user.username) || asStr(user.name);
    cr.email = asStr(user.email);
    cr.org = asStr(rec(st.currentOrg).name) || null;
    cr.orgs = (Array.isArray(st.organizations) ? st.organizations : []).map((o) => asStr(rec(o).name)).filter((n) => n !== void 0);
    cr.plan = crPlain.out.match(/Plan\s*:\s*(.+)/)?.[1]?.trim() || null;
    cr.seat = crPlain.out.match(/Seat\s*:\s*(.+)/)?.[1]?.trim() || null;
  }
  return {
    gh,
    coderabbit: cr,
    coderabbitLogin: crLogin,
    claude: { lastHookAt, sessions: sessions.size, version: VERSION, cliVersion: claudeV.ok ? claudeV.out.trim().split(/\s/)[0] || null : null },
    node: process.version,
    dataDir: DATA_DIR,
    configPath: CONFIG_PATH
  };
}
async function getIntegrations(force = false) {
  if (!force && integrations.data && Date.now() - integrations.at < 6e4) {
    return { ...integrations.data, coderabbitLogin: crLogin, claude: { ...integrations.data.claude, lastHookAt, sessions: sessions.size } };
  }
  const pending = integrations.pending ?? checkIntegrations().then((data) => {
    integrations = { at: Date.now(), data, pending: null };
    return data;
  }, (e) => {
    integrations.pending = null;
    throw e;
  });
  integrations.pending = pending;
  return pending;
}
function startCodeRabbitLogin() {
  if (crLogin?.running) return crLogin;
  const init = { running: true, url: null, error: null, startedAt: Date.now() };
  crLogin = init;
  const child = spawn("coderabbit", ["auth", "login", "--agent"], { env: process.env });
  let out = "";
  const onData = (d) => {
    out += d;
    const url = out.match(/https:\/\/app\.coderabbit\.ai\/login[^\s"'\]]*/)?.[0];
    if (url && crLogin && !crLogin.url) {
      crLogin.url = url.replace(/&amp;/g, "&");
      changed();
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const timer = setTimeout(() => child.kill(), 5 * 6e4);
  child.on("error", (e) => {
    crLogin = { ...crLogin ?? init, running: false, error: errInfo(e).code === "ENOENT" ? "CodeRabbit CLI is not installed." : e.message };
    changed();
  });
  child.on("close", async (code) => {
    clearTimeout(timer);
    const result = rec(lastJson(out));
    crLogin = { ...crLogin ?? init, running: false, error: code === 0 ? null : asStr(result.message) || asStr(result.error) || "Login did not finish." };
    await getIntegrations(true).catch(() => {
    });
    changed();
  });
  changed();
  return init;
}

// src/server/jobs.ts
import { spawn as spawn2 } from "node:child_process";
import fs7 from "node:fs";
import path4 from "node:path";
var jobs = [];
var pendingShutdown = null;
var httpServer = null;
function registerServer(s) {
  httpServer = s;
}
function deferShutdown(replacement) {
  pendingShutdown = { replacement };
}
var jobsRunning = () => jobs.some((j) => j.status === "running");
function shutdownNow(replacement) {
  if (replacement) {
    const out = fs7.openSync(path4.join(DATA_DIR, "server.log"), "a");
    httpServer?.close();
    setTimeout(() => {
      spawn2(process.execPath, [replacement], { cwd: path4.resolve(path4.dirname(replacement), ".."), detached: true, stdio: ["ignore", out, out], env: process.env }).unref();
      process.exit(0);
    }, 300);
  } else process.exit(0);
}
function startJob(kind, title, items, worker) {
  if (kind === "cleanup" && jobs.some((j) => j.kind === "cleanup" && j.status === "running")) {
    throw httpError(409, "A cleanup is already running.");
  }
  const job = {
    id: newId("j"),
    kind,
    title,
    total: items.length,
    done: 0,
    current: null,
    ok: [],
    failed: [],
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    dismissed: false
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
        job.failed.push({ id: wt.id, branch: wt.branch, path: wt.path, error: errInfo(e).message, kind: wt.error?.kind || null });
      } finally {
        wt.busy = null;
      }
      job.done++;
      changed();
    }
    job.current = null;
    job.status = "done";
    job.finishedAt = Date.now();
    log(`${job.title}: ${job.ok.length} ok, ${job.failed.length} failed`, job.failed.map((f) => `${f.path}: ${f.error}`).join(" | "));
    changed();
    if (pendingShutdown && !jobsRunning()) setTimeout(() => shutdownNow(pendingShutdown?.replacement ?? null), 1e3);
  })();
  return job;
}

// src/server/removal.ts
import { spawn as spawn3 } from "node:child_process";
import fs9 from "node:fs";
import path6 from "node:path";

// src/server/sessions.ts
import fs8 from "node:fs";
import path5 from "node:path";
var transcriptCache = /* @__PURE__ */ new Map();
function findTranscript(sessionId) {
  const cached = transcriptCache.get(sessionId);
  if (cached) return cached;
  const projects = path5.join(CLAUDE_DIR, "projects");
  try {
    for (const d of fs8.readdirSync(projects)) {
      const p = path5.join(projects, d, `${sessionId}.jsonl`);
      if (fs8.existsSync(p)) {
        transcriptCache.set(sessionId, p);
        return p;
      }
    }
  } catch {
  }
  return null;
}
function readTail(p, bytes) {
  const fd = fs8.openSync(p, "r");
  try {
    const size = fs8.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs8.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    fs8.closeSync(fd);
  }
}
function linkSession(text, paths) {
  const result = [];
  for (const p of paths) {
    const nested = paths.filter((q) => q.length > p.length && q.startsWith(p + "/"));
    let count = 0, last = -1, cwdHit = false;
    let i = text.indexOf(p);
    while (i !== -1) {
      const ch = text[i + p.length];
      const boundary = ch === void 0 || /[/"'\s\\`:),]/.test(ch);
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
function parseSessionInfo(v) {
  if (!isRecord(v) || typeof v.sessionId !== "string" || !v.sessionId || typeof v.pid !== "number" || !v.pid) return null;
  return {
    sessionId: v.sessionId,
    pid: v.pid,
    name: typeof v.name === "string" ? v.name : void 0,
    status: typeof v.status === "string" ? v.status : void 0,
    cwd: typeof v.cwd === "string" ? v.cwd : void 0
  };
}
function parseAgentMeta(v) {
  if (!isRecord(v)) return null;
  return {
    agentType: typeof v.agentType === "string" ? v.agentType : "agent",
    description: typeof v.description === "string" ? v.description : "",
    worktreePath: typeof v.worktreePath === "string" ? v.worktreePath : void 0,
    finished: v.finished === true
  };
}
var AGENT_STALE_MS = 30 * 6e4;
var discovering = null;
var discoverSoon = () => {
  discovering ??= discoverWorktrees().catch(() => {
  }).finally(() => {
    discovering = null;
  });
};
function refreshAgents(s, transcript, paths, ownPath) {
  const dir = path5.join(path5.dirname(transcript), s.sessionId, "subagents");
  let files = [];
  try {
    files = fs8.readdirSync(dir).filter((f) => f.endsWith(".meta.json"));
  } catch {
    return [];
  }
  const result = [];
  for (const f of files) {
    const meta = parseAgentMeta(loadJson(path5.join(dir, f), null));
    if (!meta || meta.finished) continue;
    const agentId = f.slice(0, -".meta.json".length).replace(/^agent-/, "");
    const tp = path5.join(dir, f.slice(0, -".meta.json".length) + ".jsonl");
    let size, mtime;
    try {
      ({ size, mtimeMs: mtime } = fs8.statSync(tp));
    } catch {
      continue;
    }
    if (Date.now() - mtime > AGENT_STALE_MS) continue;
    const a = s.agents.find((x) => x.agentId === agentId) ?? { agentId, description: meta.description, agentType: meta.agentType, worktreePaths: [], scannedSize: -1, scannedAt: 0 };
    if (meta.worktreePath) {
      a.worktreePaths = paths.filter((p) => p === meta.worktreePath);
      if (!a.worktreePaths.length) discoverSoon();
    } else if (size !== a.scannedSize && Date.now() - a.scannedAt > 8e3) {
      a.scannedSize = size;
      a.scannedAt = Date.now();
      a.worktreePaths = linkSession(readTail(tp, 3 * 1024 * 1024), paths).filter((p) => p !== ownPath);
    }
    result.push(a);
  }
  return result;
}
var ownWorktree = (cwd, paths) => cwd ? paths.filter((p) => cwd === p || cwd.startsWith(p + "/")).sort((a, b) => b.length - a.length)[0] : void 0;
function refreshSessions() {
  const dir = path5.join(CLAUDE_DIR, "sessions");
  const live = /* @__PURE__ */ new Set();
  let files = [];
  try {
    files = fs8.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
  }
  const paths = [...wts.values()].map((w) => w.path);
  for (const f of files) {
    const info = parseSessionInfo(loadJson(path5.join(dir, f), null));
    if (!info || !pidAlive(info.pid) || reviewerPids.has(info.pid)) continue;
    live.add(info.sessionId);
    let s = sessions.get(info.sessionId);
    if (!s) {
      s = { sessionId: info.sessionId, worktreePaths: [], scannedSize: -1, scannedAt: 0, pid: info.pid, name: "", status: "unknown", agents: [] };
      sessions.set(info.sessionId, s);
    }
    Object.assign(s, { pid: info.pid, name: info.name || info.sessionId.slice(0, 8), status: info.status || "unknown", cwd: info.cwd });
    const own = ownWorktree(s.cwd, paths);
    const tp = findTranscript(s.sessionId);
    if (tp) {
      try {
        const size = fs8.statSync(tp).size;
        if (size !== s.scannedSize && Date.now() - s.scannedAt > 8e3) {
          s.scannedSize = size;
          s.scannedAt = Date.now();
          s.worktreePaths = linkSession(readTail(tp, 3 * 1024 * 1024), paths);
        }
      } catch {
      }
      s.agents = refreshAgents(s, tp, paths, own);
    }
    if (own && !s.worktreePaths.includes(own)) s.worktreePaths.unshift(own);
  }
  for (const id of sessions.keys()) if (!live.has(id)) sessions.delete(id);
  for (const wt of wts.values()) {
    const linked = [...sessions.values()].filter((s) => s.worktreePaths.includes(wt.path));
    const agents = [...sessions.values()].flatMap((s) => s.agents.filter((a) => a.worktreePaths.includes(wt.path)).map((a) => ({ agentId: a.agentId, description: a.description, agentType: a.agentType, parent: { sessionId: s.sessionId, name: s.name, status: s.status } })));
    const sig = linked.map((s) => s.sessionId + s.status).concat(agents.map((a) => a.agentId + a.parent.status)).join(",");
    if (sig !== wt.sessionSig) {
      wt.sessionSig = sig;
      changed();
    }
    wt.sessions = linked;
    wt.agents = agents;
  }
}

// src/server/removal.ts
async function removeWorktree(wt, how, { force = false } = {}) {
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
  if (!cs.eligible && !(force && cs.forceable)) throw new Error(`Not safe to remove: ${cs.reasons.join("; ")}.`);
  await detachWorktree(wt, repo, { force: force || wt.dirtyKind === "deleted-only" });
  let branchDeleted = false;
  let branchKept = null;
  if (cs.kind === "idle") branchKept = wt.branch ? "kept: it isn't merged" : null;
  else if (force) branchKept = "kept because the worktree was removed with uncommitted changes";
  else if (!cs.branchSafe) branchKept = cs.notes.find((n) => n.startsWith("the branch is kept")) || "kept: not all of its commits are in the merged PR";
  else {
    try {
      if (!wt.branch) throw new Error("no branch");
      const tip = (await git(repo.root, ["rev-parse", `refs/heads/${wt.branch}`])).trim();
      if (tip === wt.head) {
        await git(repo.root, ["branch", "-D", wt.branch]);
        branchDeleted = true;
      } else branchKept = "kept: the branch has moved since it was checked";
    } catch {
    }
  }
  await git(repo.root, ["worktree", "prune"]).catch(() => {
  });
  state.cleaned.unshift({
    path: wt.path,
    branch: wt.branch,
    sha: wt.head ?? "",
    repoRoot: repo.root,
    how: force ? "forced" : how,
    branchDeleted,
    branchKept,
    at: Date.now(),
    lostFiles: force ? wt.dirtyFiles.map((f) => f.file) : void 0,
    reason: cs.kind,
    pr: wt.pr ? { number: wt.pr.number, url: wt.pr.url, title: wt.pr.title, state: wt.pr.state } : null
  });
  state.cleaned = state.cleaned.slice(0, 100);
  delete state.worktrees[wt.id];
  wts.delete(wt.id);
  log(`removed worktree ${wt.path} (${how}, ${cs.kind === "merged" ? `PR #${wt.pr?.number} merged` : "no session using it"})`);
  save();
  changed();
}
async function detachWorktree(wt, repo, { force }) {
  if (fs9.existsSync(path6.join(wt.path, ".gitmodules"))) {
    try {
      await run("git", ["worktree", "remove", ...force ? ["--force"] : [], wt.path], { cwd: repo.root });
    } catch (e) {
      throw httpError(409, `Git refused to remove it: ${explainWorktreeError(gitError(e)).message}`);
    }
    return;
  }
  if (!force) {
    const entries = parseStatus(await git(wt.path, ["status", "--porcelain=v1", "-z"]));
    if (entries.length) throw httpError(409, `Git found ${entries.length} modified or untracked file${entries.length === 1 ? "" : "s"} in it just now, so it wasn't removed.`);
  }
  const aside = path6.join(path6.dirname(wt.path), `.${path6.basename(wt.path)}.removing-${Date.now()}`);
  try {
    fs9.renameSync(wt.path, aside);
  } catch (e) {
    const { code, message } = errInfo(e);
    if (code !== "EXDEV") throw httpError(409, `Couldn't move it aside to delete it: ${message}`);
    await run("git", ["worktree", "remove", "--force", wt.path], { cwd: repo.root, timeout: 6e5 });
    return;
  }
  await git(repo.root, ["worktree", "prune"]);
  state.trash.push(aside);
  save();
  deleteInBackground(aside);
}
function deleteInBackground(p) {
  const done = () => {
    state.trash = state.trash.filter((t) => t !== p);
    save();
  };
  if (process.platform === "win32") {
    fs9.promises.rm(p, { recursive: true, force: true, maxRetries: 3 }).then(done, (e) => log("background delete failed", p, errInfo(e).message));
    return;
  }
  const child = spawn3("rm", ["-rf", p], { detached: true, stdio: "ignore" });
  child.on("exit", (code) => code === 0 ? done() : log("background delete failed", p, `rm exited ${code}`));
  child.unref();
}
async function repairWorktrees(list) {
  const fixed = [], failed = [];
  for (const wt of list) {
    const repo = repoOf(wt);
    try {
      await run("git", ["worktree", "repair", wt.path], { cwd: repo.root });
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

// src/server/prs.ts
var prError = null;
var isPRState = (v) => v === "OPEN" || v === "CLOSED" || v === "MERGED";
function prNode(v) {
  const nodes = rec(v).nodes;
  const n = rec(Array.isArray(nodes) ? nodes[0] : void 0);
  const { number, state: state2, isDraft, url, title, headRefOid, mergedAt, baseRefName } = n;
  if (typeof number !== "number" || !isPRState(state2) || typeof isDraft !== "boolean" || typeof url !== "string" || typeof title !== "string" || typeof headRefOid !== "string" || mergedAt !== null && typeof mergedAt !== "string" || typeof baseRefName !== "string") return null;
  return { number, state: state2, isDraft, url, title, headRefOid, mergedAt, baseRefName };
}
async function refreshPRs() {
  for (const repo of repos.values()) {
    if (!repo.gh) continue;
    const repoWts = [...wts.values()].filter((w) => w.repoKey === repo.commonDir && w.branch && !w.isMain);
    const branches = [...new Set(repoWts.flatMap((w) => w.branch ? [w.branch] : []))];
    if (!branches.length) continue;
    const fields = "nodes { number state isDraft url title headRefOid mergedAt baseRefName }";
    const aliases = branches.map((b, i) => `b${i}: pullRequests(headRefName: ${JSON.stringify(b)}, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { ${fields} }`).join("\n");
    const query = `query { repository(owner: ${JSON.stringify(repo.gh.owner)}, name: ${JSON.stringify(repo.gh.name)}) { ${aliases} } }`;
    try {
      const reply = JSON.parse(await run("gh", ["api", "graphql", "-f", `query=${query}`]));
      const data = rec(rec(reply).data).repository;
      if (!isRecord(data)) throw new Error("Unexpected reply from gh");
      const byBranch = new Map(branches.map((b, i) => [b, prNode(data[`b${i}`])]));
      for (const wt of repoWts) {
        const pr = wt.branch === null ? null : byBranch.get(wt.branch) ?? null;
        if (JSON.stringify(pr) !== JSON.stringify(wt.pr)) {
          wt.pr = pr;
          wt.headInMerged = null;
          wt.nextCheck = 0;
          changed();
        }
      }
      prError = null;
    } catch (e) {
      const { message: msg, code } = errInfo(e);
      prError = code === "ENOENT" ? "Install the GitHub CLI (gh) to see PR status and clean up merged worktrees." : /auth|login|401/i.test(msg) ? "Run `gh auth login` to see PR status and clean up merged worktrees." : `Couldn't fetch PR status for ${repo.name}.`;
      log(`PR refresh failed for ${repo.name}:`, firstLine(msg));
      changed();
    }
  }
  await runCleanup();
}
async function runCleanup() {
  for (const wt of [...wts.values()]) {
    const pr = wt.pr;
    if (!pr || pr.state !== "MERGED" || wt.isMain || !wt.head) continue;
    if (wt.headInMerged === null && !wt.error) {
      await checkBranchInPR(wt, pr).catch((e) => log("branch check failed", wt.path, errInfo(e).message));
      changed();
    }
    const cs = cleanupStatus(wt);
    if (cs?.kind === "merged" && cs.eligible && cs.auto && !wt.busy) {
      try {
        await removeWorktree(wt, "auto");
      } catch (e) {
        log("auto-cleanup skipped", wt.path, errInfo(e).message);
      }
    }
  }
}

// src/server/public-state.ts
function publicWorktree(wt) {
  const s = state.worktrees[wt.id] ?? {};
  const mine = state.comments.filter((c) => c.wtId === wt.id);
  const codeReviews = {};
  for (const [k, r] of Object.entries(state.codeReviews[wt.id] ?? {})) {
    codeReviews[k] = {
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      heartbeatAt: r.heartbeatAt,
      open: r.findings.filter((f) => f.status === "open").length,
      total: r.findings.length,
      sig: sha1(r.status + (r.message || "") + r.findings.map((f) => f.id + f.status).join()).slice(0, 10)
    };
  }
  return {
    id: wt.id,
    path: wt.path,
    repoName: wt.repoName,
    branch: wt.branch,
    head: wt.head,
    isMain: wt.isMain,
    locked: wt.locked,
    detached: wt.detached,
    fingerprint: wt.fingerprint,
    dirty: wt.dirty,
    lastActivity: wt.lastActivity,
    ahead: wt.ahead,
    stats: wt.stats,
    baseRef: wt.baseRef,
    baseSource: wt.baseSource,
    baseError: wt.baseError,
    pr: wt.pr ? { number: wt.pr.number, state: wt.pr.state, isDraft: wt.pr.isDraft, url: wt.pr.url, title: wt.pr.title, mergedAt: wt.pr.mergedAt } : null,
    sessions: wt.sessions.map((x) => ({ sessionId: x.sessionId, name: x.name, status: x.status })),
    agents: wt.agents,
    cleanup: cleanupStatus(wt),
    error: wt.error || null,
    busy: wt.busy || null,
    dirtyKind: wt.dirtyKind || null,
    codeReviews,
    review: {
      reviewedAt: s.reviewedAt || null,
      needsReview: !!wt.fingerprint && (wt.stats?.files || 0) > 0 && s.reviewedFp !== wt.fingerprint
    },
    comments: {
      draft: mine.filter((c) => c.status === "draft").length,
      waiting: mine.filter((c) => c.status === "pending").length,
      open: mine.filter((c) => c.status === "delivered").length,
      sig: sha1(mine.map((c) => `${c.id}${c.status}${c.replies.length}${c.body.length}`).join() + state.reviews.filter((r) => r.wtId === wt.id).map((r) => r.status).join()).slice(0, 10)
    }
  };
}
function publicState() {
  return {
    port: PORT,
    version: VERSION,
    home: HOME,
    prError,
    config: {
      autoCleanup: config.autoCleanup,
      recentDays: config.recentDays,
      editor: config.editor,
      prPollMinutes: config.prPollMinutes,
      roots: config.roots,
      extraRepos: config.extraRepos,
      reviewEffort: config.reviewEffort
    },
    onboardedAt: state.onboardedAt || null,
    repos: [...repos.values()].map((r) => ({ name: r.name, root: r.root, github: r.gh ? `${r.gh.owner}/${r.gh.name}` : null })),
    coderabbitLogin: crLogin,
    jobs: jobs.filter((j) => !j.dismissed).slice(0, 5),
    coderabbitReady: coderabbitReady(),
    claudeReady: claudeReady(),
    installedAt: state.installedAt,
    sessions: [...sessions.values()].map((s) => ({ sessionId: s.sessionId, name: s.name, status: s.status, cwd: s.cwd })),
    cleaned: state.cleaned.slice(0, 30),
    worktrees: [...wts.values()].map(publicWorktree)
  };
}
var clients = /* @__PURE__ */ new Set();
var lastSent = "";
function startBroadcast() {
  setInterval(() => {
    if (!takeChanged()) return;
    const json = JSON.stringify(publicState());
    if (json === lastSent) return;
    lastSent = json;
    for (const res of clients) res.write(`event: state
data: ${json}

`);
  }, 500);
  setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 25e3);
}

// src/server/routes.ts
import fs13 from "node:fs";

// src/server/claude-review.ts
import path8 from "node:path";

// src/server/code-review.ts
import { spawn as spawn4 } from "node:child_process";
import fs10 from "node:fs";
import path7 from "node:path";
var REVIEWER_NAMES = { coderabbit: "CodeRabbit", claude: "Claude" };
var isReviewer = (v) => v === "coderabbit" || v === "claude";
var children = /* @__PURE__ */ new Map();
var reviewOf = (wtId, reviewer) => state.codeReviews[wtId]?.[reviewer];
function beginReview(wt, reviewer, extra = {}) {
  const review = {
    reviewer,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    baseRef: wt.baseRef,
    fingerprint: wt.fingerprint,
    findings: [],
    reviewedFiles: [],
    error: null,
    heartbeatAt: Date.now(),
    usage: null,
    ...extra
  };
  (state.codeReviews[wt.id] ??= {})[reviewer] = review;
  return review;
}
function assertIdle(wt, reviewer) {
  if (reviewOf(wt.id, reviewer)?.status === "running") throw httpError(409, `A ${REVIEWER_NAMES[reviewer]} review is already running for this worktree.`);
}
function addSnippet(wt, f) {
  try {
    const lines = fs10.readFileSync(path7.join(wt.path, f.file), "utf8").split("\n");
    if (f.startLine) f.snippet = lines.slice(f.startLine - 1, Math.min(f.endLine || f.startLine, f.startLine + 4)).join("\n");
  } catch {
  }
  return f;
}
function runReview(wt, review, cmd, args, { env = process.env, onEvent, finish }) {
  const name = REVIEWER_NAMES[review.reviewer];
  const key = `${wt.id} ${review.reviewer}`;
  const child = spawn4(cmd, args, { cwd: wt.path, env, stdio: ["ignore", "pipe", "pipe"] });
  children.set(key, child);
  if (child.pid) reviewerPids.add(child.pid);
  let buf = "", errText = "";
  const handle = (line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    review.heartbeatAt = Date.now();
    onEvent(rec(parsed));
    save();
    changed();
  };
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      handle(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.on("data", (d) => {
    errText = (errText + d).slice(-4e3);
  });
  child.on("error", (e) => {
    review.status = "failed";
    review.error = e.message;
    save();
    changed();
  });
  child.on("close", (code, signal) => {
    if (buf.trim()) handle(buf);
    children.delete(key);
    if (child.pid) reviewerPids.delete(child.pid);
    review.finishedAt = Date.now();
    if (review.status === "cancelled") {
    } else {
      if (code === 0) finish?.();
      if (code === 0 && !review.error) review.status = "done";
      else {
        review.status = "failed";
        review.error ||= signal ? `Stopped (${signal}).` : errText.trim().split("\n").pop() || `${name} exited with code ${code}.`;
      }
    }
    log(`${name} review ${review.status} for ${wt.path}: ${review.findings.length} findings`);
    save();
    changed();
  });
  save();
  changed();
}
function cancelReview(wtId, reviewer) {
  const r = wtId === void 0 ? void 0 : reviewOf(wtId, reviewer);
  if (!r || r.status !== "running") throw httpError(409, "No review is running.");
  r.status = "cancelled";
  r.error = reviewer === "coderabbit" ? "Cancelled. CodeRabbit discards a review that is stopped early." : "Cancelled.";
  children.get(`${wtId} ${reviewer}`)?.kill();
  save();
  changed();
}
function getFinding(fid) {
  for (const [wtId, byReviewer] of Object.entries(state.codeReviews)) {
    for (const r of Object.values(byReviewer)) {
      const f = r.findings.find((x) => x.id === fid);
      if (f) return { wtId, review: r, finding: f };
    }
  }
  throw httpError(404, "Unknown finding");
}
function findingToComment(wtId, f) {
  const wt = getWt(wtId);
  const parts = [`**${REVIEWER_NAMES[f.source]} (${f.severity})${f.title ? `: ${f.title}` : ""}**`];
  if (f.comment && f.comment !== f.title) parts.push(f.comment);
  if (f.suggestions) parts.push(`Suggested change:
\`\`\`
${f.suggestions}
\`\`\``);
  if (f.codegen && f.codegen !== f.comment) parts.push(`Fix guidance from ${REVIEWER_NAMES[f.source]}:
${f.codegen}`);
  const c = {
    id: newId("c"),
    wtId: wt.id,
    wtPath: wt.path,
    file: f.file,
    line: f.endLine || f.startLine || 1,
    side: "new",
    lineText: "",
    body: parts.join("\n\n"),
    status: "draft",
    createdAt: Date.now(),
    replies: [],
    fromFinding: f.id
  };
  try {
    const text = fs10.readFileSync(path7.join(wt.path, f.file), "utf8").split("\n");
    c.lineText = text[(c.line || 1) - 1] ?? "";
  } catch {
  }
  state.comments.push(c);
  f.status = "sent";
  f.commentId = c.id;
  return c;
}

// src/server/claude-review.ts
var SEVERITIES = ["critical", "major", "minor", "info"];
var SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          startLine: { type: "integer" },
          endLine: { type: "integer" },
          severity: { type: "string", enum: SEVERITIES },
          title: { type: "string" },
          comment: { type: "string" },
          suggestion: { type: "string", description: "Replacement code, when there is an obvious fix" }
        },
        required: ["file", "startLine", "severity", "title", "comment"]
      }
    }
  },
  required: ["findings"]
};
var prompt = (base) => `Run the code-review skill (Skill tool, args: "${base}") on this worktree: its changes against ${base}, including uncommitted and untracked files. Don't change any files. Then return every finding it reports as structured output, with file paths relative to the repository root and line numbers in the current version of each file.`;
var SESSION_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|SESSION_ATTENDED|CHILD_SESSION|MESSAGING_\w+))$/;
var reviewerEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !SESSION_VARS.test(k)));
function activity(wt, name, input) {
  const file = asStr(input.file_path);
  if (name === "Skill") return "Starting the review";
  if (name === "Read" && file) return `Reading ${path8.relative(wt.path, path8.resolve(wt.path, file))}`;
  if (name === "Bash") return `Running ${(asStr(input.command) || "").split("\n")[0]?.slice(0, 80)}`;
  if (name === "Grep" || name === "Glob") return "Searching the code";
  if (name === "Task" || name === "Agent") return asStr(input.description) || "Starting a sub-agent";
  if (name === "StructuredOutput") return "Writing up findings";
  return name;
}
function toFinding(wt, v) {
  const o = rec(v);
  const raw = asStr(o.file) || "";
  const start = Number(o.startLine) || null;
  const severity = String(o.severity || "info").toLowerCase();
  return {
    id: newId("f"),
    source: "claude",
    severity: SEVERITIES.includes(severity) ? severity : "info",
    file: path8.isAbsolute(raw) ? path8.relative(wt.path, raw) : raw,
    startLine: start,
    endLine: Number(o.endLine) || start,
    title: asStr(o.title) || "",
    comment: asStr(o.comment) || "",
    codegen: "",
    suggestions: asStr(o.suggestion) || "",
    status: "open"
  };
}
async function startClaudeReview(wt, effort = config.reviewEffort) {
  assertIdle(wt, "claude");
  if (!isEffort(effort)) throw httpError(400, `Unknown effort: ${String(effort)}`);
  const integ = await getIntegrations();
  if (!integ.claude.cliVersion) throw httpError(409, "The claude CLI was not found. See Settings.");
  await refreshWorktree(wt);
  const base = wt.baseRef;
  if (!base) throw httpError(409, "This worktree has nothing to compare with yet.");
  const review = beginReview(wt, "claude", { effort, costUsd: null });
  let reported = false;
  runReview(wt, review, claudeBin(), [
    "-p",
    prompt(base),
    // Leaves out the user's own skills (a personal "code-review" would shadow the built-in one), plugins and hooks, this plugin's too.
    "--safe-mode",
    "--no-session-persistence",
    "--effort",
    effort,
    "--disallowed-tools",
    "Edit Write NotebookEdit",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    JSON.stringify(SCHEMA)
  ], {
    env: reviewerEnv(),
    onEvent: (ev) => {
      if (ev.type === "assistant") {
        const content = rec(ev.message).content;
        for (const c of Array.isArray(content) ? content : []) {
          const block = rec(c);
          if (block.type === "tool_use") review.message = activity(wt, asStr(block.name) || "", rec(block.input));
        }
      } else if (ev.type === "result") {
        reported = true;
        if (typeof ev.total_cost_usd === "number") review.costUsd = ev.total_cost_usd;
        const findings = rec(ev.structured_output).findings;
        if (ev.is_error || ev.subtype !== "success") review.error = asStr(ev.result) || `Claude stopped early (${asStr(ev.subtype) || "error"}).`;
        else if (!Array.isArray(findings)) review.error = "Claude finished without reporting its findings in a form this page can show.";
        else review.findings = findings.map((f) => addSnippet(wt, toFinding(wt, f)));
      }
    },
    finish: () => {
      if (!reported) review.error ||= "Claude exited without a result.";
    }
  });
  return review;
}

// src/server/coderabbit.ts
async function crUsage(wt) {
  const r = await probe("coderabbit", ["usage", "--agent"], { cwd: wt.path });
  const u = rec(rec(lastJson(r.out)).includedReviews);
  if (u.state !== "available") return null;
  const { limit, remaining, fullCapacityInMs, rollingWindowMs, repository } = u;
  if (typeof limit !== "number" || typeof remaining !== "number" || typeof fullCapacityInMs !== "number" || typeof rollingWindowMs !== "number" || typeof repository !== "string") return null;
  return { limit, remaining, fullInMs: fullCapacityInMs, windowMs: rollingWindowMs, repository };
}
var asText = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join("\n\n");
  if (typeof v === "object") {
    const o = rec(v);
    const t = o.text || o.code || o.suggestion || o.diff || o.command;
    return typeof t === "string" ? t : JSON.stringify(v, null, 2);
  }
  return String(v);
};
function toFinding2(ev) {
  const start = Number(ev.startLine ?? ev.line ?? ev.lineStart) || null;
  return {
    id: newId("f"),
    source: "coderabbit",
    severity: String(ev.severity || "info").toLowerCase(),
    file: asStr(ev.fileName) || asStr(ev.file) || asStr(ev.path) || "",
    startLine: start,
    endLine: Number(ev.endLine ?? ev.lineEnd) || start,
    title: asText(ev.title),
    comment: asText(ev.comment),
    codegen: asText(ev.codegenInstructions),
    suggestions: asText(ev.suggestions),
    status: "open"
  };
}
async function startCodeRabbit(wt) {
  assertIdle(wt, "coderabbit");
  const integ = await getIntegrations();
  if (!integ.coderabbit.installed) throw httpError(409, "The CodeRabbit CLI is not installed. See Settings.");
  if (!integ.coderabbit.authed) throw httpError(409, "Sign in to CodeRabbit in Settings first.");
  await refreshWorktree(wt);
  const usage = await crUsage(wt);
  if (usage && usage.remaining <= 0) {
    throw httpError(429, `No CodeRabbit reviews left for ${usage.repository} this hour. Try again in about ${Math.ceil(usage.fullInMs / 6e4)} minutes.`);
  }
  const review = beginReview(wt, "coderabbit", { usage: usage ? { ...usage, remaining: Math.max(0, usage.remaining - 1) } : null });
  runReview(wt, review, "coderabbit", ["review", "--agent", "--base", wt.baseRef ?? "", "--include-untracked"], {
    onEvent: (ev) => {
      if (ev.type === "finding") review.findings.push(addSnippet(wt, toFinding2(ev)));
      else if (ev.type === "complete") {
        review.reviewedFiles = isStringArray(ev.reviewedFiles) ? ev.reviewedFiles : [];
        review.message = asStr(ev.message);
      } else if (ev.type === "error") review.error = asStr(ev.message) || asStr(ev.error) || "CodeRabbit reported an error.";
      else if (ev.type === "status" && ev.message) review.message = asStr(ev.message);
    }
  });
  return review;
}

// src/server/diffs.ts
import fs11 from "node:fs";
import path9 from "node:path";
async function snapshotTree(wt) {
  if (wt.snap && wt.snap.fp === wt.fingerprint) return wt.snap.tree;
  const fp = wt.fingerprint;
  const index = path9.resolve(wt.path, (await git(wt.path, ["rev-parse", "--git-path", "index"])).trim());
  const tmp = path9.join(TMP_DIR, `${wt.id}-${Date.now()}.index`);
  try {
    try {
      fs11.copyFileSync(index, tmp);
    } catch {
    }
    const env = { GIT_INDEX_FILE: tmp };
    await git(wt.path, ["add", "-A"], { env });
    const tree = (await git(wt.path, ["write-tree"], { env })).trim();
    wt.snap = { fp, tree };
    return tree;
  } finally {
    fs11.rmSync(tmp, { force: true });
    fs11.rmSync(tmp + ".lock", { force: true });
  }
}
function memo(wt, key, fn) {
  if (wt.memo?.fp !== wt.fingerprint) wt.memo = { fp: wt.fingerprint, results: /* @__PURE__ */ new Map() };
  const results = wt.memo.results;
  let p = results.get(key);
  if (!p) {
    p = fn();
    results.set(key, p);
    p.catch(() => {
      if (results.get(key) === p) results.delete(key);
    });
  }
  return p;
}
var DIFF_ARGS = ["diff", "--no-color", "--no-ext-diff", "-M", "--src-prefix=a/", "--dst-prefix=b/"];
var MAX_DIFF = 30 * 1024 * 1024;
async function branchCommits(wt, mergeBase) {
  return (await git(wt.path, ["log", "--reverse", "--format=%H%x1f%ct%x1f%an%x1f%s%x1f%b%x1e", `${mergeBase}..HEAD`])).split("").map((r) => r.replace(/^\n/, "")).filter(Boolean).map((r, i) => {
    const [sha = "", ct, author = "", subject = "", body = ""] = r.split("");
    return { n: i + 1, sha, time: Number(ct) * 1e3, author, subject, body: body.trim() };
  });
}
async function fileCommitMap(wt, mergeBase, commits, tree) {
  const map = {};
  const byShaN = new Map(commits.map((c) => [c.sha, c.n]));
  if (commits.length) {
    const out = await git(wt.path, ["log", "--reverse", "--format=@%H", "--name-only", "-M", `${mergeBase}..HEAD`]);
    let n = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("@")) n = byShaN.get(line.slice(1));
      else if (line && n) {
        const nums = map[line] ||= [];
        if (!nums.includes(n)) nums.push(n);
      }
    }
  }
  const dirty2 = await git(wt.path, ["diff", "--name-only", "-M", "HEAD", tree]);
  for (const f of dirty2.split("\n").filter(Boolean)) (map[f] ||= []).push(0);
  return map;
}
async function blameWorktree(wt, mergeBase, files, commits) {
  const byShaN = new Map(commits.map((c) => [c.sha, c.n]));
  const result = {};
  await Promise.all(files.slice(0, 200).map(async (file) => {
    const abs = path9.join(wt.path, file);
    try {
      if (fs11.statSync(abs).size > 2 * 1024 * 1024) return;
    } catch {
      return;
    }
    let out;
    try {
      out = await git(wt.path, ["blame", "--porcelain", "--contents", abs, `${mergeBase}..`, "--", file], { timeout: 2e4 });
    } catch {
      return;
    }
    const runs = [];
    for (const line of out.split("\n")) {
      const m = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
      if (!m) continue;
      const sha = m[1] ?? "";
      const n = /^0{40}$/.test(sha) ? 0 : byShaN.get(sha);
      if (n === void 0) continue;
      const ln = Number(m[2]);
      const last = runs[runs.length - 1];
      if (last && last[2] === n && last[1] === ln - 1) last[1] = ln;
      else runs.push([ln, ln, n]);
    }
    if (runs.length) result[file] = runs;
  }));
  return result;
}
async function getBlame(wt) {
  await refreshWorktree(wt);
  const mergeBase = wt.mergeBase;
  if (!mergeBase) throw httpError(409, wt.baseError || "No merge base");
  return blameFor(wt, mergeBase);
}
function blameFor(wt, mergeBase) {
  const fp = wt.fingerprint;
  return memo(wt, `blame:${mergeBase}`, async () => {
    const [tree, commits] = await Promise.all([snapshot(wt), commitsFor(wt, mergeBase)]);
    const files = (await git(wt.path, ["diff", "--name-only", "--diff-filter=d", "-M", mergeBase, tree])).split("\n").filter(Boolean);
    return { fingerprint: fp, lines: await blameWorktree(wt, mergeBase, files, commits) };
  });
}
var snapshot = (wt) => memo(wt, "tree", () => snapshotTree(wt));
var commitsFor = (wt, mergeBase) => memo(wt, `commits:${mergeBase}`, () => branchCommits(wt, mergeBase));
async function perCommitDiffs(wt, shown) {
  const byCommit = /* @__PURE__ */ new Map();
  const first = shown[0], last = shown[shown.length - 1];
  if (!first || !last) return byCommit;
  try {
    const out = await git(wt.path, ["log", ...DIFF_ARGS.slice(1), "-p", "--diff-merges=first-parent", "--format=%x00%H", `${first.sha}^..${last.sha}`]);
    for (const chunk of out.split("\0")) {
      const nl = chunk.indexOf("\n");
      if (nl === -1) continue;
      byCommit.set(chunk.slice(0, nl), chunk.slice(nl + 1).replace(/^\n/, ""));
    }
    if (shown.every((c) => byCommit.has(c.sha))) return byCommit;
  } catch {
  }
  byCommit.clear();
  for (const c of shown) byCommit.set(c.sha, await git(wt.path, [...DIFF_ARGS, `${c.sha}^`, c.sha]).catch(() => ""));
  return byCommit;
}
async function getCommitDiffs(wt, tree, commits) {
  const shown = commits.slice(-100);
  const [byCommit, uncommitted] = await Promise.all([perCommitDiffs(wt, shown), git(wt.path, [...DIFF_ARGS, "HEAD", tree])]);
  let budget = MAX_DIFF;
  const out = [];
  for (const c of shown) {
    const diff = budget > 0 ? byCommit.get(c.sha) ?? "" : "";
    budget -= diff.length;
    out.push({ ...c, diff: diff.slice(0, Math.max(0, budget + diff.length)), truncated: budget < 0 });
  }
  return { commits: out, hiddenCommits: commits.length - shown.length, uncommitted: uncommitted.slice(0, MAX_DIFF) };
}
async function getDiff(wt, mode) {
  await refreshWorktree(wt);
  const mergeBase = wt.mergeBase;
  if (!mergeBase) throw httpError(409, wt.baseError || "No merge base");
  const s = wtState(wt.id, wt.path);
  const reviewedTree = s.reviewedTree;
  const [tree, commits, sinceAvailable] = await Promise.all([
    snapshot(wt),
    commitsFor(wt, mergeBase),
    reviewedTree ? memo(wt, `has:${reviewedTree}`, () => gitOk(wt.path, ["cat-file", "-e", `${reviewedTree}^{tree}`])) : Promise.resolve(false)
  ]);
  let from = mergeBase;
  if (mode === "since" && sinceAvailable) from = reviewedTree ?? from;
  const base = {
    sinceAvailable,
    reviewedAt: s.reviewedAt || null,
    fingerprint: wt.fingerprint,
    tree,
    mergeBase,
    baseRef: wt.baseRef,
    baseSource: wt.baseSource,
    commits,
    viewed: s.viewed || {}
  };
  const warmBlame = (r) => {
    setImmediate(() => blameFor(wt, mergeBase).catch(() => {
    }));
    return r;
  };
  if (mode === "commits") {
    const result2 = { ...base, mode: "commits", ...await memo(wt, `bycommit:${mergeBase}`, () => getCommitDiffs(wt, tree, commits)) };
    return warmBlame(result2);
  }
  const [diff, fileCommits] = await Promise.all([
    memo(wt, `diff:${from}`, () => git(wt.path, [...DIFF_ARGS, from, tree])),
    memo(wt, `files:${mergeBase}`, () => fileCommitMap(wt, mergeBase, commits, tree))
  ]);
  const result = {
    fileCommits,
    ...base,
    mode: from === mergeBase ? "full" : "since",
    truncated: diff.length > MAX_DIFF,
    diff: diff.slice(0, MAX_DIFF)
  };
  return warmBlame(result);
}
var UNCOMMITTED = "0".repeat(40);
async function getFileBlame(wt, file) {
  await refreshWorktree(wt);
  const abs = path9.resolve(wt.path, file);
  if (!file || !abs.startsWith(wt.path + path9.sep)) throw httpError(400, "Not a file in this worktree");
  let size;
  try {
    size = fs11.statSync(abs).size;
  } catch {
    throw httpError(404, `${file} isn't in the worktree`);
  }
  if (size > 2 * 1024 * 1024) throw httpError(413, `${file} is too big to blame`);
  const mergeBase = wt.mergeBase;
  const fp = wt.fingerprint;
  return memo(wt, `fileblame:${file}`, async () => {
    const commits = mergeBase ? await commitsFor(wt, mergeBase) : [];
    const byShaN = new Map(commits.map((c) => [c.sha, c.n]));
    const info = {};
    const runs = [];
    let out = null;
    try {
      out = await git(wt.path, ["blame", "--porcelain", "--contents", abs, "--", file], { timeout: 3e4 });
    } catch {
    }
    if (out === null) {
      const lines = fs11.readFileSync(abs, "utf8").split("\n").length;
      info[UNCOMMITTED] = { sha: UNCOMMITTED, author: "You", time: fs11.statSync(abs).mtimeMs, summary: "Not committed yet", n: 0 };
      runs.push([1, Math.max(1, lines - 1), UNCOMMITTED]);
      return { file, fingerprint: fp, commits: info, runs };
    }
    let sha = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("	")) continue;
      const head = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
      if (head) {
        sha = head[1] ?? "";
        const ln = Number(head[2]);
        const last = runs[runs.length - 1];
        if (last && last[2] === sha && last[1] === ln - 1) last[1] = ln;
        else runs.push([ln, ln, sha]);
        info[sha] ||= { sha, author: "", time: 0, summary: "", n: sha === UNCOMMITTED ? 0 : byShaN.get(sha) ?? null };
        continue;
      }
      const c = info[sha];
      if (!c) continue;
      const sp = line.indexOf(" ");
      const key = sp === -1 ? line : line.slice(0, sp), val = sp === -1 ? "" : line.slice(sp + 1);
      if (key === "author") c.author = sha === UNCOMMITTED ? "You" : val;
      else if (key === "author-time") c.time = Number(val) * 1e3;
      else if (key === "summary") c.summary = sha === UNCOMMITTED ? "Not committed yet" : val;
    }
    return { file, fingerprint: fp, commits: info, runs };
  });
}

// src/server/reviews.ts
function getComment(id) {
  const c = state.comments.find((x) => x.id === id);
  if (!c) throw httpError(404, "Unknown comment");
  return c;
}
function reviewPrompt(wt, review, comments) {
  const lines = [];
  lines.push(`## Code review on \`${wt.branch || wt.head?.slice(0, 10)}\` (${wt.path})`);
  lines.push("");
  lines.push("This review was left in the Worktree Review dashboard. Address each comment in that worktree.");
  if (review?.summary) lines.push("", "### Overall", "", review.summary);
  for (const c of comments) {
    const where = c.commit ? ` (as of commit ${c.commit.slice(0, 8)}${c.commitSubject ? ` "${c.commitSubject}"` : ""})` : "";
    lines.push("", `### ${c.file}:${c.line}${c.side === "old" ? " (removed line)" : ""}${where}  [${c.id}]`);
    if (c.lineText) lines.push("", "```", c.lineText, "```");
    lines.push("", c.body);
    for (const r of c.replies || []) lines.push("", `> **${r.author === "you" ? "Reviewer" : "Claude"}:** ${r.body.replace(/\n/g, "\n> ")}`);
  }
  if (comments.length) {
    lines.push(
      "",
      "---",
      "When a comment is dealt with, mark it resolved so the dashboard shows it (say what you changed):",
      `curl -s -X POST http://127.0.0.1:${PORT}/api/comments/<comment-id>/resolve -H 'x-wtr: 1' -H 'content-type: application/json' -d '{"note":"..."}'`,
      'To answer a comment without resolving it (you disagree, or need clarification), use /reply instead of /resolve with {"body":"..."}.'
    );
  }
  return lines.join("\n");
}
function submitReview(wt, { summary, targetSession }) {
  const drafts = state.comments.filter((c) => c.wtId === wt.id && c.status === "draft");
  if (!drafts.length && !summary?.trim()) throw httpError(400, "Nothing to submit");
  const review = {
    id: newId("r"),
    wtId: wt.id,
    wtPath: wt.path,
    summary: summary?.trim() || "",
    commentIds: drafts.map((c) => c.id),
    targetSession: targetSession || null,
    status: "pending",
    createdAt: Date.now()
  };
  for (const c of drafts) {
    c.status = "pending";
    c.reviewId = review.id;
  }
  state.reviews.push(review);
  save();
  changed();
  return review;
}
function claimReviews({ session_id, cwd }) {
  const session = session_id === void 0 ? void 0 : sessions.get(session_id);
  const ownWt = [...wts.values()].filter((w) => cwd && (cwd === w.path || cwd.startsWith(w.path + "/"))).sort((a, b) => b.path.length - a.path.length)[0];
  const claimed = [];
  for (const r of state.reviews) {
    if (r.status !== "pending") continue;
    const wt = wts.get(r.wtId);
    if (!wt) continue;
    const ok = r.targetSession ? r.targetSession === session_id : session?.worktreePaths.includes(wt.path) || ownWt?.id === wt.id;
    if (!ok) continue;
    r.status = "delivered";
    r.deliveredAt = Date.now();
    const deliveredTo = { sessionId: session_id, name: session?.name || session_id?.slice(0, 8) };
    r.deliveredTo = deliveredTo;
    const comments = state.comments.filter((c) => r.commentIds.includes(c.id));
    for (const c of comments) if (c.status === "pending") {
      c.status = "delivered";
      c.deliveredTo = deliveredTo;
    }
    claimed.push(reviewPrompt(wt, r, comments));
  }
  if (claimed.length) {
    save();
    changed();
  }
  return claimed.length ? claimed.join("\n\n") : null;
}

// src/server/settings.ts
import fs12 from "node:fs";
import path10 from "node:path";
var isIntIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
async function updateConfig(body) {
  const patch = isRecord(body) ? body : {};
  const errors = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === "roots" || k === "extraRepos") {
      if (!isStringArray(v)) {
        errors.push(`Invalid value for ${k}`);
        continue;
      }
      const missing = v.filter((p) => !fs12.existsSync(expand(p.trim())));
      if (missing.length) {
        errors.push(`Folder not found: ${missing.join(", ")}`);
        continue;
      }
      config[k] = [...new Set(v.map((p) => p.trim()).filter(Boolean))];
    } else if (k === "autoCleanup") {
      if (typeof v !== "boolean") {
        errors.push(`Invalid value for ${k}`);
        continue;
      }
      config.autoCleanup = v;
    } else if (k === "editor") {
      if (!isEditor(v)) {
        errors.push(`Invalid value for ${k}`);
        continue;
      }
      config.editor = v;
    } else if (k === "reviewEffort") {
      if (!isEffort(v)) {
        errors.push(`Invalid value for ${k}`);
        continue;
      }
      config.reviewEffort = v;
    } else if (k === "recentDays") {
      if (!isIntIn(v, 1, 90)) {
        errors.push(`Invalid value for ${k}`);
        continue;
      }
      config.recentDays = v;
    } else if (k === "prPollMinutes") {
      if (!isIntIn(v, 1, 60)) {
        errors.push(`Invalid value for ${k}`);
        continue;
      }
      config.prPollMinutes = v;
    }
  }
  if (errors.length) throw httpError(400, errors.join("; "));
  fs12.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  if ("roots" in patch || "extraRepos" in patch) await discoverWorktrees();
  changed();
}
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", ".Trash", "Library", ".cache", ".npm", ".pnpm-store"]);
function listDir(p, showHidden) {
  const full = path10.resolve(expand(p || "~"));
  if (full !== HOME && !full.startsWith(HOME + path10.sep)) throw httpError(403, "Only folders inside your home directory can be browsed.");
  let dirents;
  try {
    dirents = fs12.readdirSync(full, { withFileTypes: true });
  } catch {
    throw httpError(404, `Can't open ${full}`);
  }
  const isRepo = (d) => fs12.existsSync(path10.join(d, ".git"));
  const entries = [];
  for (const e of dirents) {
    if (SKIP_DIRS.has(e.name) || !showHidden && e.name.startsWith(".")) continue;
    const child = path10.join(full, e.name);
    let dir = e.isDirectory();
    if (!dir && e.isSymbolicLink()) {
      try {
        dir = fs12.statSync(child).isDirectory();
      } catch {
      }
    }
    if (!dir) continue;
    entries.push({ name: e.name, path: child, isRepo: isRepo(child) });
    if (entries.length >= 1e3) break;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, void 0, { sensitivity: "base" }));
  return {
    path: full,
    display: full === HOME ? "~" : full.startsWith(HOME + path10.sep) ? "~" + full.slice(HOME.length) : full,
    parent: full === HOME ? null : path10.dirname(full),
    isRepo: isRepo(full),
    repoChildren: entries.filter((e) => e.isRepo).length,
    entries
  };
}

// src/server/routes.ts
var bodyOf = (raw) => raw;
var arg = (m, i = 1) => m[i];
var routes = [
  ["GET", /^\/api\/state$/, () => publicState()],
  ["GET", /^\/api\/worktrees\/(\w+)\/diff$/, (m, _body, url) => getDiff(getWt(arg(m)), url.searchParams.get("mode"))],
  ["GET", /^\/api\/worktrees\/(\w+)\/bases$/, (m) => baseChoices(getWt(arg(m)))],
  ["GET", /^\/api\/worktrees\/(\w+)\/blame$/, (m) => getBlame(getWt(arg(m)))],
  ["GET", /^\/api\/worktrees\/(\w+)\/blame\/file$/, (m, _body, url) => getFileBlame(getWt(arg(m)), url.searchParams.get("path") || "")],
  ["GET", /^\/api\/worktrees\/(\w+)\/comments$/, (m) => {
    getWt(arg(m));
    return {
      comments: state.comments.filter((c) => c.wtId === m[1]),
      reviews: state.reviews.filter((r) => r.wtId === m[1] && r.status === "pending")
    };
  }],
  ["GET", /^\/api\/worktrees\/(\w+)\/prompt$/, (m) => {
    const wt = getWt(arg(m));
    const cs = state.comments.filter((c) => c.wtId === wt.id && (c.status === "draft" || c.status === "pending"));
    return { text: reviewPrompt(wt, null, cs) };
  }],
  ["POST", /^\/api\/worktrees\/(\w+)\/base$/, async (m, raw) => {
    const body = bodyOf(raw);
    const wt = getWt(arg(m));
    const ref = (body.base || "").trim();
    if (ref && !await gitOk(wt.path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) throw httpError(400, `Unknown ref: ${ref}`);
    wtState(wt.id, wt.path).baseOverride = ref || null;
    save();
    await refreshWorktree(wt, { force: true });
    return { ok: true };
  }],
  ["POST", /^\/api\/worktrees\/(\w+)\/reviewed$/, (m, raw) => {
    const body = bodyOf(raw);
    const wt = getWt(arg(m));
    const s = wtState(wt.id, wt.path);
    s.reviewedTree = body.tree;
    s.reviewedFp = wt.snap && wt.snap.tree === body.tree ? wt.snap.fp : body.fingerprint;
    s.reviewedAt = Date.now();
    save();
    changed();
    return { ok: true };
  }],
  ["POST", /^\/api\/worktrees\/(\w+)\/viewed$/, (m, raw) => {
    const body = bodyOf(raw);
    const wt = getWt(arg(m));
    const s = wtState(wt.id, wt.path);
    s.viewed ||= {};
    if (body.viewed) s.viewed[body.file] = body.hash;
    else delete s.viewed[body.file];
    save();
    return { ok: true };
  }],
  ["POST", /^\/api\/worktrees\/(\w+)\/submit$/, (m, raw) => submitReview(getWt(arg(m)), bodyOf(raw))],
  ["POST", /^\/api\/worktrees\/(\w+)\/remove$/, (m, raw) => {
    const body = bodyOf(raw);
    const wt = getWt(arg(m));
    if (wt.busy) throw httpError(409, "This worktree is already being removed.");
    const force = body.force === true;
    return startJob("remove", `Removing ${wt.branch || "worktree"}${force ? " (anyway)" : ""}`, [wt], (w) => removeWorktree(w, "manual", { force }));
  }],
  ["POST", /^\/api\/jobs\/(\w+)\/dismiss$/, (m) => {
    const job = jobs.find((j) => j.id === m[1]);
    if (job) job.dismissed = true;
    changed();
    return { ok: true };
  }],
  ["POST", /^\/api\/cleanup\/safe$/, () => {
    const items = [...wts.values()].filter((wt) => {
      const cs = !wt.busy && cleanupStatus(wt);
      return cs && cs.kind === "merged" && cs.eligible;
    });
    if (!items.length) throw httpError(409, "Nothing is safe to remove right now.");
    return startJob("cleanup", `Removing ${items.length} merged worktree${items.length === 1 ? "" : "s"}`, items, (wt) => removeWorktree(wt, "manual"));
  }],
  // Remove the worktrees you picked on the clean-up page. Each is checked again just before removal.
  ["POST", /^\/api\/cleanup$/, (_m, raw) => {
    const body = bodyOf(raw);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const items = ids.flatMap((id) => {
      const wt = typeof id === "string" ? wts.get(id) : void 0;
      return wt && !wt.busy && cleanupStatus(wt)?.eligible ? [wt] : [];
    });
    if (!items.length) throw httpError(409, "None of those can be removed right now.");
    return startJob("cleanup", `Removing ${items.length} worktree${items.length === 1 ? "" : "s"}`, items, (wt) => removeWorktree(wt, "manual"));
  }],
  ["POST", /^\/api\/worktrees\/(\w+)\/repair$/, async (m) => repairWorktrees([getWt(arg(m))])],
  ["POST", /^\/api\/repair$/, async () => repairWorktrees([...wts.values()].filter((w) => w.error?.kind === "broken-link"))],
  ["POST", /^\/api\/config$/, async (_m, body) => {
    await updateConfig(body);
    return { ok: true };
  }],
  ["GET", /^\/api\/worktrees\/(\w+)\/code-reviews$/, async (m, _body, url) => {
    const wt = getWt(arg(m));
    const reviews = state.codeReviews[wt.id] ?? {};
    return { reviews, usage: url.searchParams.has("usage") ? await crUsage(wt) : reviews.coderabbit?.usage || null };
  }],
  ["POST", /^\/api\/worktrees\/(\w+)\/code-review$/, (m, raw) => {
    const body = bodyOf(raw);
    const wt = getWt(arg(m));
    if (body.reviewer === "coderabbit") return startCodeRabbit(wt);
    if (body.reviewer === "claude") return startClaudeReview(wt, body.effort);
    throw httpError(400, "Choose a reviewer: coderabbit or claude.");
  }],
  ["POST", /^\/api\/worktrees\/(\w+)\/code-review\/(coderabbit|claude)\/cancel$/, (m) => {
    cancelReview(arg(m), arg(m, 2));
    return { ok: true };
  }],
  ["POST", /^\/api\/findings\/(\w+)\/(send|dismiss|restore)$/, (m) => {
    const { wtId, finding } = getFinding(arg(m));
    if (m[2] === "send") findingToComment(wtId, finding);
    else if (m[2] === "dismiss") finding.status = "dismissed";
    else finding.status = "open";
    save();
    changed();
    return finding;
  }],
  ["POST", /^\/api\/worktrees\/(\w+)\/code-review\/(coderabbit|claude)\/send-all$/, (m) => {
    const wt = getWt(arg(m));
    const reviewer = arg(m, 2);
    const r = isReviewer(reviewer) ? reviewOf(wt.id, reviewer) : void 0;
    const open = (r?.findings || []).filter((f) => f.status === "open");
    for (const f of open) findingToComment(wt.id, f);
    save();
    changed();
    return { sent: open.length };
  }],
  ["GET", /^\/api\/fs$/, (_m, _body, url) => listDir(url.searchParams.get("path"), url.searchParams.get("hidden") === "1")],
  ["GET", /^\/api\/integrations$/, (_m, _body, url) => getIntegrations(url.searchParams.has("refresh"))],
  ["POST", /^\/api\/integrations\/coderabbit\/login$/, () => startCodeRabbitLogin()],
  ["POST", /^\/api\/integrations\/coderabbit\/logout$/, async () => {
    await probe("coderabbit", ["auth", "logout", "--agent"]);
    return getIntegrations(true);
  }],
  ["POST", /^\/api\/onboarding$/, (_m, raw) => {
    const body = bodyOf(raw);
    state.onboardedAt = body.done === false ? null : Date.now();
    save();
    changed();
    return { ok: true };
  }],
  ["POST", /^\/api\/comments$/, (_m, raw) => {
    const body = bodyOf(raw);
    const wt = getWt(body.wtId);
    if (!body.body?.trim()) throw httpError(400, "Empty comment");
    const c = {
      id: newId("c"),
      wtId: wt.id,
      wtPath: wt.path,
      file: body.file,
      line: body.line,
      side: body.side,
      lineText: body.lineText,
      body: body.body.trim(),
      status: "draft",
      createdAt: Date.now(),
      replies: [],
      commit: /^[0-9a-f]{40}$/.test(body.commit || "") ? body.commit : void 0,
      commitSubject: body.commitSubject || void 0
    };
    state.comments.push(c);
    save();
    changed();
    return c;
  }],
  ["PATCH", /^\/api\/comments\/(\w+)$/, (m, raw) => {
    const body = bodyOf(raw);
    const c = getComment(arg(m));
    if (c.status !== "draft") throw httpError(409, "Only drafts can be edited");
    c.body = String(body.body || "").trim() || c.body;
    save();
    return c;
  }],
  ["DELETE", /^\/api\/comments\/(\w+)$/, (m) => {
    const c = getComment(arg(m));
    state.comments = state.comments.filter((x) => x !== c);
    save();
    changed();
    return { ok: true };
  }],
  ["POST", /^\/api\/comments\/(\w+)\/reply$/, (m, raw) => {
    const body = bodyOf(raw);
    const c = getComment(arg(m));
    if (!body.body?.trim()) throw httpError(400, "Empty reply");
    const author = body.author || "claude";
    c.replies.push({ author, body: body.body.trim(), at: Date.now() });
    if (author === "you" && c.status !== "draft") c.status = "draft";
    save();
    changed();
    return c;
  }],
  ["POST", /^\/api\/comments\/(\w+)\/resolve$/, (m, raw) => {
    const body = bodyOf(raw);
    const c = getComment(arg(m));
    c.status = "resolved";
    c.resolvedAt = Date.now();
    if (body.note?.trim()) c.replies.push({ author: body.author || "claude", body: body.note.trim(), at: Date.now() });
    save();
    changed();
    return c;
  }],
  ["POST", /^\/api\/comments\/(\w+)\/reopen$/, (m) => {
    const c = getComment(arg(m));
    c.status = "delivered";
    save();
    changed();
    return c;
  }],
  ["POST", /^\/api\/reviews\/(\w+)\/cancel$/, (m) => {
    const r = state.reviews.find((x) => x.id === m[1] && x.status === "pending");
    if (!r) throw httpError(404, "No pending review");
    r.status = "cancelled";
    for (const c of state.comments) if (r.commentIds.includes(c.id) && c.status === "pending") c.status = "draft";
    save();
    changed();
    return { ok: true };
  }],
  ["POST", /^\/api\/shutdown$/, (_m, raw) => {
    const body = bodyOf(raw);
    const replacement = typeof body.restartWith === "string" && body.restartWith.endsWith("server.mjs") && fs13.existsSync(body.restartWith) ? body.restartWith : null;
    if (jobsRunning()) {
      deferShutdown(replacement);
      log(`shutdown requested; waiting for running jobs to finish${replacement ? `, then starting ${replacement}` : ""}`);
      return { ok: true, deferred: true };
    }
    setTimeout(() => shutdownNow(replacement), 100);
    return { ok: true };
  }],
  ["POST", /^\/api\/hook$/, (_m, raw) => {
    markHook();
    refreshSessions();
    return { text: claimReviews(bodyOf(raw)) };
  }]
];
if (process.env.WTR_TEST_JOBS === "1") {
  routes.push(["POST", /^\/api\/test\/job$/, (_m, raw) => {
    const body = bodyOf(raw);
    const items = Array.from({ length: body.count || 4 }, (_, i) => ({ id: `test${i}`, branch: `test/branch-${i + 1}`, path: `${HOME}/fake/wt-${i + 1}` }));
    return startJob("cleanup", `Removing ${items.length} merged worktrees`, items, async (w) => {
      await new Promise((r) => setTimeout(r, body.delay || 1500));
      if (w.id === `test${body.failAt ?? -1}`) throw new Error("Git refused to remove it: Git found modified or untracked files in it, so it wasn't removed.");
    });
  }]);
}

// src/server/http.ts
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 2e6) reject(httpError(413, "Too large"));
      else chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(httpError(400, "Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}
function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function sendRaw(res, status, body, type) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}
var MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
var server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  if (!["127.0.0.1", "localhost"].includes(host)) return send(res, 403, { error: "Forbidden host" });
  if (url.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`event: state
data: ${JSON.stringify(publicState())}

`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    if (req.method !== "GET" && req.headers["x-wtr"] !== "1") return send(res, 403, { error: "Missing x-wtr header" });
    let match = null;
    const route = routes.find(([method, re]) => method === req.method && (match = url.pathname.match(re)));
    if (!route || !match) return send(res, 404, { error: "Not found" });
    try {
      const body = req.method === "GET" ? {} : await readBody(req);
      send(res, 200, await route[2](match, body, url));
    } catch (e) {
      const { status, message, stderr } = errInfo(e);
      if (!status) log("error", req.method, url.pathname, message);
      send(res, status || 500, { error: status ? firstLine(message) : stderr ? gitError(e) : firstLine(message) });
    }
    return;
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const full = path11.join(HERE, "public", path11.normalize(file));
  if (!full.startsWith(path11.join(HERE, "public"))) return sendRaw(res, 403, "Forbidden", "text/plain");
  fs14.readFile(full, (err, data) => {
    if (err) return sendRaw(res, 404, "Not found", "text/plain");
    sendRaw(res, 200, data, MIME[path11.extname(full)] || "application/octet-stream");
  });
});

// src/server/main.ts
async function loop(fn, ms) {
  try {
    await fn();
  } catch (e) {
    log("loop error", errInfo(e).message);
  }
  setTimeout(() => void loop(fn, ms), typeof ms === "function" ? ms() : ms);
}
startBroadcast();
registerServer(server);
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    log(`Port ${PORT} is already in use; another copy is probably running.`);
    process.exit(0);
  }
  throw e;
});
server.listen(PORT, "127.0.0.1", async () => {
  log(`Worktree Review ${VERSION} on http://127.0.0.1:${PORT}  (data: ${DATA_DIR})`);
  state.trash = state.trash.filter((p) => fs15.existsSync(p));
  for (const p of state.trash) deleteInBackground(p);
  await discoverWorktrees();
  refreshSessions();
  getIntegrations().then(changed, () => {
  });
  void loop(discoverWorktrees, 3e4);
  void loop(async () => refreshSessions(), 3e3);
  void loop(pollWorktrees, 1e3);
  setTimeout(() => void loop(refreshPRs, () => config.prPollMinutes * 6e4), 5e3);
});
