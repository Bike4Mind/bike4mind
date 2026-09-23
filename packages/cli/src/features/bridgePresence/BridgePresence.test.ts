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
  // Captured POST bodies for /event, so a test can assert whether a specific
  // event actually left the process (vs. was dropped before post()).
  let eventBodies: string[];
  // Response gates: while a hold flag is on, the fake server parks that path's
  // response and pushes a releaser, letting a test drive teardown into the window
  // between "POST received" and "200 seen".
  let holdAnnounce: boolean;
  let announceReleasers: Array<() => void>;
  let holdEvent: boolean;
  let eventReleasers: Array<() => void>;

  beforeEach(async () => {
    httpRequests = [];
    eventBodies = [];
    wsConnections = [];
    sockets = [];
    holdAnnounce = false;
    announceReleasers = [];
    holdEvent = false;
    eventReleasers = [];
    resolveMock.mockReset();
    readFileMock.mockReset();
    warn.mockClear();

    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', async () => {
        const url = req.url ?? '';
        httpRequests.push(url);
        if (url.startsWith('/event')) eventBodies.push(body);
        if (holdAnnounce && url.startsWith('/announce')) await new Promise<void>(r => announceReleasers.push(r));
        if (holdEvent && url.startsWith('/event')) await new Promise<void>(r => eventReleasers.push(r));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
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

  it('fails closed but stays quiet when the owner is undeterminable (nit N3: undeterminable != foreign)', async () => {
    resolveMock.mockResolvedValue({ kind: 'unknown' });
    const presence = new BridgePresence();

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(false);
    expect(httpRequests).toEqual([]);
    expect(wsConnections).toEqual([]);
    // Undeterminable ownership (missing tool / hung probe / ambiguous) fails
    // closed but is not an attack, so it must NOT fire the security warning.
    expect(warn).not.toHaveBeenCalled();

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

  it('fails closed and stays quiet when getuid is unavailable (nit N3: Windows is undeterminable)', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'getuid');
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
    try {
      const presence = new BridgePresence();
      const ok = await presence.start({ workspacePath: '/tmp/ws' });
      expect(ok).toBe(false);
      expect(httpRequests).toEqual([]);
      expect(wsConnections).toEqual([]);
      // Windows can't run the owner probe: fail-closed, but undeterminable is
      // not an attack, so no security warning (debug only).
      expect(warn).not.toHaveBeenCalled();
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

  it('does not publish identity when stop() lands after the /announce POST is sent (BLOCKER 2a)', async () => {
    // The POST leaves the process, then teardown happens before the 200 lands -
    // the second re-check site (post-announce) must bail without publishing the
    // instanceId or opening the command WS.
    resolveMock.mockResolvedValue(OWNER(me()));
    holdAnnounce = true;
    const presence = new BridgePresence();

    const startP = presence.start({ workspacePath: '/tmp/ws' });
    await waitFor(() => announceReleasers.length === 1);
    await presence.stop();
    announceReleasers.forEach(r => r());

    await expect(startP).resolves.toBe(false);
    expect(wsConnections).toEqual([]);
    expect(httpRequests.some(u => u.startsWith('/event'))).toBe(false);
  });

  it('does not connect the command WS when stop() lands during the WS trust probe (BLOCKER 2b)', async () => {
    // Announce succeeds, then the per-connect WS probe parks; teardown lands
    // while it is parked. The post-await generation re-check in connectCommandWs
    // must bail - no handshake, no live socket, no unhandled rejection.
    let releaseWs!: (owner: ListenerOwner) => void;
    resolveMock
      .mockResolvedValueOnce(OWNER(me())) // announce probe: trusted
      .mockImplementationOnce(() => new Promise<ListenerOwner>(r => (releaseWs = r))); // WS probe parks
    const presence = new BridgePresence();

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(true);
    await waitFor(() => typeof releaseWs === 'function');
    await presence.stop();
    releaseWs(OWNER(me())); // WS probe resolves AFTER teardown

    // Give the stale continuation a chance to (wrongly) build a socket.
    await new Promise(r => setTimeout(r, 50));
    expect(wsConnections).toEqual([]);
  });

  it('closes the trust gate the instant the command WS drops, before any reconnect (nit N1)', async () => {
    resolveMock
      .mockResolvedValueOnce(OWNER(me())) // announce
      .mockResolvedValueOnce(OWNER(me())); // initial WS connect
    let releaseReconnect!: (owner: ListenerOwner) => void;
    resolveMock.mockImplementation(() => new Promise<ListenerOwner>(r => (releaseReconnect = r))); // reconnect parks
    const presence = new BridgePresence();

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(true);
    await waitFor(() => wsConnections.length > 0 && httpRequests.some(u => u.startsWith('/event')));
    const eventsBefore = httpRequests.filter(u => u.startsWith('/event')).length;

    // WS drops -> the close handler must close the gate immediately. The
    // reconnect probe is parked, so nothing re-opens it: an emit in this window
    // must be refused by post(). (Delete `this.trusted = false` in the close
    // handler and this emit posts - the guard is then unproven.)
    sockets[0].close();
    await waitFor(() => typeof releaseReconnect === 'function');

    await presence.emitEvent({ type: 'message', role: 'assistant', text: 'SECRET' });
    expect(httpRequests.filter(u => u.startsWith('/event')).length).toBe(eventsBefore);

    await presence.stop();
  });

  it('a stale probe from a superseded generation never re-announces (BLOCKER 1: ABA)', async () => {
    // gen-1's announce probe parks; a full stop()+start() completes while it is
    // parked (repopulating config/startOpts); then gen-1 resolves. The
    // generation guard must make gen-1 a no-op: exactly one announce, one WS,
    // bound to the live generation - not a double-announce.
    let releaseGen1!: (owner: ListenerOwner) => void;
    resolveMock
      .mockImplementationOnce(() => new Promise<ListenerOwner>(r => (releaseGen1 = r))) // gen-1 announce parks
      .mockResolvedValue(OWNER(me())); // gen-2: trusted throughout
    const presence = new BridgePresence();

    const startP1 = presence.start({ workspacePath: '/tmp/ws' });
    await waitFor(() => typeof releaseGen1 === 'function');
    await presence.stop();
    const ok2 = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok2).toBe(true);
    await waitFor(() => wsConnections.length > 0);

    releaseGen1(OWNER(me())); // gen-1 resolves late - must be a no-op
    await new Promise(r => setTimeout(r, 50));

    await expect(startP1).resolves.toBe(false);
    expect(httpRequests.filter(u => u.startsWith('/announce')).length).toBe(1);
    expect(wsConnections.length).toBe(1);

    await presence.stop();
  });

  it('reconnects the command WS after a stop()+start() lands inside the connect probe (BLOCKER 1: wsConnectingGen)', async () => {
    // gen-1 announces, then parks in the WS connect probe (holding the in-flight
    // flag); a full stop()+start() completes; gen-2 must still connect its command
    // WS. Pre-fix (bare `wsConnecting` boolean not reset in stop()) gen-2's
    // connectCommandWs early-returns and nothing retries, so the session is
    // announced but has no inbound command channel - this waitFor times out.
    let releaseWsProbe!: (owner: ListenerOwner) => void;
    resolveMock
      .mockResolvedValueOnce(OWNER(me())) // gen-1 announce probe
      .mockImplementationOnce(() => new Promise<ListenerOwner>(r => (releaseWsProbe = r))) // gen-1 WS probe parks
      .mockResolvedValue(OWNER(me())); // gen-2: trusted throughout
    const presence = new BridgePresence();

    const ok1 = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok1).toBe(true);
    await waitFor(() => typeof releaseWsProbe === 'function');
    await presence.stop();
    const ok2 = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok2).toBe(true);

    await waitFor(() => wsConnections.length > 0); // the new generation's WS MUST connect
    releaseWsProbe(OWNER(me())); // stale gen-1 probe resolves - no-op
    await new Promise(r => setTimeout(r, 30));
    expect(wsConnections.length).toBe(1);

    await presence.stop();
  });

  it('a stale start() whose /announce POST returns after a stop()+start() does not re-publish (BLOCKER 2: post-announce gen re-check)', async () => {
    // gen-1's /announce POST is held past a full stop()+start(); when it finally
    // returns, the post-await generation re-check must bail. Deleting the
    // generation term there (leaving only stopped/config, which a restart has
    // repopulated) makes the stale start resolve true and desync instanceId.
    resolveMock.mockResolvedValue(OWNER(me()));
    holdAnnounce = true;
    const presence = new BridgePresence();

    const startP1 = presence.start({ workspacePath: '/tmp/ws' }); // gen-1 parks in the held /announce
    await waitFor(() => announceReleasers.length === 1);
    await presence.stop();
    holdAnnounce = false; // let the fresh start's announce through
    const ok2 = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok2).toBe(true);
    await waitFor(() => wsConnections.length > 0);

    announceReleasers[0](); // release gen-1's held /announce POST
    await expect(startP1).resolves.toBe(false); // gen-1 must bail on the generation mismatch
    expect(wsConnections.length).toBe(1);

    await presence.stop();
  });

  it('drops a queued /event whose generation was superseded by a stop()+start() (BLOCKER 2: queued-emit gen drop)', async () => {
    resolveMock.mockResolvedValue(OWNER(me()));
    const presence = new BridgePresence();

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(true);
    await waitFor(() => wsConnections.length > 0 && httpRequests.some(u => u.startsWith('/event')));

    // Hold /event responses so the queue stays occupied across the restart.
    holdEvent = true;
    void presence.emitEvent({ type: 'message', role: 'assistant', text: 'gen1-A' }); // task A: runs, posts, held
    await waitFor(() => eventReleasers.length === 1);
    const laterEmit = presence.emitEvent({ type: 'message', role: 'assistant', text: 'gen1-LATE' }); // task B: queued behind A

    // Restart while task B is queued (captured under gen-1, generation now moves).
    await presence.stop();
    const ok2 = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok2).toBe(true);
    await waitFor(() => wsConnections.length > 1); // gen-2 connected, gate open

    holdEvent = false;
    eventReleasers.forEach(r => r()); // release task A (and gen-2's held idle emit); task B now runs
    await laterEmit;
    await new Promise(r => setTimeout(r, 20));

    // task B was captured under gen-1; the generation moved, so it must be dropped,
    // never re-posted under gen-2's live+trusted gate. Deleting the generation term
    // in emitEvent lets 'gen1-LATE' ride out under the new generation.
    expect(eventBodies.some(b => b.includes('gen1-LATE'))).toBe(false);

    await presence.stop();
  });

  it('refuses a closed-gate emit silently after a benign bridge restart (nit: post() silent refusal)', async () => {
    // WS drops, then the reconnect probe finds no listener (benign) so the gate
    // stays closed. An emit in this window must be refused WITHOUT a security
    // warning - post()'s refusal is silent, and `no-listener` is not `foreign`.
    resolveMock
      .mockResolvedValueOnce(OWNER(me())) // announce
      .mockResolvedValueOnce(OWNER(me())) // initial WS connect
      .mockResolvedValue({ kind: 'no-listener' }); // reconnect: bridge simply gone
    const presence = new BridgePresence();

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(true);
    await waitFor(() => wsConnections.length > 0 && httpRequests.some(u => u.startsWith('/event')));
    const eventsBefore = httpRequests.filter(u => u.startsWith('/event')).length;

    sockets[0].close(); // WS drops -> gate closes; reconnect probe (no-listener) keeps it closed, quietly
    await waitFor(() => resolveMock.mock.calls.length >= 3);

    await presence.emitEvent({ type: 'message', role: 'assistant', text: 'x' });
    expect(httpRequests.filter(u => u.startsWith('/event')).length).toBe(eventsBefore); // refused
    expect(warn).not.toHaveBeenCalled(); // silent throughout

    await presence.stop();
  });
});
