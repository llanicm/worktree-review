// One live-update connection shared by every open dashboard tab. Browsers allow
// only ~6 connections per host, and each EventSource holds one open forever, so
// per-tab connections starve every other request once a few tabs are open.
const ports = new Set();
let es = null;
let last = null;

function broadcast(msg) {
  for (const port of ports) {
    try { port.postMessage(msg); } catch { ports.delete(port); }
  }
}

function ensure() {
  if (es) return;
  es = new EventSource('/api/events');
  es.addEventListener('state', (e) => { last = e.data; broadcast({ type: 'state', data: e.data }); });
  es.onerror = () => broadcast({ type: 'error' });
}

self.onconnect = (e) => {
  const port = e.ports[0];
  ports.add(port);
  port.onmessage = (m) => {
    if (m.data === 'close') {
      ports.delete(port);
      if (!ports.size && es) { es.close(); es = null; last = null; }
    }
  };
  port.start();
  ensure();
  if (last) port.postMessage({ type: 'state', data: last });
};
