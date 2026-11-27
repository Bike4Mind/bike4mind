import { describe, expect, it, vi } from 'vitest';
import {
  HOST_ERROR_CODES,
  HOST_PROTOCOL_VERSION,
  hostRequest,
  type HostNotification,
  type HostResponse,
} from '@shared/hostProtocol';
import { SessionEventLog } from '../../main/chat/SessionEventLog';
import { HostEventRelay } from './HostEventRelay';
import type { HostAccount, HostControl, HostFacts } from './hostControl';
import { HostServer, type HostServerRuntime } from './HostServer';

const facts: HostFacts = {
  hostId: '6f1c2a5e-8f0b-4a51-9d3e-0c7a2b4d9e11',
  hostName: 'devbox',
  hostVersion: '1.2.3',
  capabilities: ['queue'],
  platform: 'linux',
  homeDirectory: '/home/dev',
};

const signedIn: HostAccount = { userId: 'u1', environmentUrl: 'https://example.test' };

function fakeControl(withSignIn = true) {
  let account: HostAccount = null;
  const listeners = new Set<(account: HostAccount) => void>();
  const control: HostControl = {
    facts: vi.fn(async () => facts),
    account: () => account,
    ...(withSignIn
      ? {
          startSignIn: vi.fn(async () => ({
            verificationUrl: 'https://example.test/device?code=ABCD',
            userCode: 'ABCD',
            expiresAt: 1_900_000_000_000,
          })),
        }
      : {}),
    onAccountChanged: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const change = (next: HostAccount) => {
    account = next;
    for (const listener of listeners) listener(next);
  };
  return { control, change, listeners };
}

function serve(control?: HostControl) {
  const eventLog = new SessionEventLog({ epoch: 'epoch-1' });
  const runtime = {
    service: { eventsSince: () => ({ ok: true as const, events: [] }) },
    eventLog,
  } as unknown as HostServerRuntime;
  const server = new HostServer(runtime, new HostEventRelay(() => undefined), { warn: vi.fn() }, control);
  const received: HostNotification[] = [];
  const connection = server.connect(message => received.push(message));
  let id = 0;
  const call = (method: string, params?: unknown): Promise<HostResponse> =>
    connection.handle(hostRequest(++id, method, params));
  return { server, call, received };
}

const resultOf = (response: HostResponse) => {
  if (!('result' in response)) throw new Error(`expected a result, got ${JSON.stringify(response)}`);
  return response.result;
};
const errorOf = (response: HostResponse) => {
  if (!('error' in response)) throw new Error(`expected an error, got ${JSON.stringify(response)}`);
  return response.error;
};

const initialize = (major: number, minor: number) => ({
  clientId: 'client-1',
  clientName: 'Test',
  clientVersion: '0.0.1',
  protocol: { major, minor },
});

describe('host/* methods', () => {
  it('initializes a client of the same version with the host facts and no account', async () => {
    const { call } = serve(fakeControl().control);

    const result = resultOf(
      await call('host/initialize', initialize(HOST_PROTOCOL_VERSION.major, HOST_PROTOCOL_VERSION.minor))
    );

    expect(result).toEqual({ ...facts, protocol: HOST_PROTOCOL_VERSION, account: null });
  });

  it('agrees on the lower minor with an older-minor client', async () => {
    const { call } = serve(fakeControl().control);

    const result = resultOf(await call('host/initialize', initialize(HOST_PROTOCOL_VERSION.major, 0)));

    expect(result).toMatchObject({ protocol: { major: HOST_PROTOCOL_VERSION.major, minor: 0 } });
  });

  it('agrees on its own minor with a newer-minor client', async () => {
    const { call } = serve(fakeControl().control);

    const result = resultOf(await call('host/initialize', initialize(HOST_PROTOCOL_VERSION.major, 99)));

    expect(result).toMatchObject({ protocol: HOST_PROTOCOL_VERSION });
  });

  it.each([
    [HOST_PROTOCOL_VERSION.major + 1, 'host-too-old'],
    [HOST_PROTOCOL_VERSION.major - 1, 'client-too-old'],
  ])('refuses a client of major %i with protocolMismatch (%s)', async (major, reason) => {
    const { call } = serve(fakeControl().control);

    const error = errorOf(await call('host/initialize', initialize(major, 0)));

    expect(error).toMatchObject({
      code: HOST_ERROR_CODES.protocolMismatch,
      data: { reason, host: HOST_PROTOCOL_VERSION },
    });
  });

  it('reports the host facts, its own protocol version and the signed-in account in host/info', async () => {
    const { control, change } = fakeControl();
    const { call } = serve(control);
    change(signedIn);

    expect(resultOf(await call('host/info'))).toEqual({ ...facts, protocol: HOST_PROTOCOL_VERSION, account: signedIn });
  });

  it('starts sign-in through the port and reports the account in host/auth/status', async () => {
    const { control, change } = fakeControl();
    const { call } = serve(control);

    expect(resultOf(await call('host/auth/start'))).toEqual({
      verificationUrl: 'https://example.test/device?code=ABCD',
      userCode: 'ABCD',
      expiresAt: 1_900_000_000_000,
    });
    expect(resultOf(await call('host/auth/status'))).toEqual({ account: null });
    change(signedIn);
    expect(resultOf(await call('host/auth/status'))).toEqual({ account: signedIn });
  });

  it('refuses host/auth/start with capabilityUnavailable on a host that signs in through its own app', async () => {
    const { call } = serve(fakeControl(false).control);

    expect(errorOf(await call('host/auth/start'))).toMatchObject({
      code: HOST_ERROR_CODES.capabilityUnavailable,
      data: { capability: 'hostSignIn' },
    });
  });

  it('sends host/stateChanged once per change of account, and stops on dispose', async () => {
    const { control, change, listeners } = fakeControl();
    const { server, received } = serve(control);

    change(null);
    change(signedIn);
    change({ ...signedIn });
    change(null);

    expect(received).toEqual([
      expect.objectContaining({ method: 'host/stateChanged', params: { account: signedIn } }),
      expect.objectContaining({ method: 'host/stateChanged', params: { account: null } }),
    ]);
    server.dispose();
    expect(listeners.size).toBe(0);
  });

  it('sends host/stateChanged when the user or the environment changes', async () => {
    const { control, change } = fakeControl();
    const { received } = serve(control);
    const other = { userId: 'u2', environmentUrl: signedIn!.environmentUrl };
    const elsewhere = { userId: 'u1', environmentUrl: 'https://other.test' };

    change(signedIn);
    change(other);
    change({ ...other, environmentUrl: elsewhere.environmentUrl });
    change(elsewhere);

    expect(received.map(message => (message as { params: unknown }).params)).toEqual([
      { account: signedIn },
      { account: other },
      { account: { userId: 'u2', environmentUrl: elsewhere.environmentUrl } },
      { account: elsewhere },
    ]);
  });

  it('answers host/* with method not found when the server has no control port', async () => {
    const { call } = serve();

    for (const method of ['host/initialize', 'host/info', 'host/auth/start', 'host/auth/status']) {
      const params = method === 'host/initialize' ? initialize(1, 0) : undefined;
      expect(errorOf(await call(method, params)).code).toBe(HOST_ERROR_CODES.methodNotFound);
    }
  });
});
