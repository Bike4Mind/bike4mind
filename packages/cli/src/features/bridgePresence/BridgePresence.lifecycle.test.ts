// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ListenerOwner } from './peerOwner.js';

// The real-socket suite (BridgePresence.test.ts) cannot deterministically
// reproduce a *stale* command-WS close landing while a newer socket is live:
// stop() closes the old client synchronously, so its 'close' event races the
// new generation's connect. This file mocks `ws` with a fully controllable
// socket so a stale close can be fired at an exact instant - the only way to
// pin the WS-close identity guard (`if (this.ws !== ws) return`).
const { resolveMock, readFileMock, warn, debug, fetchMock } = vi.hoisted(() => ({
  resolveMock: vi.fn<(port: number) => Promise<ListenerOwner>>(),
  readFileMock: vi.fn<() => Promise<string>>(),
  warn: vi.fn(),
  debug: vi.fn(),
  fetchMock: vi.fn(),
}));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  handlers: Record<string, (...a: unknown[]) => void> = {};
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  on(ev: string, cb: (...a: unknown[]) => void): this {
    this.handlers[ev] = cb;
    return this;
  }
  close(): void {
    this.fire('close');
  }
  fire(ev: string, ...args: unknown[]): void {
    this.handlers[ev]?.(...args);
  }
}

vi.mock('ws', () => ({ default: FakeWebSocket, WebSocket: FakeWebSocket }));
vi.mock('./peerOwner.js', () => ({ resolveLoopbackListenerOwner: (port: number) => resolveMock(port) }));
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, promises: { ...actual.promises, readFile: () => readFileMock() } };
});
vi.mock('../../utils/Logger.js', () => ({ logger: { debug, info: vi.fn(), warn, error: vi.fn() } }));

const { BridgePresence } = await import('./BridgePresence.js');

const SECRET = 'test-hook-secret';
const me = (): number => process.getuid!();
const OWNER = (uid: number): ListenerOwner => ({ kind: 'owner', uid });
const eventUrls = (): number => fetchMock.mock.calls.filter(([u]) => String(u).includes('/event')).length;

function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (pred()) return resolve();
      if (Date.now() - started > ms) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('BridgePresence WS-close lifecycle (mocked ws)', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    resolveMock.mockReset();
    readFileMock.mockReset();
    warn.mockClear();
    debug.mockClear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);
    readFileMock.mockResolvedValue(JSON.stringify({ port: 48732, hookSecret: SECRET }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a stale socket close after a stop()+start() does not disturb the live socket (BLOCKER: identity guard)', async () => {
    resolveMock.mockResolvedValue(OWNER(me()));
    const p = new BridgePresence();

    await p.start({ workspacePath: '/tmp/ws' });
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const a = FakeWebSocket.instances[0]; // gen-1 socket; this.ws === A

    await p.stop(); // closes A (handled as the current socket during teardown)
    await p.start({ workspacePath: '/tmp/ws' });
    await waitFor(() => FakeWebSocket.instances.length === 2);
    await waitFor(() => eventUrls() >= 2); // gen-1 + gen-2 initial idle emits settled
    const eventsBefore = eventUrls();

    // Fire the STALE gen-1 socket's close while this.ws is gen-2's socket. The
    // identity guard must make it inert. Without the guard it nulls this.ws,
    // clears `trusted`, and schedules a reconnect on the live generation.
    a.fire('close');

    // trusted must be intact: this emit posts. (Mutant: post() refuses -> no /event.)
    await p.emitEvent({ type: 'status', status: 'idle' });
    expect(eventUrls()).toBe(eventsBefore + 1);

    // and no spurious reconnect socket was opened. (Mutant: a 3rd socket appears
    // after the reconnect backoff.)
    await new Promise(r => setTimeout(r, 700));
    expect(FakeWebSocket.instances.length).toBe(2);

    await p.stop();
  });

  it('the live socket close still triggers a reconnect (identity guard true branch)', async () => {
    resolveMock.mockResolvedValue(OWNER(me()));
    const p = new BridgePresence();

    await p.start({ workspacePath: '/tmp/ws' });
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const live = FakeWebSocket.instances[0];

    // The current socket dropping (peer/bridge restart) must reconnect.
    live.fire('close');
    await waitFor(() => FakeWebSocket.instances.length === 2, 3000);

    await p.stop();
  });
});
