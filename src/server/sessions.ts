import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_DIR } from './paths.ts';
import { pidAlive } from './exec.ts';
import { changed, sessions, wts } from './state.ts';
import { isRecord, loadJson } from './util.ts';

const transcriptCache = new Map<string, string>(); // sessionId -> path

function findTranscript(sessionId: string): string | null {
  const cached = transcriptCache.get(sessionId);
  if (cached) return cached;
  const projects = path.join(CLAUDE_DIR, 'projects');
  try {
    for (const d of fs.readdirSync(projects)) {
      const p = path.join(projects, d, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) { transcriptCache.set(sessionId, p); return p; }
    }
  } catch {}
  return null;
}

function readTail(p: string, bytes: number): string {
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
function linkSession(text: string, paths: string[]): string[] {
  const result: { path: string; last: number }[] = [];
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

interface SessionInfo { sessionId: string; pid: number; name?: string; status?: string; cwd?: string }

// ~/.claude/sessions/*.json is Claude Code's file, so only the fields used here are read.
function parseSessionInfo(v: unknown): SessionInfo | null {
  if (!isRecord(v) || typeof v.sessionId !== 'string' || !v.sessionId || typeof v.pid !== 'number' || !v.pid) return null;
  return {
    sessionId: v.sessionId, pid: v.pid,
    name: typeof v.name === 'string' ? v.name : undefined,
    status: typeof v.status === 'string' ? v.status : undefined,
    cwd: typeof v.cwd === 'string' ? v.cwd : undefined,
  };
}

export function refreshSessions(): void {
  const dir = path.join(CLAUDE_DIR, 'sessions');
  const live = new Set<string>();
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {}
  const paths = [...wts.values()].map((w) => w.path);
  for (const f of files) {
    const info = parseSessionInfo(loadJson(path.join(dir, f), null));
    if (!info || !pidAlive(info.pid)) continue;
    live.add(info.sessionId);
    let s = sessions.get(info.sessionId);
    if (!s) { s = { sessionId: info.sessionId, worktreePaths: [], scannedSize: -1, scannedAt: 0, pid: info.pid, name: '', status: 'unknown' }; sessions.set(info.sessionId, s); }
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
    const cwd = s.cwd;
    if (cwd) {
      const own = paths.filter((p) => cwd === p || cwd.startsWith(p + '/')).sort((a, b) => b.length - a.length)[0];
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
