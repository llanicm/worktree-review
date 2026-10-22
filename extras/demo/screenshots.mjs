#!/usr/bin/env node
// Takes the README screenshots from a running demo (node extras/demo/demo.mjs) with headless Chrome.
//
//   node extras/demo/screenshots.mjs [out-dir]     (default: docs/screenshots; port: WTR_PORT or 4848)
//
// Set CHROME to the Chrome binary if it isn't in the usual macOS place.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'screenshots'));
const PORT = Number(process.env.WTR_PORT || 4848);
const URL = `http://localhost:${PORT}/`;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1440, H = 900, SCALE = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const st = await fetch(`${URL}api/state`).then((r) => r.json());
const id = (branch) => st.worktrees.find((w) => w.branch === branch)?.id;
const feature = id('feat/checkout-discounts');

// Each shot: where to go, what to do first, and what to capture (the viewport, or one element).
const SHOTS = [
  { name: 'overview', hash: `#/${feature}`, wait: 2500 },
  { name: 'coderabbit', hash: `#/${feature}`, scroll: '.cr-finding', clip: 'section.file:has(.cr-finding)' },
  { name: 'blame', hash: `#/${feature}`, run: "[...document.querySelectorAll('section.file')].find((s) => s.querySelector('.file-name')?.getAttribute('title') === 'src/checkout.ts').querySelector('[data-act=blame-file]').click()", wait: 1500, clip: 'section.file:has(table.blamed)' },
  { name: 'by-commit', hash: `#/${feature}`, run: "document.querySelector('[data-act=mode][data-mode=commits]').click()", wait: 2000 },
  { name: 'merged', hash: `#/${id('refactor/api-client')}`, clip: '.callout.warn', pad: 16 },
  { name: 'cleanup', hash: '#/cleanup' },
  { name: 'settings', hash: '#/settings', wait: 2500 },
];

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wtr-shots-'));
const debugPort = 9300 + (process.pid % 500);
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, 'about:blank'], { stdio: 'ignore' });
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'); } catch {}
  }
  if (!target) throw new Error("Chrome didn't start. Set CHROME to its path.");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++seq; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  fs.mkdirSync(OUT, { recursive: true });

  for (const s of SHOTS) {
    // Close-ups get a tall window, so the element fits, and no floating review box over them.
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: s.clip ? 2400 : H, deviceScaleFactor: SCALE, mobile: false });
    await send('Page.navigate', { url: URL + s.hash });
    await sleep(s.wait || 1800);
    if (s.clip) await evaluate("document.head.insertAdjacentHTML('beforeend', '<style>.review-bar{display:none!important}</style>')");
    if (s.run) { await evaluate(s.run); await sleep(s.wait || 1500); }
    if (s.scroll) await evaluate(`document.querySelector(${JSON.stringify(s.scroll)})?.scrollIntoView({ block: 'center' })`);
    await sleep(400);
    let clip;
    if (s.clip) {
      const pad = s.pad ?? 0;
      clip = await evaluate(`(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(s.clip)})][0];
        if (!el) return null;
        el.scrollIntoView({ block: 'start' });
        const r = el.getBoundingClientRect();
        return { x: Math.max(0, r.x - ${pad}), y: Math.max(0, r.y - ${pad}) + scrollY, width: r.width + ${pad * 2}, height: Math.min(r.height + ${pad * 2}, 2400 - r.y), scale: 1 };
      })()`);
      await sleep(300);
    }
    const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
    fs.writeFileSync(path.join(OUT, `${s.name}.png`), Buffer.from(r.result.data, 'base64'));
    console.log(`${s.name}.png${s.clip && !clip ? ' (element not found, took the viewport)' : ''}`);
  }
  ws.close();
} finally {
  chrome.kill('SIGKILL');
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
