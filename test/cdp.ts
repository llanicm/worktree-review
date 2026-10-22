// A minimal headless Chrome driver over the DevTools protocol, for tests and screenshots.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Page {
  errors: string[];
  eval<T = unknown>(expression: string): Promise<T>;
  /** Polls an expression until it's truthy and returns it, or throws after `ms`. */
  waitFor<T = unknown>(expression: string, ms?: number): Promise<T>;
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

export async function openPage(url: string, { width = 1440, height = 900, scale = 1 } = {}): Promise<Page> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wtr-chrome-'));
  const port = 9300 + (process.pid % 500);
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = ((await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as any[]).find((t) => t.type === 'page'); } catch {}
  }
  if (!target) { chrome.kill('SIGKILL'); throw new Error(`Chrome didn't start (${CHROME})`); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pending = new Map<number, (m: any) => void>();
  const errors: string[] = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a: any) => a.value ?? a.description).join(' '));
  });
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((r) => { const i = ++seq; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result?.result?.value as T;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await send('Page.navigate', { url });
  return {
    errors,
    send,
    eval: evaluate,
    async waitFor<T>(expression: string, ms = 10_000): Promise<T> {
      const end = Date.now() + ms;
      for (;;) {
        const v = await evaluate<T>(expression).catch(() => undefined);
        if (v) return v;
        if (Date.now() > end) throw new Error(`Timed out waiting for: ${expression}`);
        await sleep(100);
      }
    },
    async close() {
      ws.close();
      chrome.kill('SIGKILL');
      await sleep(300);
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
