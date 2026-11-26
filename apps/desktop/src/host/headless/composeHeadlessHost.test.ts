import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthenticatedApiClient,
  DeviceFlowClient,
  DeviceFlowResponse,
  TokenResponse,
} from '@bike4mind/client-auth';
import { HOST_PROTOCOL_VERSION, type HostNotification, type HostResponse } from '@shared/hostProtocol';
import { composeHeadlessHost, HEADLESS_HOST_CAPABILITIES, type HeadlessHost } from './composeHeadlessHost';

// Any import of electron, direct or transitive, fails the suite: the host runs without it.
vi.mock('electron', () => {
  throw new Error('the headless host loaded electron');
});

const POSIX = process.platform !== 'win32';

function fakeAccessToken(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ id: userId }), 'utf8').toString('base64url');
  return `header.${payload}.signature`;
}

const grant: TokenResponse = {
  access_token: fakeAccessToken('user-1'),
  refresh_token: 'refresh-1',
  token_type: 'Bearer',
  expires_in: 1800,
};

const deviceFlowResponse: DeviceFlowResponse = {
  device_code: 'device-code',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://b4m.example.com/activate',
  verification_uri_complete: 'https://b4m.example.com/activate?code=WDJB-MJHT',
  expires_in: 600,
  interval: 5,
};

const hosts: HeadlessHost[] = [];
const roots: string[] = [];

// The build bakes the default server in the same way (see vite.host.config.ts).
beforeEach(() => {
  vi.stubEnv('B4M_DEFAULT_API_URL', 'https://b4m.example.com');
});

afterEach(async () => {
  for (const host of hosts.splice(0)) host.dispose();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function compose(dataDirectory: string) {
  const deviceFlow = {
    initiateDeviceFlow: vi.fn().mockResolvedValue(deviceFlowResponse),
    waitForAuthorization: vi.fn().mockResolvedValue(grant),
    refreshToken: vi.fn(),
  };
  const get = vi.fn().mockResolvedValue({ user: { id: 'user-1', email: 'rider@example.com' } });
  const host = await composeHeadlessHost({
    dataDirectory,
    homeDirectory: join(dirname(dataDirectory), 'home'),
    version: '9.9.9-test',
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    auth: {
      createDeviceFlowClient: () => deviceFlow as unknown as DeviceFlowClient,
      createApiClient: () => ({ get }) as unknown as AuthenticatedApiClient,
    },
  });
  hosts.push(host);
  return host;
}

function client(host: HeadlessHost) {
  const notifications: HostNotification[] = [];
  const connection = host.server.connect(notification => notifications.push(notification));
  let nextId = 1;
  const call = async (method: string, params?: unknown): Promise<HostResponse> =>
    connection.handle({ jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) });
  return { call, notifications, close: () => connection.close() };
}

async function dataDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'headless-host-compose-'));
  roots.push(root);
  return join(root, 'host');
}

describe('composeHeadlessHost', () => {
  it('serves the host protocol without Electron and reports what it offers', async () => {
    const directory = await dataDirectory();
    const host = await compose(directory);
    const { call } = client(host);

    const initialized = await call('host/initialize', {
      clientId: 'test',
      clientName: 'test',
      clientVersion: '1',
      protocol: HOST_PROTOCOL_VERSION,
    });
    expect(initialized).toMatchObject({
      result: {
        hostId: host.hostId,
        hostVersion: '9.9.9-test',
        capabilities: [...HEADLESS_HOST_CAPABILITIES],
        platform: process.platform,
        account: null,
      },
    });
    expect(await call('session/list')).toEqual({ jsonrpc: '2.0', id: 2, result: { sessions: [] } });

    if (POSIX) expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it('keeps its host id when composed again over the same data directory', async () => {
    const directory = await dataDirectory();
    const first = await compose(directory);
    const hostId = first.hostId;
    first.dispose();
    hosts.splice(hosts.indexOf(first), 1);

    expect((await compose(directory)).hostId).toBe(hostId);
  });

  it('signs in through host/auth/start and tells clients when the account changes', async () => {
    const host = await compose(await dataDirectory());
    const { call, notifications } = client(host);

    const started = await call('host/auth/start');
    expect(started).toMatchObject({ result: { userCode: 'WDJB-MJHT' } });

    await vi.waitFor(() =>
      expect(notifications).toContainEqual(
        expect.objectContaining({
          method: 'host/stateChanged',
          params: expect.objectContaining({ account: expect.objectContaining({ userId: 'user-1' }) }),
        })
      )
    );
    expect(await call('host/auth/status')).toMatchObject({ result: { account: { userId: 'user-1' } } });
  });
});
