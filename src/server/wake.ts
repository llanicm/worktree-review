import type { WaitResponse } from '../shared/api.ts';
import { claimReviews } from './reviews.ts';
import { sessions } from './state.ts';
import { isRecord } from './util.ts';

// ---------- waking an idle session ----------
// When a session stops, the plugin's Stop hooks also leave a waiter running in the background (an `asyncRewake`
// hook, scripts/wait.ts) that long-polls POST /api/wait. A review sent to that session while it sits idle is
// handed to the waiter, which exits with code 2: Claude Code then wakes the session with the review.
// A session that's busy gets its reviews from the Stop hook as before, so the waiter only takes them while idle.

interface Waiter { cwd?: string; reply: (r: WaitResponse) => void }
const waiters = new Map<string, Waiter>(); // sessionId -> its waiter

// Under Node's request timeouts; the waiter asks again straight away.
const POLL_MS = 50_000;

/** Holds the request until there's a review for the session, it ends, or the poll times out. `onClose` fires if the waiter goes away. */
export function addWaiter(body: unknown, reply: (r: WaitResponse) => void, onClose: (fn: () => void) => void): void {
  const sessionId = isRecord(body) && typeof body.session_id === 'string' ? body.session_id : '';
  const cwd = isRecord(body) && typeof body.cwd === 'string' ? body.cwd : undefined;
  if (!sessionId) return reply({ text: null, done: true });
  // A session has one waiter; a newer one (left by its latest stop) replaces it.
  waiters.get(sessionId)?.reply({ text: null, done: true });
  let finished = false;
  const w: Waiter = {
    cwd,
    reply: (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (waiters.get(sessionId) === w) waiters.delete(sessionId);
      reply(r);
    },
  };
  const timer = setTimeout(() => w.reply({ text: null, done: false }), POLL_MS);
  waiters.set(sessionId, w);
  // Once it's gone, nobody would hear a review handed to it.
  onClose(() => { finished = true; clearTimeout(timer); if (waiters.get(sessionId) === w) waiters.delete(sessionId); });
  offerReviews();
}

/** Hands submitted reviews to the waiters of idle sessions, and lets the waiters of ended sessions go. */
export function offerReviews(): void {
  for (const [id, w] of waiters) {
    const s = sessions.get(id);
    if (!s) { w.reply({ text: null, done: true }); continue; }
    if (s.status !== 'idle') continue;
    const text = claimReviews({ session_id: id, cwd: w.cwd });
    if (text) w.reply({ text, done: true });
  }
}
