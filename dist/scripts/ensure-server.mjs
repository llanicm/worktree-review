// Generated from src/ by build.mjs. Edit the TypeScript source, not this file.

// src/scripts/ensure-server.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
var SERVER = path.join(ROOT, "dist", "server.mjs");
var PORT = Number(process.env.WTR_PORT || 4747);
var PAGE = `http://localhost:${PORT}`;
var DATA_DIR = process.env.WTR_DATA_DIR || path.join(os.homedir(), ".claude", "worktree-review");
var VERSION = String(JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8")).version);
var wantOpen = process.argv.includes("--open");
var newer = (a, b) => {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
var wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function running() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/state`, { signal: AbortSignal.timeout(800) });
    const state = await res.json();
    return state.version || "dev";
  } catch {
    return null;
  }
}
function start() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = fs.openSync(path.join(DATA_DIR, "server.log"), "a");
  spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env
  }).unref();
}
async function main() {
  const current = await running();
  if (current && current !== "dev" && newer(VERSION, current)) {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, {
      method: "POST",
      headers: { "x-wtr": "1", "content-type": "application/json" },
      body: JSON.stringify({ restartWith: SERVER })
    }).then((r) => r.json()).catch(() => ({}));
    if (!res.deferred) {
      for (let i = 0; i < 20 && await running(); i++) await wait(150);
      start();
    }
  } else if (!current) {
    start();
  }
  if (!wantOpen) return;
  for (let i = 0; i < 30 && !await running(); i++) await wait(200);
  if (!await running()) {
    console.log(`Worktree Review didn't start. See ${path.join(DATA_DIR, "server.log")}.`);
    return;
  }
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(opener, [PAGE], () => {
  });
  console.log(`Opened Worktree Review at ${PAGE}`);
}
main().catch(() => {
}).finally(() => setTimeout(() => process.exit(0), 50));
