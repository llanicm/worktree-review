// Performance benchmark: server response times and page rendering on a large worktree
// (the demo with WTR_DEMO_BIG: 20 commits, 80 files, ~8,000 changed lines).
//
//   node test/bench.ts            (uses ./dist; WTR_DIST to point elsewhere; needs Chrome)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openPage, type Page } from './cdp.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.WTR_TEST_PORT || 4859);
const BASE = `http://127.0.0.1:${PORT}`;
const DEMO = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wtr-bench-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const results: [string, string][] = [];
const record = (name: string, value: string) => { results.push([name, value]); console.log(`${name.padEnd(44)} ${value}`); };

async function time(url: string): Promise<{ ms: number; bytes: number }> {
  const t = performance.now();
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return { ms: performance.now() - t, bytes: buf.byteLength };
}

// Main-thread time spent in long tasks (>50 ms) while `action` runs and the page settles.
async function blocking(page: Page, action: string, settle = 2500): Promise<{ total: number; longest: number; tasks: number }> {
  await page.eval(`window.__lt = []; window.__po?.disconnect(); window.__po = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }); window.__po.observe({ type: 'longtask' });`);
  await page.eval(action);
  await sleep(settle);
  const lt = await page.eval<number[]>('window.__lt');
  return { total: Math.round(lt.reduce((a, b) => a + b, 0)), longest: Math.round(Math.max(0, ...lt)), tasks: lt.length };
}
const fmt = (b: { total: number; longest: number; tasks: number }) => `${b.total} ms blocked (longest ${b.longest} ms, ${b.tasks} long tasks)`;

try {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'extras', 'demo', 'demo.mjs'), DEMO], { env: { ...process.env, WTR_PORT: String(PORT), WTR_DEMO_BIG: '1' }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  let big: { id: string } | undefined;
  for (let i = 0; i < 100 && !big; i++) {
    await sleep(200);
    big = (await (await fetch(`${BASE}/api/state`)).json()).worktrees.find((w: { branch: string; mergeBase?: string; fingerprint: string | null }) => w.branch === 'feat/big-refactor' && w.fingerprint);
  }
  if (!big) throw new Error('big worktree not found');
  const wt = `${BASE}/api/worktrees/${big.id}`;

  // ---------- server ----------
  const st = await time(`${BASE}/api/state`);
  record('GET /api/state', `${st.ms.toFixed(1)} ms, ${(st.bytes / 1024).toFixed(0)} KB`);
  for (const [name, url] of [['diff (all changes)', `${wt}/diff?mode=full`], ['diff (by commit)', `${wt}/diff?mode=commits`], ['blame', `${wt}/blame`]] as const) {
    const first = await time(url);
    const again: number[] = [];
    for (let i = 0; i < 5; i++) again.push((await time(url)).ms);
    record(`GET ${name}`, `first ${first.ms.toFixed(0)} ms, then ${median(again).toFixed(0)} ms (${(first.bytes / 1024).toFixed(0)} KB)`);
  }
  const integ = await time(`${BASE}/api/integrations`);
  record('GET /api/integrations', `${integ.ms.toFixed(0)} ms`);

  // ---------- page ----------
  const page = await openPage(`${BASE}/#/settings`);
  try {
    await page.waitFor("document.querySelector('#main h1')");
    await sleep(1000);
    const t0 = Date.now();
    const open = await blocking(page, `location.hash = '#/${big.id}'`, 0);
    await page.waitFor("document.querySelectorAll('tr.line').length > 0", 20_000);
    record('page: open the big worktree, first diff rows', `${Date.now() - t0} ms`);
    await sleep(2500);
    const after = await page.eval<number[]>('window.__lt');
    record('page: open the big worktree, main thread', fmt({ total: Math.round(after.reduce((a, b) => a + b, 0)), longest: Math.round(Math.max(0, ...after)), tasks: after.length }));
    void open;
    record('page: DOM nodes / diff rows rendered', `${await page.eval("document.getElementsByTagName('*').length")} / ${await page.eval("document.querySelectorAll('tr.line').length")}`);
    record('page: collapse one file', fmt(await blocking(page, "document.querySelector('[data-act=toggle-file]').click()", 1200)));
    record('page: expand it again', fmt(await blocking(page, "document.querySelector('[data-act=toggle-file]').click()", 1200)));
    record('page: Collapse all', fmt(await blocking(page, "document.querySelector('[data-act=collapse-all]').click()", 1200)));
    record('page: expand one file after Collapse all', fmt(await blocking(page, "document.querySelector('[data-act=toggle-file]').click()", 1200)));
    record('page: switch to By commit', fmt(await blocking(page, "document.querySelector('[data-act=mode][data-mode=commits]').click()")));
    record('page: switch back to All changes', fmt(await blocking(page, "document.querySelector('[data-act=mode][data-mode=full]').click()")));
    // A live update that doesn't concern this worktree: another worktree gets a new file.
    fs.writeFileSync(path.join(DEMO, 'home', 'code', 'shop-worktrees', 'graphql-spike', 'note.txt'), 'x');
    record('page: unrelated live update', fmt(await blocking(page, '0', 4000)));
    record('page: type in the sidebar filter', fmt(await blocking(page, "(() => { const i = document.querySelector('#filter'); i.value = 'big'; i.dispatchEvent(new Event('input', { bubbles: true })); })()", 800)));
    record('page: scroll to the bottom', fmt(await blocking(page, "document.querySelector('#main').scrollTop = 1e9", 1500)));
  } finally {
    await page.close();
  }
} finally {
  await fetch(`${BASE}/api/shutdown`, { method: 'POST', headers: { 'x-wtr': '1' } }).catch(() => {});
  const pids = path.join(DEMO, 'pids');
  for (const pid of fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').split('\n').filter(Boolean) : []) { try { process.kill(Number(pid)); } catch {} }
  await sleep(300);
  fs.rmSync(DEMO, { recursive: true, force: true });
}
if (process.env.WTR_BENCH_OUT) fs.writeFileSync(process.env.WTR_BENCH_OUT, JSON.stringify(results, null, 2));
