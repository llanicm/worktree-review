// Claude Code hook (UserPromptSubmit + Stop). Asks the Worktree Review server
// for any submitted reviews meant for this session and hands them to Claude.
// Never blocks or fails the session: if the server is down, it does nothing.
const PORT = Number(process.env.WTR_PORT || 4747);

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    // Claude Code's hook input; only these three fields are used, and they pass through as sent.
    const input = parsed as { session_id?: unknown; cwd?: unknown; hook_event_name?: unknown };
    const res = await fetch(`http://127.0.0.1:${PORT}/api/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wtr': '1' },
      body: JSON.stringify({ session_id: input.session_id, cwd: input.cwd, event: input.hook_event_name }),
      signal: AbortSignal.timeout(1500),
    });
    const reply = (await res.json()) as { text?: unknown };
    const text = reply.text;
    if (!text) return;
    if (input.hook_event_name === 'Stop') {
      // Keep Claude going so it picks up the review you submitted while it was working.
      process.stdout.write(JSON.stringify({ decision: 'block', reason: text }));
    } else {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
      }));
    }
  } catch {
    // Server not running or slow; stay out of the way.
  }
});
