#!/usr/bin/env node
// SessionStart hook: make sure the Worktree Review server is running, and
// replace it if an older version of this plugin started it. Prints nothing
// (SessionStart output would land in Claude's context) unless --open is given.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.WTR_PORT || 4747);
const URL = `http://localhost:${PORT}`;
const DATA_DIR = process.env.WTR_DATA_DIR || path.join(os.homedir(), '.claude', 'worktree-review');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const wantOpen = process.argv.includes('--open');

const newer = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function running() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/state`, { signal: AbortSignal.timeout(800) });
    return (await res.json()).version || 'dev';
  } catch { return null; }
}

function start() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
  spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: process.env,
  }).unref();
}

async function main() {
  const current = await running();
  if (current && current !== 'dev' && newer(VERSION, current)) {
    await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: 'POST', headers: { 'x-wtr': '1' } }).catch(() => {});
    for (let i = 0; i < 20 && (await running()); i++) await wait(150);
    start();
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
  execFile(opener, [URL], () => {});
  console.log(`Opened Worktree Review at ${URL}`);
}

main().catch(() => {}).finally(() => setTimeout(() => process.exit(0), 50));
