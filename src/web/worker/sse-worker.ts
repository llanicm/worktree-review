// One live-update connection shared by every open dashboard tab. Browsers allow
// only ~6 connections per host, and each EventSource holds one open forever, so
// per-tab connections starve every other request once a few tabs are open.

// This file is a module only so the declaration below stays local; esbuild emits it as a plain script.
declare const self: SharedWorkerGlobalScope;

/** What the page's onLiveMessage accepts (mirrors LiveMessage in src/web/types.ts, which a worker can't import). */
type LiveMessage = { type: 'state'; data: string } | { type: 'error' };

const ports = new Set<MessagePort>();
let es: EventSource | null = null;
let last: string | null = null;

function broadcast(msg: LiveMessage) {
  for (const port of ports) {
    try { port.postMessage(msg); } catch { ports.delete(port); }
  }
}

function ensure() {
  if (es) return;
  es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    if (!(e instanceof MessageEvent) || typeof e.data !== 'string') return;
    last = e.data;
    broadcast({ type: 'state', data: e.data });
  });
  es.onerror = () => broadcast({ type: 'error' });
}

self.onconnect = (e) => {
  const port = e.ports[0];
  if (!port) return;
  ports.add(port);
  port.onmessage = (m) => {
    if (m.data === 'close') {
      ports.delete(port);
      if (!ports.size && es) { es.close(); es = null; last = null; }
    }
  };
  port.start();
  ensure();
  if (last) port.postMessage({ type: 'state', data: last } satisfies LiveMessage);
};

export {};
