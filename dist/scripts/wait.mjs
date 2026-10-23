// Generated from src/ by build.mjs. Edit the TypeScript source, not this file.

// src/scripts/wait.ts
var PORT = Number(process.env.WTR_PORT || 4747);
var raw = "";
process.stdin.on("data", (c) => {
  raw += c;
});
process.stdin.on("end", async () => {
  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {
  }
  let failures = 0;
  for (; ; ) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/wait`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-wtr": "1" },
        body: JSON.stringify({ session_id: input.session_id, cwd: input.cwd }),
        signal: AbortSignal.timeout(7e4)
      });
      if (!res.ok) return;
      const reply = await res.json();
      if (typeof reply.text === "string" && reply.text) {
        process.stderr.write(reply.text);
        process.exitCode = 2;
        return;
      }
      if (reply.done) return;
      failures = 0;
    } catch {
      if (++failures > 5) return;
      await new Promise((r) => setTimeout(r, 5e3));
    }
  }
});
