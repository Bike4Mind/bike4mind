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
  static constructAttempts = 0;
  static throwOnConstruct = false;
  handlers: Record<string, (...a: unknown[]) => void> = {};
  url: string;
  constructor(url: string) {
    FakeWebSocket.constructAttempts += 1;
    if (FakeWebSocket.throwOnConstruct) throw new Error('construct boom');
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
vi.mock('./peerOwner.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./peerOwner.js')>();
  return { ...actual, resolveLoopbackListenerOwner: (port: number) => resolveMock(port) };
});
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
  const created: InstanceType<typeof BridgePresence>[] = [];
  const make = (): InstanceType<typeof BridgePresence> => {
    const p = new BridgePresence();
    created.push(p);
    return p;
  };

  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.constructAttempts = 0;
    FakeWebSocket.throwOnConstruct = false;
    created.length = 0;
    resolveMock.mockReset();
    readFileMock.mockReset();
    warn.mockClear();
    debug.mockClear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);
    readFileMock.mockResolvedValue(JSON.stringify({ port: 48732, hookSecret: SECRET }));
  });

  afterEach(async () => {
    // Stop every presence a test created (even one that threw before its own
    // stop()) so a case never leaks its 500ms reconnect timer into the next.
    for (const p of created) {
      try {
        await p.stop();
      } catch {
        /* already torn down */
      }
    }
    vi.unstubAllGlobals();
  });

  it('a stale socket close after a stop()+start() does not disturb the live socket (BLOCKER: identity guard)', async () => {
    resolveMock.mockResolvedValue(OWNER(me()));
    const p = make();

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
    const p = make();

    await p.start({ workspacePath: '/tmp/ws' });
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const live = FakeWebSocket.instances[0];

    // The current socket dropping (peer/bridge restart) must reconnect.
    live.fire('close');
    await waitFor(() => FakeWebSocket.instances.length === 2, 3000);

    await p.stop();
  });

  it('a frame from a stale socket is not dispatched into the new session (message identity guard)', async () => {
    resolveMock.mockResolvedValue(OWNER(me()));
    const onSendPrompt = vi.fn();
    const p = make();
    p.setCallbacks({ onSendPrompt });

    await p.start({ workspacePath: '/tmp/ws' });
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const stale = FakeWebSocket.instances[0]; // gen-1 socket

    await p.stop();
    await p.start({ workspacePath: '/tmp/ws' });
    await waitFor(() => FakeWebSocket.instances.length === 2); // gen-2 socket is now this.ws

    // A frame buffered on the stale gen-1 socket must NOT run against gen-2
    // (`dispatchCommand` only checks `stopped`, which the fresh start() cleared).
    stale.fire('message', Buffer.from(JSON.stringify({ command: { type: 'send_prompt', text: 'stale' } })));
    await new Promise(r => setTimeout(r, 30));
    expect(onSendPrompt).not.toHaveBeenCalled();

    // The live socket still dispatches, proving the guard is identity, not a global off-switch.
    FakeWebSocket.instances[1].fire(
      'message',
      Buffer.from(JSON.stringify({ command: { type: 'send_prompt', text: 'live' } }))
    );
    await waitFor(() => onSendPrompt.mock.calls.length > 0);
    expect(onSendPrompt).toHaveBeenCalledWith('live');

    await p.stop();
  });

  it("a stale generation's finally does not clear the live generation's in-flight latch (BLOCKER: :572 finally guard)", async () => {
    // Park gen-1's AND gen-2's command-WS trust probes. When gen-1's probe resolves,
    // its connectCommandWs bails on the generation check and its `finally` runs - the
    // identity guard (`this.wsConnectingGen === gen`) must NOT clear the latch, which
    // gen-2 now owns. Drop the guard (unconditional clear) and gen-1's finally frees
    // gen-2's latch, re-opening the connect entry guard for a second untracked socket.
    const deferred: Array<(o: ListenerOwner) => void> = [];
    resolveMock.mockImplementation(
      () =>
        new Promise<ListenerOwner>(resolve => {
          deferred.push(resolve);
        })
    );
    const p = make();

    // gen-1: release the announce probe, then let the WS probe park.
    void p.start({ workspacePath: '/tmp/ws' });
    await waitFor(() => deferred.length === 1); // gen-1 announce probe
    deferred[0](OWNER(me()));
    await waitFor(() => deferred.length === 2); // gen-1 WS probe now parked (holds the latch)

    // Supersede with gen-2: same dance; its WS probe parks and takes the latch.
    await p.stop();
    void p.start({ workspacePath: '/tmp/ws' });
    await waitFor(() => deferred.length === 3); // gen-2 announce probe
    deferred[2](OWNER(me()));
    await waitFor(() => deferred.length === 4); // gen-2 WS probe parked; latch is now gen-2's
    const latchBefore = p.__wsConnectingGenForTests;
    expect(latchBefore).not.toBeNull();

    // Release gen-1's WS probe: it bails (stale generation) and its finally runs.
    deferred[1](OWNER(me()));
    await new Promise(r => setTimeout(r, 30));

    // The live (gen-2) latch must be intact. Mutant: gen-1's finally cleared it to null.
    expect(p.__wsConnectingGenForTests).toBe(latchBefore);

    await p.stop();
  });

  it('command WS construct-throw closes the gate and arms a reconnect (nit: construct-throw path)', async () => {
    resolveMock.mockResolvedValue(OWNER(me()));
    FakeWebSocket.throwOnConstruct = true; // every `new WebSocket()` throws
    const p = make();

    await p.start({ workspacePath: '/tmp/ws' });
    await waitFor(() => FakeWebSocket.constructAttempts >= 1);
    await new Promise(r => setTimeout(r, 50)); // let the idle emit settle and the throw's trusted=false land

    // Gate closed: an emit in this window is refused (no /event carries the marker).
    // Mutant (drop `this.trusted = false` in the construct-catch): trusted stays open
    // from announce and this posts.
    await p.emitEvent({ type: 'message', role: 'assistant', text: 'AFTER-THROW' });
    await new Promise(r => setTimeout(r, 20));
    const posted = fetchMock.mock.calls.some(
      ([u, o]) => String(u).includes('/event') && String((o as RequestInit)?.body).includes('AFTER-THROW')
    );
    expect(posted).toBe(false);

    // Reconnect armed: a second construct is attempted after the 500ms backoff.
    await waitFor(() => FakeWebSocket.constructAttempts >= 2, 3000);

    FakeWebSocket.throwOnConstruct = false;
    await p.stop();
  });

  it('a frame arriving after stop() is not dispatched (stale-socket defense)', async () => {
    resolveMock.mockResolvedValue(OWNER(me()));
    const onSendPrompt = vi.fn();
    const p = make();
    p.setCallbacks({ onSendPrompt });

    await p.start({ workspacePath: '/tmp/ws' });
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const sock = FakeWebSocket.instances[0];

    await p.stop(); // stopped=true, this.ws nulled, socket closed
    // A late frame on the now-stale socket must not reach a callback: the message
    // identity guard drops it (this.ws is null), with dispatchCommand's stopped
    // check as the defense-in-depth behind it.
    sock.fire('message', Buffer.from(JSON.stringify({ command: { type: 'send_prompt', text: 'late' } })));
    await new Promise(r => setTimeout(r, 30));
    expect(onSendPrompt).not.toHaveBeenCalled();
  });
});
