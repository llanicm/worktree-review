import fs from 'node:fs';
import { STATE_PATH } from './paths.ts';
import type { Repo, SessionRecord, State, WorktreeRecord, WorktreeState } from './types.ts';
import { isRecord, loadJson } from './util.ts';

// ---------- in-memory registries ----------

export const repos = new Map<string, Repo>(); // commonDir -> repo
export const wts = new Map<string, WorktreeRecord>(); // id -> worktree
export const sessions = new Map<string, SessionRecord>(); // sessionId -> session

// ---------- persisted state ----------

// state.json is only ever written by this server, so its collections are trusted past the
// top-level shape check.
function loadState(): State {
  const saved = loadJson(STATE_PATH, {});
  const o = isRecord(saved) ? saved : {};
  const state: State = {
    installedAt: typeof o.installedAt === 'number' ? o.installedAt : Date.now(),
    worktrees: isRecord(o.worktrees) ? (o.worktrees as Record<string, WorktreeState>) : {},
    comments: Array.isArray(o.comments) ? (o.comments as State['comments']) : [],
    reviews: Array.isArray(o.reviews) ? (o.reviews as State['reviews']) : [],
    cleaned: Array.isArray(o.cleaned) ? (o.cleaned as State['cleaned']) : [],
    trash: Array.isArray(o.trash) ? (o.trash as string[]) : [],
    coderabbit: isRecord(o.coderabbit) ? (o.coderabbit as State['coderabbit']) : {},
  };
  if (typeof o.onboardedAt === 'number' || o.onboardedAt === null) state.onboardedAt = o.onboardedAt;
  // Installed before there was a welcome step, and already used: don't send them through it now.
  else if (state.comments.length || state.cleaned.length || Object.values(state.worktrees).some((w) => w.reviewedAt)) state.onboardedAt = Date.now();
  return state;
}

export const state: State = loadState();
// A review that was running when the server stopped can't be resumed.
for (const r of Object.values(state.coderabbit)) if (r.status === 'running') { r.status = 'failed'; r.error = 'Interrupted: the server restarted during the review.'; }

let saveTimer: NodeJS.Timeout | undefined;
export function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
  }, 200);
}
save();

export function wtState(id: string, p: string): WorktreeState {
  let s = state.worktrees[id];
  if (!s) { s = { path: p, viewed: {} }; state.worktrees[id] = s; }
  return s;
}

// ---------- change tracking (drives the live updates) ----------

let dirty = true;
export function changed(): void { dirty = true; }
/** True once per change; clears the flag. */
export function takeChanged(): boolean {
  const was = dirty;
  dirty = false;
  return was;
}
