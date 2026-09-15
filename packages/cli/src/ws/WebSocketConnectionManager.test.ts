import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `WebSocketConnectionManager` computes its `WS` constructor from
 * `typeof globalThis.WebSocket` at MODULE LOAD time (Node 22+ has a native global
 * WebSocket, so the `ws` npm package fallback is never hit in this test environment).
 * To intercept connections we stub the global BEFORE importing the module, then
 * `vi.resetModules()` + re-import fresh per test so each test's stub takes effect.
 */

vi.mock('../utils/Logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  url: string;
  protocols: string[];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.onclose?.();
  }

  /** Test helper: simulate the handshake succeeding. */
  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /**
   * Test helper: simulate a refused handshake (401, never opens). Per the WebSocket spec
   * (and the `ws` package), a failed handshake fires `error` before `close` - the production
   * code's `onerror` handler is what actually settles connect()'s promise (there is no
   * settling in `onclose` itself), so the fake must fire both to be realistic.
   */
  triggerFailedClose(): void {
    this.readyState = 3;
    this.onerror?.(new Event('error'));
    this.onclose?.();
  }

  /** Test helper: simulate an established connection dropping (idle timeout, network blip). */
  triggerDropClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

async function freshManager(...args: [string, () => Promise<string | null>, (() => Promise<boolean>)?]) {
  vi.resetModules();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  FakeWebSocket.instances = [];
  const { WebSocketConnectionManager } = await import('./WebSocketConnectionManager');
  return new WebSocketConnectionManager(...args);
}

/**
 * Start connecting and hand back the fake socket `new WS(...)` constructed. `connect()`
 * awaits the (async) token getter before constructing the socket, so at least one
 * microtask must be flushed before `FakeWebSocket.instances[0]` exists.
 */
async function startConnect(manager: { connect: () => Promise<void> }): Promise<{
  connectPromise: Promise<void>;
  ws: FakeWebSocket;
}> {
  const connectPromise = manager.connect().catch(() => {});
  await Promise.resolve();
  await Promise.resolve();
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  return { connectPromise, ws };
}

describe('WebSocketConnectionManager - verify-before-reconnect on a failed connect attempt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('calls verifySession when a connect ATTEMPT fails to open, and reconnects on true', async () => {
    const verifySession = vi.fn().mockResolvedValue(true);
    const manager = await freshManager('wss://x', async () => 'token', verifySession);

    const { connectPromise, ws } = await startConnect(manager);
    ws.triggerFailedClose(); // never opened - the auth-rejection signal
    await connectPromise;
    await Promise.resolve(); // let verifyThenReconnect's `await verifySession()` settle
    await Promise.resolve();

    expect(verifySession).toHaveBeenCalledTimes(1);
    // On true, a reconnect is scheduled (not revoked) - scheduleReconnect ran, so a new
    // attempt fires once the backoff timer elapses.
    expect(manager.isRevoked).toBe(false);
    const countBefore = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(countBefore);
  });

  it('stops reconnecting and fires onRevoked when verifySession returns false', async () => {
    const verifySession = vi.fn().mockResolvedValue(false);
    const manager = await freshManager('wss://x', async () => 'token', verifySession);
    const revokedHandler = vi.fn();
    manager.onRevoked(revokedHandler);

    const { connectPromise, ws } = await startConnect(manager);
    ws.triggerFailedClose();
    await connectPromise;
    await Promise.resolve();
    await Promise.resolve();

    expect(revokedHandler).toHaveBeenCalledTimes(1);
    expect(manager.isRevoked).toBe(true);

    // No further connect attempts happen even after the backoff window elapses.
    const countBefore = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances.length).toBe(countBefore);
  });

  it('treats a verifySession error as transient and keeps retrying (does not revoke)', async () => {
    const verifySession = vi.fn().mockRejectedValue(new Error('network down'));
    const manager = await freshManager('wss://x', async () => 'token', verifySession);
    const revokedHandler = vi.fn();
    manager.onRevoked(revokedHandler);

    const { connectPromise, ws } = await startConnect(manager);
    ws.triggerFailedClose();
    await connectPromise;
    await Promise.resolve();
    await Promise.resolve();

    expect(verifySession).toHaveBeenCalledTimes(1);
    expect(manager.isRevoked).toBe(false);
    expect(revokedHandler).not.toHaveBeenCalled();
  });

  it('does NOT call verifySession when an established connection drops (not a connect-attempt failure)', async () => {
    const verifySession = vi.fn().mockResolvedValue(true);
    const manager = await freshManager('wss://x', async () => 'token', verifySession);

    const { connectPromise, ws } = await startConnect(manager);
    ws.triggerOpen();
    await connectPromise;

    ws.triggerDropClose();
    await Promise.resolve();
    await Promise.resolve();

    expect(verifySession).not.toHaveBeenCalled();
  });

  it('preserves old always-retry behavior when no verifySession is provided', async () => {
    const manager = await freshManager('wss://x', async () => 'token');

    const { connectPromise, ws } = await startConnect(manager);
    ws.triggerFailedClose();
    await connectPromise;

    // Without a verifier, a failed attempt goes straight to scheduleReconnect (old behavior).
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    expect(manager.isRevoked).toBe(false);
  });

  it('disconnect() after a failed connect ATTEMPT stops the reconnect loop (no orphan)', async () => {
    // The orphan bug: connect() rejects, the caller falls back to SSE, but the failed
    // attempt already scheduled a reconnect - so the manager reconnects forever with no
    // owner. buildLlmBackend/headlessCommand now call disconnect() on that fallback; this
    // asserts disconnect() actually tears the loop down. No verifier -> a failed attempt
    // schedules a reconnect directly (the simplest path that arms the timer).
    const manager = await freshManager('wss://x', async () => 'token');

    const { connectPromise, ws } = await startConnect(manager);
    ws.triggerFailedClose();
    await connectPromise;

    manager.disconnect();

    const countBefore = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances.length).toBe(countBefore);
  });

  it('disconnect() stops a reconnect scheduled by verifySession()==true (production fallback path)', async () => {
    // Production wires a verifier. On a failed attempt it verifies, and a `true` result
    // schedules a reconnect. If the caller then falls back to SSE and disconnects, that
    // scheduled reconnect must not fire.
    const verifySession = vi.fn().mockResolvedValue(true);
    const manager = await freshManager('wss://x', async () => 'token', verifySession);

    const { connectPromise, ws } = await startConnect(manager);
    ws.triggerFailedClose();
    await connectPromise;
    await Promise.resolve(); // let verifyThenReconnect's `await verifySession()` settle
    await Promise.resolve();

    manager.disconnect();

    const countBefore = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances.length).toBe(countBefore);
  });

  it('single-flights verifySession so a burst of close events does not trigger multiple verifications', async () => {
    let resolveVerify: (v: boolean) => void = () => {};
    const verifySession = vi.fn(() => new Promise<boolean>(resolve => (resolveVerify = resolve)));
    const manager = await freshManager('wss://x', async () => 'token', verifySession);

    const { connectPromise, ws } = await startConnect(manager);
    ws.triggerFailedClose();
    ws.triggerFailedClose(); // duplicate close event, should not double-fire verification
    await connectPromise;
    await Promise.resolve();
    await Promise.resolve();

    expect(verifySession).toHaveBeenCalledTimes(1);
    resolveVerify(true);
  });
});
