// SessionStart hook: make sure the Worktree Review server is running, and
// replace it if an older version of this plugin started it. Prints nothing
// (SessionStart output would land in Claude's context) unless --open is given.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Compiled to dist/scripts/ensure-server.mjs, so the plugin root is two levels up.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(ROOT, 'dist', 'server.mjs');
const PORT = Number(process.env.WTR_PORT || 4747);
const PAGE = `http://localhost:${PORT}`;
const DATA_DIR = process.env.WTR_DATA_DIR || path.join(os.homedir(), '.claude', 'worktree-review');
const VERSION = String((JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: unknown }).version);
const wantOpen = process.argv.includes('--open');

const newer = (a: string, b: string): boolean => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The version of the server answering on the port, or null if none is. */
async function running(): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/state`, { signal: AbortSignal.timeout(800) });
    const state = (await res.json()) as { version?: string };
    return state.version || 'dev';
  } catch { return null; }
}

function start(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
  spawn(process.execPath, [SERVER], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: process.env,
  }).unref();
}

async function main(): Promise<void> {
  const current = await running();
  if (current && current !== 'dev' && newer(VERSION, current)) {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, {
      method: 'POST', headers: { 'x-wtr': '1', 'content-type': 'application/json' }, body: JSON.stringify({ restartWith: SERVER }),
    }).then((r) => r.json() as Promise<{ deferred?: boolean }>).catch((): { deferred?: boolean } => ({}));
    // If a removal is running, the old server finishes it and starts this version itself.
    if (!res.deferred) {
      for (let i = 0; i < 20 && (await running()); i++) await wait(150);
      start();
    }
  } else if (!current) {
    start();
  }
  if (!wantOpen) return;
  for (let i = 0; i < 30 && !(await running()); i++) await wait(200);
  if (!(await running())) {
    console.log(`Worktree Review didn't start. See ${path.join(DATA_DIR, 'server.log')}.`);
    return;
  }
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(opener, [PAGE], () => {});
  console.log(`Opened Worktree Review at ${PAGE}`);
}

main().catch(() => {}).finally(() => setTimeout(() => process.exit(0), 50));
