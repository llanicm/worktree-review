// Generated from src/ by build.mjs. Edit the TypeScript source, not this file.

// src/web/worker/sse-worker.ts
var ports = /* @__PURE__ */ new Set();
var es = null;
var last = null;
function broadcast(msg) {
  for (const port of ports) {
    try {
      port.postMessage(msg);
    } catch {
      ports.delete(port);
    }
  }
}
function ensure() {
  if (es) return;
  es = new EventSource("/api/events");
  es.addEventListener("state", (e) => {
    if (!(e instanceof MessageEvent) || typeof e.data !== "string") return;
    last = e.data;
    broadcast({ type: "state", data: e.data });
  });
  es.onerror = () => broadcast({ type: "error" });
}
self.onconnect = (e) => {
  const port = e.ports[0];
  if (!port) return;
  ports.add(port);
  port.onmessage = (m) => {
    if (m.data === "close") {
      ports.delete(port);
      if (!ports.size && es) {
        es.close();
        es = null;
        last = null;
      }
    }
  };
  port.start();
  ensure();
  if (last) port.postMessage({ type: "state", data: last });
};
