import { chmod, mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthenticatedApiClient,
  DeviceFlowClient,
  DeviceFlowResponse,
  TokenResponse,
} from '@bike4mind/client-auth';
import { createHeadlessHostAuth, type HeadlessHostAuth, type HeadlessHostAuthOptions } from './HeadlessHostAuth';

// Any import of electron, direct or transitive, fails the suite: the host runs without it.
const electronGuard = vi.hoisted(() => ({ imported: false }));
vi.mock('electron', () => {
  electronGuard.imported = true;
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`electron.${String(property)} accessed from the headless host`);
      },
    }
  );
});

const HOSTED = 'https://b4m.example.com';
const VAULT_FILE = 'auth-vault.json';
const POSIX = process.platform !== 'win32';

/** A JWT-shaped token whose payload carries only the `id` claim the vault labels tokens with. */
function fakeAccessToken(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ id: userId }), 'utf8').toString('base64url');
  return `header.${payload}.signature`;
}

const ACCESS_TOKEN = fakeAccessToken('user-1');
const REFRESH_TOKEN = 'refresh-1';

const grant: TokenResponse = {
  access_token: ACCESS_TOKEN,
  refresh_token: REFRESH_TOKEN,
  token_type: 'Bearer',
  expires_in: 1800,
};

const deviceFlowResponse: DeviceFlowResponse = {
  device_code: 'device-code',
  user_code: 'WDJB-MJHT',
  verification_uri: `${HOSTED}/activate`,
  verification_uri_complete: `${HOSTED}/activate?code=WDJB-MJHT`,
  expires_in: 600,
  interval: 5,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function fakeDeviceFlow() {
  const client = {
    initiateDeviceFlow: vi.fn().mockResolvedValue(deviceFlowResponse),
    waitForAuthorization: vi.fn().mockResolvedValue(grant),
    refreshToken: vi.fn(),
  };
  return client as unknown as DeviceFlowClient & typeof client;
}

function silentLogger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function scratchDirectory(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'headless-host-auth-')), 'host');
}

const instances: HeadlessHostAuth[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
});

function build(dataDirectory: string, overrides: Partial<HeadlessHostAuthOptions> = {}) {
  const device = fakeDeviceFlow();
  const logger = silentLogger();
  const get = vi.fn().mockResolvedValue({ user: { id: 'user-1', email: 'rider@example.com' } });
  const auth = createHeadlessHostAuth({
    dataDirectory,
    logger,
    userAgent: 'b4m-host/test',
    defaultApiUrl: HOSTED,
    createDeviceFlowClient: () => device,
    createApiClient: () => ({ get }) as unknown as AuthenticatedApiClient,
    ...overrides,
  });
  instances.push(auth);
  return { auth, device, logger, get };
}

async function signedIn(dataDirectory: string) {
  const built = build(dataDirectory);
  await built.auth.initialize();
  await built.auth.startSignIn();
  await vi.waitFor(() => expect(built.auth.status().account).not.toBeNull());
  return built;
}

/** Resolves after pending promise callbacks and a macrotask, so a stray rejection would surface. */
function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe('createHeadlessHostAuth', () => {
  it('runs without electron', async () => {
    await signedIn(await scratchDirectory());
    expect(electronGuard.imported).toBe(false);
  });

  it('returns the code and URL before approval, then signs in once the user approves', async () => {
    const dataDirectory = await scratchDirectory();
    const approval = deferred<TokenResponse>();
    const { auth, device, logger } = build(dataDirectory);
    device.waitForAuthorization.mockReturnValue(approval.promise);
    await auth.initialize();

    const before = Date.now();
    const started = await auth.startSignIn();

    expect(started).toEqual({
      verificationUrl: `${HOSTED}/activate?code=WDJB-MJHT`,
      userCode: 'WDJB-MJHT',
      expiresAt: expect.any(Number),
    });
    expect(started.expiresAt).toBeGreaterThanOrEqual(before + 600_000 - 1000);
    expect(started.expiresAt).toBeLessThanOrEqual(Date.now() + 600_000);
    expect(auth.status()).toEqual({ account: null });
    expect(auth.getApiClient()).toBeNull();

    approval.resolve(grant);
    await vi.waitFor(() => expect(auth.status()).toEqual({ account: { userId: 'user-1', environmentUrl: HOSTED } }));
    expect(auth.getApiClient()).not.toBeNull();
    expect(auth.getState().storage).toBe(POSIX ? 'file-permissions' : 'unavailable');

    const logged = JSON.stringify([logger.debug.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
    expect(logged).not.toContain(ACCESS_TOKEN);
    expect(logged).not.toContain(REFRESH_TOKEN);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('falls back to the plain verification page when the server sends no code-filled link', async () => {
    const { auth, device } = build(await scratchDirectory());
    device.initiateDeviceFlow.mockResolvedValue({ ...deviceFlowResponse, verification_uri_complete: undefined });
    await auth.initialize();

    expect((await auth.startSignIn()).verificationUrl).toBe(`${HOSTED}/activate`);
  });

  it('reports that no browser was opened, so the client shows the code itself', async () => {
    const approval = deferred<TokenResponse>();
    const { auth, device, logger } = build(await scratchDirectory());
    device.waitForAuthorization.mockReturnValue(approval.promise);
    await auth.initialize();

    await auth.startSignIn();
    await settle();

    expect(auth.getState().pending?.browserOpened).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.skipIf(!POSIX)('stores the vault owner-only in an owner-only directory', async () => {
    const dataDirectory = await scratchDirectory();
    await signedIn(dataDirectory);

    const vault = JSON.parse(await readFile(join(dataDirectory, VAULT_FILE), 'utf8')) as { tokens: object };
    expect(Object.keys(vault.tokens)).toHaveLength(1);

    expect((await stat(dataDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dataDirectory, VAULT_FILE))).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!POSIX)('tightens a pre-existing data directory that others can read', async () => {
    const dataDirectory = await scratchDirectory();
    await mkdir(dataDirectory, { recursive: true });
    await chmod(dataDirectory, 0o755);

    const { auth } = build(dataDirectory);
    await auth.initialize();

    expect((await stat(dataDirectory)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(!POSIX)('stays signed in across a restart without another device flow', async () => {
    const dataDirectory = await scratchDirectory();
    const first = await signedIn(dataDirectory);
    first.auth.dispose();

    const second = build(dataDirectory);
    await second.auth.initialize();

    expect(second.auth.status()).toEqual({ account: { userId: 'user-1', environmentUrl: HOSTED } });
    expect(second.device.initiateDeviceFlow).not.toHaveBeenCalled();
  });

  it.skipIf(!POSIX)('clears the stored tokens on sign-out', async () => {
    const dataDirectory = await scratchDirectory();
    const { auth } = await signedIn(dataDirectory);

    await auth.signOut();

    expect(auth.status()).toEqual({ account: null });
    const vault = JSON.parse(await readFile(join(dataDirectory, VAULT_FILE), 'utf8')) as { tokens: object };
    expect(vault.tokens).toEqual({});

    const restarted = build(dataDirectory);
    await restarted.auth.initialize();
    expect(restarted.auth.status()).toEqual({ account: null });
  });

  it.skipIf(POSIX)('keeps tokens off disk on Windows, where file modes restrict nothing', async () => {
    const dataDirectory = await scratchDirectory();
    const { auth } = await signedIn(dataDirectory);

    expect(auth.getState().storage).toBe('unavailable');
    const vault = JSON.parse(await readFile(join(dataDirectory, VAULT_FILE), 'utf8')) as { tokens: object };
    expect(vault.tokens).toEqual({});
  });

  it.each([
    ['denied', 'access_denied'],
    ['expired', 'expired_token'],
  ])('returns to signed-out when the device flow is %s, and can start again', async (_label, reason) => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { auth, device } = build(await scratchDirectory());
      device.waitForAuthorization.mockRejectedValueOnce(new Error(reason));
      await auth.initialize();

      await auth.startSignIn();
      await vi.waitFor(() => expect(auth.getState().status).toBe('signed-out'));
      await settle();

      expect(auth.status()).toEqual({ account: null });
      expect(auth.getState().pending).toBeUndefined();
      expect(unhandled).not.toHaveBeenCalled();

      await expect(auth.startSignIn()).resolves.toMatchObject({ userCode: 'WDJB-MJHT' });
      expect(device.initiateDeviceFlow).toHaveBeenCalledTimes(2);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('rejects when the device flow cannot be initiated', async () => {
    const { auth, device } = build(await scratchDirectory());
    device.initiateDeviceFlow.mockRejectedValueOnce(new Error('network down'));
    await auth.initialize();

    await expect(auth.startSignIn()).rejects.toThrow();
    expect(auth.status()).toEqual({ account: null });
  });

  it('shares one device flow between concurrent and repeated starts', async () => {
    const initiation = deferred<DeviceFlowResponse>();
    const approval = deferred<TokenResponse>();
    const { auth, device } = build(await scratchDirectory());
    device.initiateDeviceFlow.mockReturnValue(initiation.promise);
    device.waitForAuthorization.mockReturnValue(approval.promise);
    await auth.initialize();

    const first = auth.startSignIn();
    const second = auth.startSignIn();
    initiation.resolve(deviceFlowResponse);

    const [a, b] = await Promise.all([first, second]);
    expect(b).toEqual(a);
    expect(await auth.startSignIn()).toEqual(a);
    expect(device.initiateDeviceFlow).toHaveBeenCalledTimes(1);
  });

  it('refuses to start a device flow while already signed in', async () => {
    const { auth, device } = await signedIn(await scratchDirectory());

    await expect(auth.startSignIn()).rejects.toThrow(/already signed in/i);
    expect(device.initiateDeviceFlow).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending sign-in', async () => {
    const approval = deferred<TokenResponse>();
    const { auth, device } = build(await scratchDirectory());
    device.waitForAuthorization.mockReturnValue(approval.promise);
    await auth.initialize();
    await auth.startSignIn();

    await auth.cancelSignIn();
    approval.resolve(grant);
    await settle();

    expect(auth.getState()).toMatchObject({ status: 'signed-out', pending: undefined });
    expect(auth.status()).toEqual({ account: null });
  });

  it('forwards state changes to the caller', async () => {
    const onStateChanged = vi.fn();
    const { auth } = build(await scratchDirectory(), { onStateChanged });

    await auth.initialize();

    expect(onStateChanged).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'signed-out' }));
  });

  it('rejects an invalid API URL instead of starting unconfigured', async () => {
    const { auth } = build(await scratchDirectory(), { defaultApiUrl: 'not a url' });

    await expect(auth.initialize()).rejects.toThrow();
  });
});
