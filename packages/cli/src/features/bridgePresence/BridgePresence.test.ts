import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { ListenerOwner } from './peerOwner.js';

// Hoisted so the vi.mock factories (themselves hoisted above imports) can
// reference these safely.
const { resolveMock, readFileMock, warn, debug } = vi.hoisted(() => ({
  resolveMock: vi.fn<(port: number) => Promise<ListenerOwner>>(),
  readFileMock: vi.fn<() => Promise<string>>(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

// Owner-lookup seam - the only pre-transmission trust signal. Stub it per test
// to model a trusted (same-UID) peer, a foreign owner, a not-yet-listening
// bridge, and an undeterminable owner, without touching a live socket.
vi.mock('./peerOwner.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./peerOwner.js')>();
  return {
    ...actual, // keep the real canResolveLoopbackOwner (platform capability predicate)
    resolveLoopbackListenerOwner: (port: number) => resolveMock(port),
  };
});

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
  logger: { debug, info: vi.fn(), warn, error: vi.fn() },
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
  // Per-test override of the /announce response status, shifted per request;
  // empty => 200. Lets a test drive a transient announce-POST failure + retry.
  let announceStatusQueue: number[];

  beforeEach(async () => {
    httpRequests = [];
    eventBodies = [];
    wsConnections = [];
    sockets = [];
    holdAnnounce = false;
    announceReleasers = [];
    holdEvent = false;
    eventReleasers = [];
    announceStatusQueue = [];
    resolveMock.mockReset();
    readFileMock.mockReset();
    warn.mockClear();
    debug.mockClear();

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
        const status = url.startsWith('/announce') && announceStatusQueue.length ? announceStatusQueue.shift()! : 200;
        res.writeHead(status, { 'Content-Type': 'application/json' });
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

  it('latches the retry loop off (no spin) on a platform without getuid (Windows)', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'getuid');
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
    try {
      const presence = new BridgePresence();
      const ok = await presence.start({ workspacePath: '/tmp/ws' });
      expect(ok).toBe(false);

      // Past the first announce-retry backoff (1s): the ownership check can never
      // pass here, so the loop must be latched off - no repeated "retrying" probes.
      await new Promise(r => setTimeout(r, 1200));
      const retryLogs = debug.mock.calls.filter(([m]) => typeof m === 'string' && m.includes('retrying'));
      expect(retryLogs).toEqual([]);
      expect(httpRequests).toEqual([]);
      expect(warn).not.toHaveBeenCalled();

      await presence.stop();
    } finally {
      if (original) Object.defineProperty(process, 'getuid', original);
    }
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

  it('does not POST /disconnect when stop() lands before the command WS opens (BLOCKER: no connect-verified peer)', async () => {
    // Announce passes the announce-time owner check, but the WS probe parks so no
    // command WS is ever established; stop() then lands. The announce `trusted`
    // latch is still open, yet no connect-time check ran, so /disconnect must NOT
    // be sent - it could disclose the secret to a port owner that flipped after
    // announce. Delete the `wsWasLive` gate in stop() and this /disconnect fires.
    let releaseWs!: (owner: ListenerOwner) => void;
    resolveMock
      .mockResolvedValueOnce(OWNER(me())) // announce: trusted
      .mockImplementationOnce(() => new Promise<ListenerOwner>(r => (releaseWs = r))); // WS probe parks
    const presence = new BridgePresence();

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(true);
    await waitFor(() => typeof releaseWs === 'function');
    await presence.stop();
    releaseWs(OWNER(me()));
    await new Promise(r => setTimeout(r, 30));

    expect(httpRequests.some(u => u.startsWith('/disconnect'))).toBe(false);
    expect(wsConnections).toEqual([]);
  });

  it('POSTs /disconnect for a trusted, connected session on stop() (BLOCKER: happy path not over-refused)', async () => {
    resolveMock.mockResolvedValue(OWNER(me()));
    const presence = new BridgePresence();

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(true);
    await waitFor(() => wsConnections.length > 0);

    await presence.stop();
    // A session whose command WS actually opened is connect-verified, so teardown
    // must still signal /disconnect with the secret. Delete the /disconnect block
    // and this fails - the gate would silently over-refuse a legitimate disconnect.
    expect(httpRequests.some(u => u.startsWith('/disconnect') && u.includes(`secret=${SECRET}`))).toBe(true);
  });

  it('fails closed and stays quiet when the owner probe throws unexpectedly (BLOCKER: resolver throw)', async () => {
    resolveMock.mockRejectedValue(new Error('boom'));
    const presence = new BridgePresence();

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(false);
    expect(httpRequests).toEqual([]);
    // An unexpected throw from the probe fails closed, logs at debug, and does NOT
    // fire the security warning. Delete the catch in checkPeerTrust and start()
    // rejects (an unhandled rejection) instead of resolving false quietly.
    expect(warn).not.toHaveBeenCalled();
    expect(debug.mock.calls.some(([m]) => typeof m === 'string' && m.includes('loopback owner lookup threw'))).toBe(
      true
    );

    await presence.stop();
  });

  it('a stale start() parked in readBridgeConfig across a stop()+start() does not re-announce (BLOCKER: post-config gen re-check)', async () => {
    resolveMock.mockResolvedValue(OWNER(me()));
    let releaseConfig!: () => void;
    // gen-1 parks in readBridgeConfig; the fresh start()'s read uses the
    // beforeEach default (already resolved).
    readFileMock.mockImplementationOnce(
      () => new Promise<string>(r => (releaseConfig = () => r(JSON.stringify({ port, hookSecret: SECRET }))))
    );
    const presence = new BridgePresence();

    const startP1 = presence.start({ workspacePath: '/tmp/ws' });
    await waitFor(() => typeof releaseConfig === 'function');
    await presence.stop();
    const ok2 = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok2).toBe(true);
    await waitFor(() => wsConnections.length > 0);

    releaseConfig(); // gen-1's config read resolves late - the gen re-check must bail
    await expect(startP1).resolves.toBe(false);
    expect(httpRequests.filter(u => u.startsWith('/announce')).length).toBe(1);

    await presence.stop();
  });

  // The WS-close identity guard is pinned deterministically in
  // BridgePresence.lifecycle.test.ts (mocked `ws`): against a real socket, stop()
  // closes the old client synchronously so a stale close cannot be interleaved
  // while a newer socket is live, which is why a real-socket attempt at it here
  // was vacuous (green with the guard mutated).

  it('latches the retry loop off (no spin) on a getuid platform without an owner probe (BSD/SunOS)', async () => {
    // getuid exists but the platform has no owner resolver (canResolveLoopbackOwner
    // is false), so the same-UID check can never pass. attemptAnnounce must latch off
    // rather than spin the announce-retry loop forever - the Windows latch,
    // generalized to the capability predicate rather than just `typeof getuid`.
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
    try {
      const presence = new BridgePresence();
      const ok = await presence.start({ workspacePath: '/tmp/ws' });
      expect(ok).toBe(false);

      await new Promise(r => setTimeout(r, 1200)); // past the first announce-retry backoff (1s)
      const retryLogs = debug.mock.calls.filter(([m]) => typeof m === 'string' && m.includes('retrying'));
      expect(retryLogs).toEqual([]);
      expect(resolveMock).not.toHaveBeenCalled(); // latched off before ever probing
      expect(httpRequests).toEqual([]);
      expect(warn).not.toHaveBeenCalled();

      await presence.stop();
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  });

  it('re-warns when the peer goes foreign again after a trusted reconnect (peerWarned reset)', async () => {
    // A trusted check resets peerWarned, so a later foreign owner warns again - the
    // latch suppresses repeats within one untrusted state, not across a recovery.
    // Delete `this.peerWarned = false` in checkPeerTrust and the second foreign owner
    // is silently swallowed.
    resolveMock
      .mockResolvedValueOnce(OWNER(me() + 1)) // announce probe: foreign -> warn #1
      .mockResolvedValueOnce(OWNER(me())) // announce retry: trusted -> announce (resets peerWarned)
      .mockResolvedValueOnce(OWNER(me())) // WS connect: trusted
      .mockResolvedValue(OWNER(me() + 1)); // reconnect after drop: foreign -> warn #2
    const presence = new BridgePresence();

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(false);
    await waitFor(() => warn.mock.calls.length === 1);

    // The announce retry brings the trusted session up.
    await waitFor(() => wsConnections.length > 0, 4000);

    // The bridge dies and a foreign owner takes the port: the reconnect probe must
    // warn again (peerWarned was reset by the intervening trusted check).
    sockets[0].close();
    await waitFor(() => warn.mock.calls.length === 2, 4000);
    expect(warn).toHaveBeenCalledTimes(2);

    await presence.stop();
  });

  it('dispatches resolve_permission and abort commands to their callbacks', async () => {
    resolveMock.mockResolvedValue(OWNER(me()));
    const onResolvePermission = vi.fn();
    const onAbort = vi.fn();
    const presence = new BridgePresence();
    presence.setCallbacks({ onResolvePermission, onAbort });

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(true);
    await waitFor(() => wsConnections.length > 0);

    sockets[0].send(
      JSON.stringify({ requestId: 'r1', command: { type: 'resolve_permission', requestId: 'p1', allow: true } })
    );
    sockets[0].send(JSON.stringify({ command: { type: 'abort' } }));
    await waitFor(() => onResolvePermission.mock.calls.length > 0 && onAbort.mock.calls.length > 0);
    expect(onResolvePermission).toHaveBeenCalledWith('p1', true);
    expect(onAbort).toHaveBeenCalledTimes(1);

    await presence.stop();
  });

  it('ignores malformed and command-less frames but still handles a valid one', async () => {
    resolveMock.mockResolvedValue(OWNER(me()));
    const onSendPrompt = vi.fn();
    const presence = new BridgePresence();
    presence.setCallbacks({ onSendPrompt });

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(true);
    await waitFor(() => wsConnections.length > 0);

    sockets[0].send('not json{'); // malformed -> parse catch, ignored
    sockets[0].send(JSON.stringify({ requestId: 'x' })); // no command field, ignored
    sockets[0].send(JSON.stringify({ command: { type: 'send_prompt', text: 'hi' } })); // valid
    await waitFor(() => onSendPrompt.mock.calls.length > 0);
    expect(onSendPrompt).toHaveBeenCalledTimes(1);
    expect(onSendPrompt).toHaveBeenCalledWith('hi');

    await presence.stop();
  });

  it('runs quietly without presence when cc-bridge is not configured', async () => {
    readFileMock.mockRejectedValue(new Error('ENOENT')); // no ~/.b4m/cc-bridge.json
    const presence = new BridgePresence();

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(false);
    expect(httpRequests).toEqual([]);
    expect(wsConnections).toEqual([]);
    expect(resolveMock).not.toHaveBeenCalled(); // no config -> never even probes the owner
    expect(warn).not.toHaveBeenCalled();

    await presence.stop();
  });

  it('retries the announce after a transient POST failure and recovers', async () => {
    resolveMock.mockResolvedValue(OWNER(me()));
    announceStatusQueue = [500]; // first /announce POST fails; the retry succeeds
    const presence = new BridgePresence();

    const ok = await presence.start({ workspacePath: '/tmp/ws' });
    expect(ok).toBe(false); // the first attempt's POST failed

    // The announce-retry (1s backoff) re-announces, now 200, and brings the sprite up.
    await waitFor(() => wsConnections.length > 0, 4000);
    expect(httpRequests.filter(u => u.startsWith('/announce')).length).toBeGreaterThanOrEqual(2);

    await presence.stop();
  });
});
