import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@shared/auth';
import { HOST_ERROR_CODES, hostRequest, type HostNotification, type HostResponse } from '@shared/hostProtocol';
import { HostEventRelay, HostServer, type HostServerRuntime } from '../../host/server';
import { localHostControl } from './localHostControl';

function serve(control: ReturnType<typeof localHostControl>) {
  const runtime = {
    service: { eventsSince: () => ({ ok: true as const, events: [] }) },
    eventLog: { cursor: () => ({ epoch: 'e', seq: 0 }) },
  } as unknown as HostServerRuntime;
  const server = new HostServer(runtime, new HostEventRelay(() => undefined), { warn: vi.fn() }, control);
  const received: HostNotification[] = [];
  const connection = server.connect(message => received.push(message));
  let id = 0;
  const call = (method: string, params?: unknown): Promise<HostResponse> =>
    connection.handle(hostRequest(++id, method, params));
  return { call, received };
}

const resultOf = (response: HostResponse) => {
  if (!('result' in response)) throw new Error(`expected a result, got ${JSON.stringify(response)}`);
  return response.result;
};
const errorOf = (response: HostResponse) => {
  if (!('error' in response)) throw new Error(`expected an error, got ${JSON.stringify(response)}`);
  return response.error;
};

describe('Desktop as the local host', () => {
  const state = (signedInAs: string | null): AuthState =>
    ({
      status: signedInAs ? 'signed-in' : 'signed-out',
      user: signedInAs ? { id: signedInAs } : undefined,
      environment: { preset: 'hosted', url: 'https://example.test', label: 'Test' },
      hostedAvailable: true,
      storage: 'available',
      busy: 'idle',
    }) as AuthState;

  async function desktopServer() {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'b4m-local-host-'));
    let current = state('u1');
    const listeners = new Set<(next: AuthState) => void>();
    const control = localHostControl({
      auth: { getState: () => current },
      onAuthStateChanged: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dataDirectory,
      homeDirectory: '/Users/dev',
      version: '9.9.9',
    });
    const set = (next: AuthState) => {
      current = next;
      for (const listener of listeners) listener(next);
    };
    return { ...serve(control), set };
  }

  it('reports its account and every known capability, and keeps the same host id', async () => {
    const { call } = await desktopServer();

    const first = resultOf(await call('host/info'));
    const second = resultOf(await call('host/info'));

    expect(first).toMatchObject({
      hostVersion: '9.9.9',
      homeDirectory: '/Users/dev',
      account: { userId: 'u1', environmentUrl: 'https://example.test' },
      capabilities: expect.arrayContaining(['queue', 'terminals', 'browserTools']),
    });
    expect(second).toEqual(first);
    expect(resultOf(await call('host/auth/status'))).toEqual({
      account: { userId: 'u1', environmentUrl: 'https://example.test' },
    });
  });

  it('refuses host/auth/start and pushes host/stateChanged on sign-out', async () => {
    const { call, received, set } = await desktopServer();

    expect(errorOf(await call('host/auth/start')).code).toBe(HOST_ERROR_CODES.capabilityUnavailable);
    set(state(null));

    expect(received).toEqual([expect.objectContaining({ method: 'host/stateChanged', params: { account: null } })]);
  });
});
