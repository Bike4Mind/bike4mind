import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';

// Hoisted so the vi.mock factories (themselves hoisted above imports) can
// reference these safely.
const { resolveMock, readFileMock, warn } = vi.hoisted(() => ({
  resolveMock: vi.fn<(port: number) => Promise<number | null>>(),
  readFileMock: vi.fn<() => Promise<string>>(),
  warn: vi.fn(),
}));

// Owner-lookup seam - the only pre-transmission trust signal. Stub it per test
// to model a trusted (same-UID) peer, a mismatched-UID squatter, and an
// undeterminable owner, without touching a live socket.
vi.mock('./peerOwner.js', () => ({
  resolveLoopbackListenerUid: (port: number) => resolveMock(port),
}));

// Point readBridgeConfig at our in-process fake listener (port filled once the
// server is up) with a known secret we can grep the wire for.
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: { ...actual.promises, readFile: () => readFileMock() },
  };
});

vi.mock('../../utils/Logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
}));

// Imported after the mocks are registered.
const { BridgePresence } = await import('./BridgePresence.js');

const SECRET = 'test-hook-secret';

function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - started > ms) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('BridgePresence peer-ownership gate', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let httpRequests: string[];
  let wsConnections: string[];
  let sockets: WsSocket[];
  let port: number;

  beforeEach(async () => {
    httpRequests = [];
    wsConnections = [];
    sockets = [];
    resolveMock.mockReset();
    warn.mockClear();

    server = http.createServer((req, res) => {
      httpRequests.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    wss = new WebSocketServer({ server });
    wss.on('connection', (socket, req) => {
      wsConnections.push(req.url ?? '');
      sockets.push(socket);
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    readFileMock.mockResolvedValue(JSON.stringify({ port, hookSecret: SECRET }));
  });

  afterEach(async () => {
    for (const s of sockets) s.close();
    wss.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('announces, connects and dispatches when the peer UID matches (criterion 2)', async () => {
    resolveMock.mockResolvedValue(process.getuid!());
    const onSendPrompt = vi.fn();
    const presence = new BridgePresence();
    presence.setCallbacks({ onSendPrompt });

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(true);

    await waitFor(() => wsConnections.length > 0);
    // Both the POST /announce and the WS handshake carry the secret.
    expect(httpRequests.some(u => u.startsWith('/announce') && u.includes(`secret=${SECRET}`))).toBe(true);
    expect(wsConnections[0]).toContain(`secret=${SECRET}`);

    sockets[0].send(JSON.stringify({ requestId: 'r1', command: { type: 'send_prompt', text: 'hi' } }));
    await waitFor(() => onSendPrompt.mock.calls.length > 0);
    expect(onSendPrompt).toHaveBeenCalledWith('hi');

    await presence.stop();
  });

  it('discloses nothing to a mismatched-UID peer (criterion 1)', async () => {
    resolveMock.mockResolvedValue(process.getuid!() + 1);
    const onSendPrompt = vi.fn();
    const presence = new BridgePresence();
    presence.setCallbacks({ onSendPrompt });

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(false);

    // No announce, no event, no WS handshake -> the secret never leaves.
    expect(httpRequests).toEqual([]);
    expect(wsConnections).toEqual([]);
    expect(onSendPrompt).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);

    await presence.stop();
  });

  it('re-checks trust before the command WS and refuses a peer that changed after announce', async () => {
    // Trusted at announce, mismatched by the time the WS is built - exercises
    // the per-connect re-check (the TOCTOU-narrowing gate), not just the
    // announce gate.
    resolveMock.mockResolvedValueOnce(process.getuid!()).mockResolvedValue(process.getuid!() + 1);
    const onSendPrompt = vi.fn();
    const presence = new BridgePresence();
    presence.setCallbacks({ onSendPrompt });

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(true);

    // Announce got through (trusted), but the WS handshake must not - the
    // secret never rides the /commands URL and no frames can be delivered.
    await waitFor(() => warn.mock.calls.length > 0);
    expect(httpRequests.some(u => u.startsWith('/announce'))).toBe(true);
    expect(wsConnections).toEqual([]);
    expect(onSendPrompt).not.toHaveBeenCalled();

    await presence.stop();
  });

  it('fails closed when the owner is undeterminable (criterion 3)', async () => {
    resolveMock.mockResolvedValue(null);
    const presence = new BridgePresence();

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(false);
    expect(httpRequests).toEqual([]);
    expect(wsConnections).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    await presence.stop();
  });
});
