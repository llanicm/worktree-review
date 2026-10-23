import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_DIR, HOME } from './paths.ts';
import { pidAlive } from './exec.ts';
import { changed, reviewerPids, sessions, wts } from './state.ts';
import type { AgentRecord, SessionRecord } from './types.ts';
import { asStr, isRecord, loadJson, rec } from './util.ts';
import { discoverWorktrees } from './worktrees.ts';

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

// Which worktrees has this session been working in? One counts when the session's directory was inside it,
// it edited a file in it, or it ran a shell command that went into it (`cd`) or changed it with `git -C`.
// Only mentioning a path, as reading, searching or listing worktrees does, isn't working there.
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const GIT_CHANGES = /^(add|am|apply|checkout|cherry-pick|commit|merge|mv|pull|push|rebase|reset|restore|revert|rm|stash|switch)$/;
const ARG = String.raw`("[^"]+"|'[^']+'|[^\s;&|)]+)`;
const CD = new RegExp(String.raw`(?:^|[;&|(]\s*)cd\s+${ARG}`, 'g');
const GIT_C = new RegExp(String.raw`\bgit\s+-C\s+${ARG}\s+([a-z-]+)`, 'g');

const unquote = (a: string): string => a.replace(/^(["'])(.*)\1$/, '$2').replace(/^~(?=\/|$)/, HOME);

/** The directories a shell command works in, as far as can be told from its text. */
function shellTargets(cmd: string): string[] {
  const dirs = [...cmd.matchAll(CD)].map((m) => unquote(m[1] ?? ''));
  for (const m of cmd.matchAll(GIT_C)) if (GIT_CHANGES.test(m[2] ?? '')) dirs.push(unquote(m[1] ?? ''));
  return dirs.filter((d) => d.startsWith('/'));
}

const worktreeOf = (p: string | undefined, paths: string[]): string | undefined =>
  p ? paths.filter((w) => p === w || p.startsWith(w + '/')).sort((a, b) => b.length - a.length)[0] : undefined;

function linkSession(text: string, paths: string[]): string[] {
  const last = new Map<string, number>(); // worktree -> line it was last worked in
  text.split('\n').forEach((line, i) => {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { return; } // the first line is usually cut off
    const hit = (p: string | undefined): void => { const w = worktreeOf(p, paths); if (w) last.set(w, i); };
    const e = rec(entry);
    hit(asStr(e.cwd));
    const content = rec(e.message).content;
    if (!Array.isArray(content)) return;
    for (const c of content.map(rec)) {
      if (c.type !== 'tool_use') continue;
      const input = rec(c.input);
      if (typeof c.name === 'string' && EDIT_TOOLS.has(c.name)) hit(asStr(input.file_path) ?? asStr(input.notebook_path));
      else if (c.name === 'Bash') for (const d of shellTargets(asStr(input.command) ?? '')) hit(d);
    }
  });
  return [...last].sort((a, b) => b[1] - a[1]).map(([p]) => p);
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

// Subagents write their transcripts next to their session's, in <session>/subagents/agent-<id>.jsonl, with an
// agent-<id>.meta.json that gains `finished: true` when they're done. One started with `isolation: "worktree"`
// records the worktree it was given. Claude Code's files again, so only the fields used here are read.
interface AgentMeta { agentType: string; description: string; worktreePath?: string; finished: boolean }

function parseAgentMeta(v: unknown): AgentMeta | null {
  if (!isRecord(v)) return null;
  return {
    agentType: typeof v.agentType === 'string' ? v.agentType : 'agent',
    description: typeof v.description === 'string' ? v.description : '',
    worktreePath: typeof v.worktreePath === 'string' ? v.worktreePath : undefined,
    finished: v.finished === true,
  };
}

// A subagent whose transcript hasn't changed in this long is taken to have died without saying so.
const AGENT_STALE_MS = 30 * 60_000;

// A subagent's new worktree usually appears before the next scheduled look for worktrees.
let discovering: Promise<void> | null = null;
const discoverSoon = (): void => { discovering ??= discoverWorktrees().catch(() => {}).finally(() => { discovering = null; }); };

/** The session's subagents that are still running, and the worktrees each is working in. */
function refreshAgents(s: SessionRecord, transcript: string, paths: string[], ownPath: string | undefined): AgentRecord[] {
  const dir = path.join(path.dirname(transcript), s.sessionId, 'subagents');
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json')); } catch { return []; }
  const result: AgentRecord[] = [];
  for (const f of files) {
    const meta = parseAgentMeta(loadJson(path.join(dir, f), null));
    if (!meta || meta.finished) continue;
    const agentId = f.slice(0, -'.meta.json'.length).replace(/^agent-/, '');
    const tp = path.join(dir, f.slice(0, -'.meta.json'.length) + '.jsonl');
    let size: number, mtime: number;
    try { ({ size, mtimeMs: mtime } = fs.statSync(tp)); } catch { continue; }
    if (Date.now() - mtime > AGENT_STALE_MS) continue;
    const a = s.agents.find((x) => x.agentId === agentId)
      ?? { agentId, description: meta.description, agentType: meta.agentType, worktreePaths: [], scannedSize: -1, scannedAt: 0 };
    if (meta.worktreePath) {
      // Its worktree sits inside the repository's folder, so only an exact match counts.
      a.worktreePaths = paths.filter((p) => p === meta.worktreePath);
      if (!a.worktreePaths.length) discoverSoon();
    } else if (size !== a.scannedSize && Date.now() - a.scannedAt > 8_000) {
      a.scannedSize = size;
      a.scannedAt = Date.now();
      // Without a worktree of its own, a subagent starts in its session's directory; only count
      // the worktrees it reaches into from there.
      // It can be removed between the stat and the read; keep what it had and look again next time.
      try { a.worktreePaths = linkSession(readTail(tp, 3 * 1024 * 1024), paths).filter((p) => p !== ownPath); } catch { a.scannedSize = -1; }
    }
    result.push(a);
  }
  return result;
}


export function refreshSessions(): void {
  const dir = path.join(CLAUDE_DIR, 'sessions');
  const live = new Set<string>();
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {}
  const paths = [...wts.values()].map((w) => w.path);
  for (const f of files) {
    const info = parseSessionInfo(loadJson(path.join(dir, f), null));
    if (!info || !pidAlive(info.pid) || reviewerPids.has(info.pid)) continue;
    live.add(info.sessionId);
    let s = sessions.get(info.sessionId);
    if (!s) { s = { sessionId: info.sessionId, worktreePaths: [], scannedSize: -1, scannedAt: 0, pid: info.pid, name: '', status: 'unknown', agents: [] }; sessions.set(info.sessionId, s); }
    Object.assign(s, { pid: info.pid, name: info.name || info.sessionId.slice(0, 8), status: info.status || 'unknown', cwd: info.cwd });
    const own = worktreeOf(s.cwd, paths);
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
      s.agents = refreshAgents(s, tp, paths, own);
    }
    if (own && !s.worktreePaths.includes(own)) s.worktreePaths.unshift(own);
  }
  for (const id of sessions.keys()) if (!live.has(id)) sessions.delete(id);
  for (const wt of wts.values()) {
    const linked = [...sessions.values()].filter((s) => s.worktreePaths.includes(wt.path));
    const agents = [...sessions.values()].flatMap((s) => s.agents
      .filter((a) => a.worktreePaths.includes(wt.path))
      .map((a) => ({ agentId: a.agentId, description: a.description, agentType: a.agentType, parent: { sessionId: s.sessionId, name: s.name, status: s.status } })));
    const sig = linked.map((s) => s.sessionId + s.status).concat(agents.map((a) => a.agentId + a.parent.status)).join(',');
    if (sig !== wt.sessionSig) { wt.sessionSig = sig; changed(); }
    wt.sessions = linked;
    wt.agents = agents;
  }
}
