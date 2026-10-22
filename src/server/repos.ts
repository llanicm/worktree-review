import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { git, gitOk } from './exec.ts';
import { CLAUDE_DIR, expand } from './paths.ts';
import { repos, sessions, wts } from './state.ts';
import type { Repo } from './types.ts';

// Every directory Claude Code has worked in recently, read from transcript `cwd` fields.
let claudeCwds: { at: number; dirs: string[] } = { at: 0, dirs: [] };
const cwdScan = new Map<string, { offset: number; dirs: Set<string>; carry: string }>(); // transcript path -> scan progress

function recentClaudeCwds(): string[] {
  if (Date.now() - claudeCwds.at < 5 * 60_000) return claudeCwds.dirs;
  const dirs = new Set<string>();
  const projects = path.join(CLAUDE_DIR, 'projects');
  const cutoff = Date.now() - 30 * 864e5;
  let files: { p: string; m: number }[] = [];
  try {
    for (const d of fs.readdirSync(projects)) {
      let entries: string[] = [];
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

export async function discoverRepos(): Promise<void> {
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
    let entries: fs.Dirent[] = [];
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
      const repo: Repo = { root: fs.existsSync(mainDir) ? mainDir : p, commonDir: common, name: path.basename(mainDir).replace(/\.git$/, ''), gh: null, defaultBase: 'origin/main' };
      try {
        const url = (await git(p, ['remote', 'get-url', 'origin'])).trim();
        const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
        if (m && m[1] && m[2]) repo.gh = { owner: m[1], name: m[2] };
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
