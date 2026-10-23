// Claude Code Stop hook, run in the background (`asyncRewake`). Waits while the session sits idle for a review
// sent to it from Worktree Review, then prints it and exits with code 2, which wakes the session with it.
// Exits quietly (code 0) when the session ends, another stop replaces this waiter, or the server is gone.
const PORT = Number(process.env.WTR_PORT || 4747);

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  let input: { session_id?: unknown; cwd?: unknown } = {};
  try { input = JSON.parse(raw || '{}') as typeof input; } catch {}
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/wait`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-wtr': '1' },
        body: JSON.stringify({ session_id: input.session_id, cwd: input.cwd }),
        signal: AbortSignal.timeout(70_000),
      });
      if (!res.ok) return;
      const reply = (await res.json()) as { text?: unknown; done?: unknown };
      if (typeof reply.text === 'string' && reply.text) {
        process.stderr.write(reply.text);
        process.exitCode = 2;
        return;
      }
      if (reply.done) return;
      failures = 0;
    } catch {
      // The server may be restarting for an update; give it a little while.
      if (++failures > 5) return;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
});

export {};
