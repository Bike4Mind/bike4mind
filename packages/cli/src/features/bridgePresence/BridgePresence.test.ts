import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { ListenerOwner } from './peerOwner.js';

// Hoisted so the vi.mock factories (themselves hoisted above imports) can
// reference these safely.
const { resolveMock, readFileMock, warn } = vi.hoisted(() => ({
  resolveMock: vi.fn<(port: number) => Promise<ListenerOwner>>(),
  readFileMock: vi.fn<() => Promise<string>>(),
  warn: vi.fn(),
}));

// Owner-lookup seam - the only pre-transmission trust signal. Stub it per test
// to model a trusted (same-UID) peer, a foreign owner, a not-yet-listening
// bridge, and an undeterminable owner, without touching a live socket.
vi.mock('./peerOwner.js', () => ({
  resolveLoopbackListenerOwner: (port: number) => resolveMock(port),
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
const me = (): number => process.getuid!();
const OWNER = (uid: number): ListenerOwner => ({ kind: 'owner', uid });

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
    readFileMock.mockReset();
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
    resolveMock.mockResolvedValue(OWNER(me()));
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
    resolveMock.mockResolvedValue(OWNER(me() + 1));
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
    resolveMock.mockResolvedValueOnce(OWNER(me())).mockResolvedValue(OWNER(me() + 1));
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

  it('stays quiet (no security warning) when no bridge is listening yet (nit: absent != untrusted)', async () => {
    resolveMock.mockResolvedValue({ kind: 'no-listener' });
    const presence = new BridgePresence();

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(false);
    expect(httpRequests).toEqual([]);
    expect(wsConnections).toEqual([]);
    expect(warn).not.toHaveBeenCalled();

    await presence.stop();
  });

  it('fails closed and warns when the owner is undeterminable (criterion 3)', async () => {
    resolveMock.mockResolvedValue({ kind: 'unknown' });
    const presence = new BridgePresence();

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(false);
    expect(httpRequests).toEqual([]);
    expect(wsConnections).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    await presence.stop();
  });

  it('does not crash or leave a live socket when stop() lands during the trust probe (BLOCKER 1)', async () => {
    let release!: (owner: ListenerOwner) => void;
    resolveMock.mockImplementation(() => new Promise<ListenerOwner>(r => (release = r)));
    const presence = new BridgePresence();

    const startP = presence.start({ workspacePath: '/tmp/ws' });
    // Let start() reach the awaited probe, then tear down mid-flight.
    await waitFor(() => typeof release === 'function');
    await presence.stop();
    release(OWNER(me())); // probe resolves AFTER teardown nulled the instance state

    // Pre-fix this rejected with `TypeError: reading 'workspacePath'`; now the
    // post-await re-check returns cleanly and nothing was disclosed.
    await expect(startP).resolves.toBe(false);
    expect(httpRequests).toEqual([]);
    expect(wsConnections).toEqual([]);
  });

  it('stops disclosing the secret once the port owner flips after announce (BLOCKER 3: /event + /disconnect gated)', async () => {
    resolveMock
      .mockResolvedValueOnce(OWNER(me())) // announce
      .mockResolvedValueOnce(OWNER(me())) // initial WS connect
      .mockResolvedValue(OWNER(me() + 1)); // reconnect after the owner flips
    const presence = new BridgePresence();

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(true);
    await waitFor(() => wsConnections.length > 0 && httpRequests.some(u => u.startsWith('/event')));
    const eventsBefore = httpRequests.filter(u => u.startsWith('/event')).length;

    // Real bridge dies -> our WS drops -> gate closes; a foreign owner is now
    // on the port. The reconnect probe (foreign) fires the one warning.
    sockets[0].close();
    await waitFor(() => warn.mock.calls.length > 0);

    // The full transcript event must not leave: post() refuses while the gate
    // is closed. Pre-fix, both of these POSTed `?secret=...` unauthenticated.
    await presence.emitEvent({ type: 'message', role: 'assistant', text: 'TOP SECRET TRANSCRIPT' });
    expect(httpRequests.filter(u => u.startsWith('/event')).length).toBe(eventsBefore);

    await presence.stop();
    expect(httpRequests.some(u => u.startsWith('/disconnect'))).toBe(false);
  });

  it('fails closed and warns once when getuid is unavailable (BLOCKER 5: Windows)', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'getuid');
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
    try {
      const presence = new BridgePresence();
      const ok = await presence.start({ workspacePath: '/tmp/ws' });
      expect(ok).toBe(false);
      expect(httpRequests).toEqual([]);
      expect(wsConnections).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      await presence.stop();
    } finally {
      if (original) Object.defineProperty(process, 'getuid', original);
    }
  });

  it('recovers presence when an untrusted peer is later replaced by a trusted one (BLOCKER 5: recovery)', async () => {
    resolveMock
      .mockResolvedValueOnce(OWNER(me() + 1)) // first probe: foreign -> warn + retry
      .mockResolvedValue(OWNER(me())); // announce-retry: trusted -> announce + WS
    const presence = new BridgePresence();

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);

    // The announce-retry (1s backoff) re-probes, now trusted, and brings the
    // sprite up - recovery is actually observed, not just asserted in prose.
    await waitFor(() => wsConnections.length > 0, 4000);
    expect(httpRequests.some(u => u.startsWith('/announce') && u.includes(`secret=${SECRET}`))).toBe(true);

    await presence.stop();
  });

  it('warns only once across repeated untrusted probes (BLOCKER 5: latch is not vacuous)', async () => {
    resolveMock.mockResolvedValue(OWNER(me() + 1)); // always foreign
    const presence = new BridgePresence();

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(false);

    // Wait for the announce-retry to fire a SECOND probe; the latch must
    // suppress a second warning across the two untrusted probes.
    await waitFor(() => resolveMock.mock.calls.length >= 2, 4000);
    expect(warn).toHaveBeenCalledTimes(1);

    await presence.stop();
  });
});
