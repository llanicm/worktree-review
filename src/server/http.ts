import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { errInfo, gitError, httpError } from './exec.ts';
import { HERE, PORT } from './paths.ts';
import { clients, publicState } from './public-state.ts';
import { routes } from './routes.ts';
import { firstLine, log } from './util.ts';
import { addWaiter } from './wake.ts';

// ---------- HTTP ----------

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > 2e6) reject(httpError(413, 'Too large')); else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(httpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendRaw(res: http.ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  // Only answer requests addressed to this machine (guards against DNS rebinding).
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost'].includes(host)) return send(res, 403, { error: 'Forbidden host' });

  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Held open like the events stream, so a waiter that goes away is forgotten at once.
  if (url.pathname === '/api/wait' && req.method === 'POST' && req.headers['x-wtr'] === '1') {
    let body: unknown;
    try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    addWaiter(body, (r) => send(res, 200, r), (fn) => res.on('close', () => { if (!res.writableEnded) fn(); }));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    // Mutations need a custom header, which cross-site pages can't send without a CORS preflight we never grant.
    if (req.method !== 'GET' && req.headers['x-wtr'] !== '1') return send(res, 403, { error: 'Missing x-wtr header' });
    let match: RegExpMatchArray | null = null;
    const route = routes.find(([method, re]) => method === req.method && (match = url.pathname.match(re)));
    if (!route || !match) return send(res, 404, { error: 'Not found' });
    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      send(res, 200, await route[2](match, body, url));
    } catch (e) {
      const { status, message, stderr } = errInfo(e);
      if (!status) log('error', req.method, url.pathname, message);
      send(res, status || 500, { error: status ? firstLine(message) : (stderr ? gitError(e) : firstLine(message)) });
    }
    return;
  }

  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const full = path.join(HERE, 'public', path.normalize(file));
  if (!full.startsWith(path.join(HERE, 'public'))) return sendRaw(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(full, (err, data) => {
    if (err) return sendRaw(res, 404, 'Not found', 'text/plain');
    sendRaw(res, 200, data, MIME[path.extname(full)] || 'application/octet-stream');
  });
});
