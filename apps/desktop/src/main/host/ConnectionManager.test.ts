import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostNotificationDelivery } from '@shared/hostBridge';
import type { HostAccount, HostConnectionState, HostKind } from '@shared/hostConnection';
import {
  HOST_ERROR_CODES,
  HOST_PROTOCOL_VERSION,
  HostRequestError,
  hostNotification,
  type HostConnectFailure,
  type HostConnectFailureKind,
} from '@shared/hostProtocol';
import { ACCOUNT, FakeHost, sessionEvent } from './__fixtures__/fakeHost';
import { ConnectionManager, LOCAL_HOST_ID, type HostClientEndpoint } from './ConnectionManager';
import type { HostLinkTuning } from './HostLink';

const CLIENT = { clientId: 'client-1', clientName: 'Desktop', clientVersion: '1.0.0' };
const TUNING: HostLinkTuning = {
  backoff: { baseMs: 1_000, capMs: 8_000 },
  offlineAfterAttempts: 3,
  stableAfterMs: 30_000,
  heartbeatMs: 30_000,
  requestTimeoutMs: 5_000,
  connectTimeoutMs: 10_000,
};

const failure = (kind: HostConnectFailureKind): HostConnectFailure => ({
  kind,
  detail: `${kind} happened`,
  stderrTail: '',
});

/** Lets every pending promise chain run, and any zero-delay timer with it. */
const settle = () => vi.advanceTimersByTimeAsync(0);

function fakeWindow(id: number) {
  const delivered: HostNotificationDelivery[] = [];
  let closed: (() => void) | undefined;
  let destroyed = false;
  const endpoint: HostClientEndpoint = {
    id,
    deliver: delivery => delivered.push(delivery),
    onClosed: listener => {
      closed = listener;
    },
    isClosed: () => destroyed,
  };
  const seqs = (sessionId: string) =>
    delivered.flatMap(({ notification }) => {
      if (notification.method !== 'session/event') return [];
      const params = notification.params as { sessionId: string; seq: number };
      return params.sessionId === sessionId ? [params.seq] : [];
    });
  const resyncs = () =>
    delivered
      .filter(({ notification }) => notification.method === 'session/resyncRequired')
      .map(d => d.notification.params);
  const destroy = () => {
    destroyed = true;
    closed?.();
  };
  return { endpoint, delivered, seqs, resyncs, destroy };
}

type SetUpOptions = {
  kind?: HostKind;
  account?: HostAccount;
  connect?: boolean;
  tuning?: Partial<HostLinkTuning>;
  /** Failures the first connects reject with; connect() runs as soon as the host is registered. */
  failures?: HostConnectFailure[];
  online?: boolean;
};

function setUp(options: SetUpOptions = {}) {
  const host = new FakeHost();
  host.connectFailures.push(...(options.failures ?? []));
  let account: HostAccount = options.account === undefined ? ACCOUNT : options.account;
  let online = options.online ?? true;
  const accountListeners = new Set<(account: HostAccount) => void>();
  const wakeListeners = new Set<() => void>();
  const onlineListeners = new Set<() => void>();
  const manager = new ConnectionManager({
    client: CLIENT,
    account: {
      current: () => account,
      onChanged: listener => {
        accountListeners.add(listener);
        return () => accountListeners.delete(listener);
      },
    },
    signals: {
      isOnline: () => online,
      onWake: listener => {
        wakeListeners.add(listener);
        return () => wakeListeners.delete(listener);
      },
      onOnline: listener => {
        onlineListeners.add(listener);
        return () => onlineListeners.delete(listener);
      },
    },
    tuning: { ...TUNING, ...options.tuning },
    // The top of the jitter range, so each wait is exactly the backoff ceiling.
    random: () => 1,
  });
  const history: HostConnectionState['status'][] = [];
  manager.onStateChanged(hosts => {
    const state = hosts.find(entry => entry.hostId === 'devbox')?.state;
    if (state && history.at(-1) !== state.status) history.push(state.status);
  });
  manager.register('devbox', host.connector, {
    label: 'devbox',
    kind: options.kind ?? 'remote',
    ...(options.connect === undefined ? {} : { connect: options.connect }),
  });
  const state = () => manager.list().find(entry => entry.hostId === 'devbox')?.state;
  return {
    host,
    manager,
    history,
    state,
    setAccount(next: HostAccount) {
      account = next;
      for (const listener of accountListeners) listener(next);
    },
    setOnline(next: boolean) {
      online = next;
      if (next) for (const listener of onlineListeners) listener();
    },
    wake: () => wakeListeners.forEach(listener => listener()),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ConnectionManager: connection states', () => {
  it('connects through the handshake and reports the host and a measured latency', async () => {
    const { state, host, manager, history } = setUp();
    expect(state()).toEqual({ status: 'connecting' });
    await settle();

    expect(state()).toMatchObject({
      status: 'connected',
      info: { hostId: 'devbox-id', account: ACCOUNT },
      latencyMs: 0,
    });
    expect(history).toEqual(['connecting', 'connected']);
    expect(host.connections[0].requests.map(request => request.method)).toEqual(['host/initialize', 'host/info']);
    expect(host.connections[0].requests[0].params).toEqual({ ...CLIENT, protocol: HOST_PROTOCOL_VERSION });
    expect(manager.list()).toEqual([{ hostId: 'devbox', label: 'devbox', kind: 'remote', state: state() }]);
  });

  it('connects the local host whether or not Desktop is signed in, with no account check', async () => {
    const { state, host } = setUp({ kind: 'local', account: null });
    host.account = { userId: 'someone-else', environmentUrl: 'https://elsewhere.test' };
    await settle();
    expect(state()).toMatchObject({ status: 'connected' });
  });

  it('waits for sign-in on a host with no account, then connects once it signs in', async () => {
    const { state, host } = setUp();
    host.account = null;
    await settle();
    expect(state()).toEqual({ status: 'needsSignIn' });

    host.setAccount(ACCOUNT);
    await settle();
    expect(state()).toMatchObject({ status: 'connected' });
  });

  it('refuses a host signed in to another account or environment', async () => {
    const { state, host } = setUp();
    const other = { userId: 'u1', environmentUrl: 'https://staging.example.test' };
    host.account = other;
    await settle();
    expect(state()).toEqual({ status: 'accountMismatch', hostAccount: other });
  });

  it.each<[HostConnectFailureKind, HostConnectionState]>([
    ['notInstalled', { status: 'needsInstall' }],
    ['daemonVersionMismatch', { status: 'needsUpdate', required: false }],
    ['protocolMismatch', { status: 'needsUpdate', required: true }],
    ['nodeMissing', { status: 'failed', failure: failure('nodeMissing') }],
    ['nodeTooOld', { status: 'failed', failure: failure('nodeTooOld') }],
    ['unsupportedPlatform', { status: 'failed', failure: failure('unsupportedPlatform') }],
  ])('turns a %s connect failure into a state that waits for the user', async (kind, expected) => {
    const { state, host } = setUp({ failures: [failure(kind)] });
    await settle();
    expect(state()).toEqual(expected);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(host.connections).toHaveLength(0);
  });

  it('asks for a host update when the host speaks an older protocol major', async () => {
    const { state, host } = setUp();
    host.protocol = { major: HOST_PROTOCOL_VERSION.major - 1, minor: 0 };
    await settle();
    expect(state()).toEqual({ status: 'needsUpdate', required: true });
    expect(host.open).toHaveLength(0);
  });

  it('fails with a Desktop update message when the host speaks a newer protocol major', async () => {
    const { state, host } = setUp();
    host.protocol = { major: HOST_PROTOCOL_VERSION.major + 1, minor: 0 };
    await settle();
    expect(state()).toMatchObject({
      status: 'failed',
      failure: { kind: 'protocolMismatch', detail: expect.stringContaining('Update Bike4Mind Desktop') },
    });
  });

  it('retries transient failures with capped exponential backoff, then shows the host offline', async () => {
    const { state, host } = setUp({ failures: Array.from({ length: 5 }, () => failure('sshFailed')) });
    await settle();
    expect(state()).toEqual({ status: 'reconnecting', attempt: 1, nextRetryAt: Date.now() + 1_000 });

    const attemptsAfter = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      return 5 - host.connectFailures.length;
    };
    expect(await attemptsAfter(999)).toBe(1);
    expect(await attemptsAfter(1)).toBe(2);
    expect(state()).toEqual({ status: 'reconnecting', attempt: 2, nextRetryAt: Date.now() + 2_000 });
    expect(await attemptsAfter(2_000)).toBe(3);
    expect(state()).toMatchObject({ status: 'reconnecting', attempt: 3 });
    expect(await attemptsAfter(4_000)).toBe(4);
    // Past offlineAfterAttempts the host shows as offline, and keeps retrying at the cap.
    expect(state()).toEqual({ status: 'offline', reason: 'unreachable', lastSeenAt: null });
    expect(await attemptsAfter(7_999)).toBe(4);
    expect(await attemptsAfter(1)).toBe(5);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(state()).toMatchObject({ status: 'connected' });
  });

  it('shows a remote host offline for want of network, keeps its backoff, and retries at once when it is back', async () => {
    const { state, host, setOnline } = setUp({
      online: false,
      failures: [failure('sshFailed'), failure('sshFailed'), failure('sshFailed')],
    });
    await settle();
    expect(state()).toEqual({ status: 'offline', reason: 'noNetwork', lastSeenAt: null });

    // A drop too short for the online poll to see still ends: the backoff keeps retrying.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.connectFailures).toHaveLength(1);
    expect(state()).toEqual({ status: 'offline', reason: 'noNetwork', lastSeenAt: null });

    host.connectFailures.length = 0;
    setOnline(true);
    await settle();
    expect(state()).toMatchObject({ status: 'connected' });
  });

  it('never shows the local host offline for want of network', async () => {
    const { state } = setUp({ kind: 'local', online: false, failures: [failure('lost')] });
    await settle();
    expect(state()).toMatchObject({ status: 'reconnecting', attempt: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state()).toMatchObject({ status: 'connected' });
  });

  it('starts the attempt count again on a disconnect and on a connect', async () => {
    const { state, host, manager } = setUp({
      failures: Array.from({ length: 4 }, () => failure('sshFailed')),
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(state()).toMatchObject({ status: 'reconnecting', attempt: 3 });

    manager.disconnect('devbox');
    manager.connect('devbox');
    await settle();
    expect(host.connectFailures).toHaveLength(0);
    expect(state()).toEqual({ status: 'reconnecting', attempt: 1, nextRetryAt: Date.now() + 1_000 });
  });

  it('counts a connector that does not answer in time as a failed attempt, and closes what it opens late', async () => {
    const { state, host, manager } = setUp({ connect: false, tuning: { connectTimeoutMs: 10_000 } });
    host.connectDelayMs = 15_000;
    manager.connect('devbox');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state()).toMatchObject({ status: 'reconnecting', attempt: 1 });

    host.connectDelayMs = 0;
    await vi.advanceTimersByTimeAsync(5_000);
    // The retry opened at once; the connection the timed-out attempt asked for opens later and is closed.
    expect(host.connections).toHaveLength(2);
    expect(host.connections[1]?.closedBy).toBe('client');
    expect(state()).toMatchObject({ status: 'connected' });
  });

  it("does not charge the connector's prepare step to the connect timeout", async () => {
    const { state, host, manager } = setUp({ connect: false, tuning: { connectTimeoutMs: 10_000 } });
    host.prepareDelayMs = 25_000;
    host.connectDelayMs = 5_000;
    manager.connect('devbox');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(state()).toEqual({ status: 'connecting' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state()).toMatchObject({ status: 'connected' });
    expect(host.connections).toHaveLength(1);
  });

  it('retries at once on wake instead of waiting out the backoff', async () => {
    const { state, wake } = setUp({
      tuning: { backoff: { baseMs: 60_000, capMs: 60_000 } },
      failures: [failure('daemonStartTimeout')],
    });
    await settle();
    expect(state()).toMatchObject({ status: 'reconnecting', attempt: 1 });

    wake();
    await settle();
    expect(state()).toMatchObject({ status: 'connected' });
  });

  it('abandons a connect stranded by sleep and starts a fresh one on wake', async () => {
    const { host, manager, state, wake } = setUp({ connect: false });
    host.connectDelayMs = 30_000;
    manager.connect('devbox');
    await settle();
    expect(state()).toMatchObject({ status: 'connecting' });

    host.connectDelayMs = 0;
    wake();
    await settle();
    expect(state()).toMatchObject({ status: 'connected' });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.connections).toHaveLength(2);
    expect(host.open).toHaveLength(1);
    expect(state()).toMatchObject({ status: 'connected' });
  });

  it('notices a host that stops answering its heartbeat, and one that closes the link', async () => {
    const { state, host } = setUp();
    await settle();
    host.silent = true;
    await vi.advanceTimersByTimeAsync(TUNING.heartbeatMs + TUNING.requestTimeoutMs);
    expect(state()).toMatchObject({ status: 'reconnecting', attempt: 1 });
    expect(host.connections[0].closedBy).toBe('client');

    host.silent = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state()).toMatchObject({ status: 'connected' });

    host.open[0].cut();
    expect(state()).toMatchObject({ status: 'reconnecting', attempt: 2 });
    expect(state()).toMatchObject({ nextRetryAt: Date.now() + 2_000 });
  });

  it('starts the attempt count again only once a connection has lasted', async () => {
    const { state, host } = setUp();
    await settle();
    host.open[0].cut();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state()).toMatchObject({ status: 'connected' });

    await vi.advanceTimersByTimeAsync(TUNING.stableAfterMs);
    host.open[0].cut();
    expect(state()).toMatchObject({ status: 'reconnecting', attempt: 1 });
  });

  it('disconnects on request and stays offline until connect, which skips the backoff', async () => {
    const { state, host, manager } = setUp();
    await settle();
    manager.disconnect('devbox');
    expect(state()).toEqual({ status: 'offline', reason: 'disconnected', lastSeenAt: Date.now() });
    expect(host.open).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(host.connections).toHaveLength(1);

    manager.connect('devbox');
    expect(state()).toEqual({ status: 'connecting' });
    await settle();
    expect(state()).toMatchObject({ status: 'connected' });
  });

  it('registers a host without connecting when asked to', async () => {
    const { state, host } = setUp({ connect: false });
    await settle();
    expect(state()).toEqual({ status: 'offline', reason: 'disconnected', lastSeenAt: null });
    expect(host.connections).toHaveLength(0);
  });

  it('disconnects remote hosts on sign-out and reconnects them on sign-in, leaving the local host alone', async () => {
    const { state, host, manager, setAccount } = setUp();
    const local = new FakeHost();
    manager.register(LOCAL_HOST_ID, local.connector, { label: 'This computer', kind: 'local' });
    await settle();

    setAccount(null);
    expect(state()).toEqual({ status: 'offline', reason: 'signedOut', lastSeenAt: Date.now() });
    expect(host.open).toHaveLength(0);
    expect(manager.list().find(entry => entry.hostId === LOCAL_HOST_ID)?.state).toMatchObject({ status: 'connected' });
    expect(local.open).toHaveLength(1);

    setAccount(ACCOUNT);
    await settle();
    expect(state()).toMatchObject({ status: 'connected' });
  });

  it('checks the account again after an environment switch', async () => {
    const { state, host, setAccount } = setUp();
    await settle();

    setAccount({ userId: 'u1', environmentUrl: 'https://staging.example.test' });
    expect(host.connections[0].closedBy).toBe('client');
    await settle();
    expect(state()).toEqual({ status: 'accountMismatch', hostAccount: ACCOUNT });
  });

  it('removes a remote host, closing its connections, but never the local host', async () => {
    const { host, manager } = setUp();
    const states: string[][] = [];
    manager.onStateChanged(hosts => states.push(hosts.map(entry => entry.hostId)));
    manager.register(LOCAL_HOST_ID, new FakeHost().connector, { label: 'This computer', kind: 'local' });
    await settle();

    manager.remove('devbox');
    expect(manager.list().map(entry => entry.hostId)).toEqual([LOCAL_HOST_ID]);
    expect(states.at(-1)).toEqual([LOCAL_HOST_ID]);
    expect(host.open).toHaveLength(0);
    expect(() => manager.remove(LOCAL_HOST_ID)).toThrow('cannot be removed');
    expect(() => manager.disconnect(LOCAL_HOST_ID)).toThrow('cannot be disconnected');
    expect(() => manager.connect('devbox')).toThrow('not registered');
    expect(() => manager.register(LOCAL_HOST_ID, new FakeHost().connector, { label: 'x', kind: 'local' })).toThrow(
      'already registered'
    );
  });
});

describe('ConnectionManager: requests', () => {
  it.each([['session/explode'], ['host:request'], [42], [undefined]])(
    'rejects %s, which is not a host method, without opening a connection',
    async method => {
      const { manager, host } = setUp();
      await settle();
      const response = await manager.request(fakeWindow(1).endpoint, 'devbox', method, {});
      expect(response).toMatchObject({ ok: false, error: { code: HOST_ERROR_CODES.methodNotFound } });
      expect(host.connections).toHaveLength(1);
    }
  );

  it('rejects invalid params and an unknown host before dispatch', async () => {
    const { manager, host } = setUp();
    await settle();
    const window = fakeWindow(1).endpoint;
    await expect(manager.request(window, 'devbox', 'session/get', { sessionId: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: HOST_ERROR_CODES.invalidParams },
    });
    await expect(manager.request(window, 'nowhere', 'session/list', undefined)).resolves.toMatchObject({
      ok: false,
      error: { code: HOST_ERROR_CODES.invalidParams },
    });
    expect(host.connections).toHaveLength(1);
  });

  it('fails fast with capabilityUnavailable when the host is not connected', async () => {
    const { manager, host } = setUp({ failures: [failure('notInstalled')] });
    await settle();
    await expect(manager.request(fakeWindow(1).endpoint, 'devbox', 'session/list', undefined)).resolves.toEqual({
      ok: false,
      error: {
        code: HOST_ERROR_CODES.capabilityUnavailable,
        message: 'Host devbox is not connected (needsInstall)',
        data: { state: 'needsInstall' },
      },
    });
    expect(host.connections).toHaveLength(0);
  });

  it('lets the host/* methods through to a host that waits for sign-in, and nothing else', async () => {
    const { manager, host } = setUp();
    host.account = null;
    await settle();
    const window = fakeWindow(1).endpoint;
    await expect(manager.request(window, 'devbox', 'host/auth/status', undefined)).resolves.toMatchObject({ ok: true });
    await expect(manager.request(window, 'devbox', 'session/list', undefined)).resolves.toMatchObject({
      ok: false,
      error: { code: HOST_ERROR_CODES.capabilityUnavailable },
    });
  });

  it('closes window connections while the host is on another account, and resumes them once it matches', async () => {
    const { manager, host, state } = setUp();
    await settle();
    const window = fakeWindow(1);
    await manager.request(window.endpoint, 'devbox', 'session/subscribe', { sessionId: 's1' });
    host.emit('s1');
    const before = window.delivered.length;

    host.setAccount({ userId: 'u2', environmentUrl: ACCOUNT.environmentUrl });
    await settle();
    expect(state()).toMatchObject({ status: 'accountMismatch' });
    host.emit('s1');
    for (const connection of host.open)
      connection.push(hostNotification('session/summaryChanged', { summary: { id: 's1' } }));
    expect(window.delivered.slice(before).map(d => d.notification.method)).not.toContain('session/event');
    expect(window.delivered.slice(before).map(d => d.notification.method)).not.toContain('session/summaryChanged');

    // host/* still reaches the host, over the control connection rather than a new window one.
    const open = host.open.length;
    await expect(manager.request(window.endpoint, 'devbox', 'host/auth/status', undefined)).resolves.toMatchObject({
      ok: true,
    });
    expect(host.open).toHaveLength(open);

    host.setAccount(ACCOUNT);
    await settle();
    expect(state()).toMatchObject({ status: 'connected' });
    expect(window.seqs('s1')).toEqual([1, 2]);
  });

  it('holds a request made while the host first connects until the handshake settles', async () => {
    const { manager } = setUp();
    const response = manager.request(fakeWindow(1).endpoint, 'devbox', 'session/list', undefined);
    await settle();
    await expect(response).resolves.toEqual({ ok: true, result: {} });
  });

  it('opens no connection for a window destroyed while its request waited for the handshake', async () => {
    const { manager, host } = setUp();
    const window = fakeWindow(1);
    const response = manager.request(window.endpoint, 'devbox', 'session/list', undefined);
    window.destroy();
    await settle();

    await expect(response).resolves.toMatchObject({ ok: false, error: { code: HOST_ERROR_CODES.internalError } });
    expect(host.connections).toHaveLength(1);
  });

  it('opens one handshaken connection per window, and returns results and host errors as data', async () => {
    const { manager, host } = setUp();
    host.handle = method => {
      if (method === 'session/get')
        throw new HostRequestError({ code: HOST_ERROR_CODES.sessionNotFound, message: 'gone' });
      return { sessions: [] };
    };
    await settle();
    const first = fakeWindow(1).endpoint;
    const second = fakeWindow(2).endpoint;

    await expect(manager.request(first, 'devbox', 'session/list', undefined)).resolves.toEqual({
      ok: true,
      result: { sessions: [] },
    });
    await manager.request(first, 'devbox', 'session/statuses', undefined);
    await expect(manager.request(second, 'devbox', 'session/get', { sessionId: 's1' })).resolves.toEqual({
      ok: false,
      error: { code: HOST_ERROR_CODES.sessionNotFound, message: 'gone' },
    });

    expect(host.connections).toHaveLength(3);
    expect(host.connections[1].requests.map(request => request.method)).toEqual([
      'host/initialize',
      'session/list',
      'session/statuses',
    ]);
  });

  it('answers a host method that throws something else with an internal error', async () => {
    const { manager, host } = setUp();
    host.handle = () => {
      throw new Error('boom');
    };
    await settle();
    await expect(manager.request(fakeWindow(1).endpoint, 'devbox', 'session/list', undefined)).resolves.toEqual({
      ok: false,
      error: { code: HOST_ERROR_CODES.internalError, message: 'boom' },
    });
  });

  it('answers a request cut off mid-flight with capabilityUnavailable, and serves the next one', async () => {
    const { manager, host } = setUp();
    await settle();
    const window = fakeWindow(1).endpoint;
    await manager.request(window, 'devbox', 'session/list', undefined);
    host.handle = method => (method === 'turn/stop' ? new Promise(() => undefined) : {});

    const cutOff = manager.request(window, 'devbox', 'turn/stop', { sessionId: 's1' });
    await settle();
    host.connections[1].cut();
    await expect(cutOff).resolves.toMatchObject({ ok: false, error: { code: HOST_ERROR_CODES.capabilityUnavailable } });

    // The cut counts against the link, so the host is back after its backoff.
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(manager.request(window, 'devbox', 'session/list', undefined)).resolves.toEqual({
      ok: true,
      result: {},
    });
  });

  it('delivers a connection notifications to its own window, tagged with the host', async () => {
    const { manager, host } = setUp();
    await settle();
    const first = fakeWindow(1);
    const second = fakeWindow(2);
    await manager.request(first.endpoint, 'devbox', 'session/list', undefined);
    await manager.request(second.endpoint, 'devbox', 'session/list', undefined);

    const notification = hostNotification('session/summaryChanged', { summary: { id: 's1' } });
    host.connections[1].push(notification);

    expect(first.delivered).toEqual([{ hostId: 'devbox', notification }]);
    expect(second.delivered).toEqual([]);
  });

  it('tracks answered subscribes and unsubscribes, but not failed ones', async () => {
    const { manager } = setUp();
    await settle();
    const window = fakeWindow(1).endpoint;

    await manager.request(window, 'devbox', 'session/subscribe', { sessionId: 's1' });
    await manager.request(window, 'devbox', 'session/subscribe', { sessionId: 's2' });
    await manager.request(window, 'devbox', 'session/subscribe', { sessionId: 'stale', after: { epoch: 'x', seq: 1 } });
    await manager.request(window, 'devbox', 'session/unsubscribe', { sessionId: 's1' });

    expect([...manager.subscriptions(1, 'devbox')]).toEqual(['s2']);
  });

  it('closes a destroyed window connections and drops its subscriptions, leaving other windows alone', async () => {
    const { manager, host } = setUp();
    await settle();
    const first = fakeWindow(1);
    const second = fakeWindow(2);
    await manager.request(first.endpoint, 'devbox', 'session/subscribe', { sessionId: 's1' });
    await manager.request(second.endpoint, 'devbox', 'session/subscribe', { sessionId: 's1' });

    first.destroy();

    expect(host.connections[1].closedBy).toBe('client');
    expect(host.connections[2].closedBy).toBeNull();
    expect(manager.subscriptions(1, 'devbox').size).toBe(0);
    expect([...manager.subscriptions(2, 'devbox')]).toEqual(['s1']);
  });
});

describe('ConnectionManager: resuming across a cut', () => {
  async function subscribedWindow() {
    const setup = setUp();
    await settle();
    const window = fakeWindow(1);
    await setup.manager.request(window.endpoint, 'devbox', 'session/subscribe', { sessionId: 's1' });
    setup.host.emit('s1');
    setup.host.emit('s1');
    expect(window.seqs('s1')).toEqual([1, 2]);
    return { ...setup, window, windowConnection: () => setup.host.open[1] };
  }

  it('loses and repeats no event when the window connection is cut and resumed', async () => {
    const { host, window, manager } = await subscribedWindow();
    const cut = host.open[1];
    cut.cut();
    host.emit('s1');
    host.emit('s1');
    // The cut counts against the link, so the window reopens after its backoff.
    await vi.advanceTimersByTimeAsync(1_000);

    expect(host.open[1].requests.at(-1)).toEqual({
      method: 'session/subscribe',
      params: { sessionId: 's1', after: { epoch: 'epoch-1', seq: 2 } },
    });
    host.emit('s1');
    // A notification the old connection had buffered, delivered after its close, is not delivered.
    cut.pushLate(sessionEvent('s1', 6));
    expect(window.seqs('s1')).toEqual([1, 2, 3, 4, 5]);
    host.emit('s1');
    expect(window.seqs('s1')).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...manager.subscriptions(1, 'devbox')]).toEqual(['s1']);
  });

  it('loses and repeats no event when the resubscribe answer overtakes the replay', async () => {
    const { host, window } = await subscribedWindow();
    host.answerBeforeReplay = true;
    host.open[1].cut();
    host.emit('s1');
    // Past the backoff, and the replay the answer overtook.
    await vi.advanceTimersByTimeAsync(1_010);
    host.emit('s1');
    await settle();
    expect(window.seqs('s1')).toEqual([1, 2, 3, 4]);
  });

  it('drops a replayed event the window already has', async () => {
    const { host, window } = await subscribedWindow();
    host.open[1].push(sessionEvent('s1', 2));
    host.open[1].push(sessionEvent('s1', 1));
    host.emit('s1');
    expect(window.seqs('s1')).toEqual([1, 2, 3]);
  });

  it('resumes windows once a host that dropped entirely is connected again', async () => {
    const { host, window, state } = await subscribedWindow();
    for (const connection of host.open) connection.cut();
    expect(state()).toMatchObject({ status: 'reconnecting' });
    host.emit('s1');
    expect(host.open).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(state()).toMatchObject({ status: 'connected' });
    host.emit('s1');
    expect(window.seqs('s1')).toEqual([1, 2, 3, 4]);
  });

  it('closes window connections while disconnected and resumes them on connect', async () => {
    const { host, window, manager } = await subscribedWindow();
    manager.disconnect('devbox');
    expect(host.open).toHaveLength(0);
    host.emit('s1');

    manager.connect('devbox');
    await settle();
    host.emit('s1');
    expect(window.seqs('s1')).toEqual([1, 2, 3, 4]);
  });

  it('asks the window to read the session again when the host cannot replay', async () => {
    const { host, window, manager } = await subscribedWindow();
    host.restart();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(window.resyncs()).toEqual([{ sessionId: 's1' }]);
    expect(manager.subscriptions(1, 'devbox').size).toBe(0);
    host.emit('s1');
    expect(window.seqs('s1')).toEqual([1, 2]);
  });

  it('forgets a session whose unsubscribe is cut mid-flight, so the resume does not subscribe it again', async () => {
    const { host, window, manager } = await subscribedWindow();
    host.unanswered.add('session/unsubscribe');
    const unsubscribe = manager.request(window.endpoint, 'devbox', 'session/unsubscribe', { sessionId: 's1' });
    await settle();
    host.open[1].cut();
    await expect(unsubscribe).resolves.toMatchObject({ ok: false });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(host.open).toHaveLength(2);
    expect(host.open[1].requests.map(request => request.method)).not.toContain('session/subscribe');
    expect(manager.subscriptions(1, 'devbox').size).toBe(0);
    host.emit('s1');
    expect(window.seqs('s1')).toEqual([1, 2]);
  });

  it('keeps a session to resume when a cut rejects its resubscribe before the close is reported', async () => {
    const { host, window, manager } = await subscribedWindow();
    host.unanswered.add('session/subscribe');
    host.open[1].cut();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.open[1].requests.at(-1)?.method).toBe('session/subscribe');

    host.closeListenersLate = true;
    host.open[1].cut();
    await settle();
    expect(window.resyncs()).toEqual([]);

    host.closeListenersLate = false;
    host.unanswered.clear();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.open[1].requests.at(-1)).toEqual({
      method: 'session/subscribe',
      params: { sessionId: 's1', after: { epoch: 'epoch-1', seq: 2 } },
    });
    expect([...manager.subscriptions(1, 'devbox')]).toEqual(['s1']);
  });

  it('treats a window connection the host cuts as a lost link, reopening only after the backoff', async () => {
    const { host, state, window } = await subscribedWindow();
    host.open[1].cut();
    await settle();
    expect(state()).toMatchObject({ status: 'reconnecting', attempt: 1 });
    expect(host.open).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(999);
    expect(host.open).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.open).toHaveLength(2);
    host.emit('s1');
    expect(window.seqs('s1')).toEqual([1, 2, 3]);
  });

  it('treats a window connection that cannot reopen as a lost link', async () => {
    const { host, state, window, manager } = await subscribedWindow();
    manager.disconnect('devbox');
    manager.connect('devbox');
    host.connectFailures.push(failure('sshFailed'));
    // The control connection has already opened, so the failure is the window's reopen.
    await settle();
    expect(state()).toMatchObject({ status: 'reconnecting', attempt: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state()).toMatchObject({ status: 'connected' });
    host.emit('s1');
    expect(window.seqs('s1')).toEqual([1, 2, 3]);
  });

  it('keeps its subscriptions when it is suspended while it reopens', async () => {
    const { host, window, manager } = await subscribedWindow();
    manager.disconnect('devbox');
    manager.connect('devbox');
    host.connectDelayMs = 100;
    await vi.advanceTimersByTimeAsync(100);
    // The control connection is up and the window's reopen is under way; cut everything now.
    manager.disconnect('devbox');
    await vi.advanceTimersByTimeAsync(100);
    expect(host.open).toHaveLength(0);
    expect(window.resyncs()).toEqual([]);

    host.connectDelayMs = 0;
    manager.connect('devbox');
    await settle();
    host.emit('s1');
    expect(window.seqs('s1')).toEqual([1, 2, 3]);
    expect([...manager.subscriptions(1, 'devbox')]).toEqual(['s1']);
  });
});

describe('user actions and saved state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tells a registrant about connect, disconnect and remove, and never about register or unregister', async () => {
    const manager = new ConnectionManager({
      client: CLIENT,
      account: { current: () => ACCOUNT, onChanged: () => () => undefined },
      tuning: TUNING,
    });
    const actions: string[] = [];
    const register = (hostId: string) =>
      manager.register(hostId, new FakeHost().connector, {
        label: hostId,
        kind: 'remote',
        onUserAction: action => actions.push(`${hostId}:${action}`),
      });
    register('a');
    register('b');
    await settle();

    manager.disconnect('a');
    manager.connect('a');
    manager.remove('a');
    manager.unregister('b');

    expect(actions).toEqual(['a:disconnect', 'a:connect', 'a:remove']);
  });

  it('reports a saved last-seen time while a host has not been reached in this run', () => {
    const manager = new ConnectionManager({
      client: CLIENT,
      account: { current: () => ACCOUNT, onChanged: () => () => undefined },
      tuning: TUNING,
    });
    manager.register('a', new FakeHost().connector, { label: 'a', kind: 'remote', connect: false, lastSeenAt: 42 });
    expect(manager.list()[0].state).toEqual({ status: 'offline', reason: 'disconnected', lastSeenAt: 42 });
  });
});
