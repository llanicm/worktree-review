// Worktree Review client: state object, API client and DOM lookups.
import type { ApiError, PublicState } from '../shared/api.ts';
import type { State, View } from './types.ts';

export const S: State = {
  st: null,
  selId: null,
  mode: null,
  view: null,
  seq: 0,
  editors: new Map(),
  focusEk: null,
  toggled: new Map(),
  forceRender: new Set(),
  filter: '',
  showOlder: false,
  showCleaned: false,
  stale: false,
  summaries: {},
  prevStatus: new Map(),
  page: null,
  cleanSel: new Map(),
  shutCommits: new Set(),
  blameOn: new Set(),
  fileBlame: new Map(),
  openBodies: new Set(),
  removeErrors: {},
  seenJobs: new Set(),
  integ: null,
  setupSig: null,
};

/** querySelector that admits it can find nothing. */
export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null => root.querySelector<T>(sel);

/** For elements index.html guarantees (#main, #list, #toast, #conn, #notify): throws if the markup is ever missing, instead of `!`. */
export function need<T extends Element = HTMLElement>(sel: string): T {
  const el = $<T>(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
}

// The server state / open diff, for code that only runs once they exist (the old code assumed so; this fails loudly).
export function st(): PublicState {
  if (!S.st) throw new Error('No server state yet');
  return S.st;
}
export function view(): View {
  if (!S.view) throw new Error('No diff loaded');
  return S.view;
}

export const curWt = () => S.st?.worktrees.find((w) => w.id === S.selId);

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function api<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-wtr': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  // The server's shape for this route is the caller's T; errors are { error } (ApiError).
  const json = (await res.json().catch(() => ({}))) as Partial<ApiError> & T;
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}
