// Self-host WebSocket gateway.
//
// Replaces AWS API Gateway WebSocket for the Docker Compose self-host stack. It
// has two faces on a single port:
//
//   1. A browser-facing WebSocket server (WEBSOCKET_URL, e.g. ws://localhost:3001).
//      On connect it authenticates by delegating to the app, keeps a
//      connectionId -> socket map, answers heartbeats locally, and forwards every
//      other inbound frame to the app to run the real handler logic
//      (subscribe_query / unsubscribe_query, with the app's CASL scoping intact).
//
//   2. An API Gateway Management API emulator (WEBSOCKET_MANAGEMENT_ENDPOINT, e.g.
//      http://ws:3001). It accepts `POST /@connections/{id}` from the app and the
//      subscriber-fanout container and relays the body to the live socket, so
//      server-side pushes (initial data, change-stream fan-out, chat streaming)
//      reach the browser. Returns 410 for dead connections so callers prune them.
//
// The gateway itself holds no auth/model logic; it delegates to the app over an
// internal, shared-secret HTTP endpoint (POST /api/internal/ws/{action}).

import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 3001);
const APP_INTERNAL_URL = (process.env.APP_INTERNAL_URL || 'http://app:3000').replace(/\/$/, '');
const INTERNAL_WS_SECRET = process.env.INTERNAL_WS_SECRET || '';

if (!INTERNAL_WS_SECRET) {
  console.warn('[ws-gateway] INTERNAL_WS_SECRET is empty; the app will reject internal calls.');
}

/** connectionId -> live WebSocket */
const sockets = new Map();

/** Call the app's internal handler bridge. Returns the fetch Response (or null on network error). */
async function callApp(action, payload) {
  try {
    return await fetch(`${APP_INTERNAL_URL}/api/internal/ws/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-ws-secret': INTERNAL_WS_SECRET,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`[ws-gateway] app call '${action}' failed:`, err?.message || err);
    return null;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// ---- HTTP face: API Gateway Management API emulator + health ----------------
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  // POST/GET/DELETE /@connections/{connectionId}
  const match = req.url && req.url.match(/^\/@connections\/([^/?]+)/);
  if (match) {
    const connectionId = decodeURIComponent(match[1]);
    const ws = sockets.get(connectionId);
    const isOpen = ws && ws.readyState === ws.OPEN;

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!isOpen) {
        // Match API Gateway: 410 Gone lets callers prune the stale subscriber.
        res.writeHead(410);
        return res.end('Gone');
      }
      ws.send(body);
      res.writeHead(200);
      return res.end();
    }
    if (req.method === 'DELETE') {
      if (ws) ws.close();
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET') {
      res.writeHead(isOpen ? 200 : 410);
      return res.end();
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

// ---- WebSocket face: browser clients ---------------------------------------
const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  const connectionId = crypto.randomUUID();
  const url = new URL(req.url || '/', 'http://localhost');
  const token = url.searchParams.get('token') || undefined;
  const secWebSocketProtocol = req.headers['sec-websocket-protocol'];

  async function handleFrame(raw) {
    const text = raw.toString('utf8');
    // Heartbeat is answered locally with the bare 'pong' string the client
    // expects as its react-use-websocket returnMessage (see heartbeat.ts).
    let action;
    try {
      action = JSON.parse(text)?.action;
    } catch {
      /* non-JSON frame; forward to the app as-is below */
    }
    if (action === 'heartbeat') {
      ws.send('pong');
      return;
    }
    // Everything else (subscribe_query / unsubscribe_query / ...) runs in the app.
    await callApp('message', { connectionId, body: text }).catch(() => {});
  }

  // Buffer frames that arrive during the auth handshake: react-use-websocket
  // sends subscribe_query right after onOpen, which can race the connect await.
  let ready = false;
  const pending = [];
  ws.on('message', raw => {
    if (ready) handleFrame(raw);
    else pending.push(raw);
  });
  ws.on('close', () => {
    sockets.delete(connectionId);
    callApp('disconnect', { connectionId }).catch(() => {});
  });
  ws.on('error', err => {
    console.error(`[ws-gateway] socket ${connectionId} error:`, err?.message || err);
  });

  // Delegate authentication + Connection-row creation to the app ($connect logic).
  const resp = await callApp('connect', {
    connectionId,
    token,
    headers: secWebSocketProtocol ? { 'sec-websocket-protocol': secWebSocketProtocol } : {},
  });
  if (!resp || !resp.ok) {
    ws.close(1008, 'Unauthorized');
    return;
  }

  sockets.set(connectionId, ws);
  ready = true;
  for (const raw of pending) handleFrame(raw);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ws-gateway] listening on :${PORT} (app=${APP_INTERNAL_URL})`);
});
