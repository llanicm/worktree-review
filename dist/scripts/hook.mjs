// Generated from src/ by build.mjs. Edit the TypeScript source, not this file.

// src/scripts/hook.ts
var PORT = Number(process.env.WTR_PORT || 4747);
var raw = "";
process.stdin.on("data", (c) => {
  raw += c;
});
process.stdin.on("end", async () => {
  try {
    const parsed = JSON.parse(raw || "{}");
    const input = parsed;
    const res = await fetch(`http://127.0.0.1:${PORT}/api/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wtr": "1" },
      body: JSON.stringify({ session_id: input.session_id, cwd: input.cwd, event: input.hook_event_name }),
      signal: AbortSignal.timeout(1500)
    });
    const reply = await res.json();
    const text = reply.text;
    if (!text) return;
    if (input.hook_event_name === "Stop") {
      process.stdout.write(JSON.stringify({ decision: "block", reason: text }));
    } else {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text }
      }));
    }
  } catch {
  }
});
