import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedApiClient, DeviceFlowClient } from '@bike4mind/client-auth';
import type { AuthState } from '@shared/auth';
import { AuthService, DESKTOP_OAUTH_CLIENT_ID, readPhotoSource, toDesktopUser } from './AuthService';
import { TokenVault, type SecretCipher, type VaultFile } from './tokenVault';

const BAKED = 'B4M_DEFAULT_API_URL';
const HOSTED = 'https://b4m.example.com';

afterEach(() => {
  delete process.env[BAKED];
  vi.restoreAllMocks();
});

const silentLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: plain => Buffer.from(plain, 'utf8'),
  decryptString: encrypted => encrypted.toString('utf8'),
};

function memoryFile(): VaultFile {
  let contents: string | null = null;
  return {
    async read() {
      return contents;
    },
    async write(next: string) {
      contents = next;
    },
  };
}

/** A JWT-shaped token whose payload carries only the `id` claim the vault labels tokens with. */
function fakeAccessToken(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ id: userId }), 'utf8').toString('base64url');
  return `header.${payload}.signature`;
}

function fakeDeviceFlow(overrides: Partial<DeviceFlowClient> = {}) {
  const client = {
    initiateDeviceFlow: vi.fn().mockResolvedValue({
      device_code: 'device-code',
      user_code: 'WDJB-MJHT',
      verification_uri: `${HOSTED}/activate`,
      verification_uri_complete: `${HOSTED}/activate?code=WDJB-MJHT`,
      expires_in: 600,
      interval: 5,
    }),
    waitForAuthorization: vi.fn().mockResolvedValue({
      access_token: fakeAccessToken('user-1'),
      refresh_token: 'refresh-1',
      token_type: 'Bearer',
      expires_in: 1800,
    }),
    refreshToken: vi.fn(),
    ...overrides,
  };
  return client as unknown as DeviceFlowClient & typeof client;
}

function build(options: {
  device?: ReturnType<typeof fakeDeviceFlow>;
  get?: ReturnType<typeof vi.fn>;
  vault?: TokenVault;
  openExternal?: (url: string) => Promise<void>;
}) {
  const device = options.device ?? fakeDeviceFlow();
  const get = options.get ?? vi.fn().mockResolvedValue({ user: { id: 'user-1', email: 'rider@example.com' } });
  const vault = options.vault ?? new TokenVault(cipher, memoryFile(), silentLogger);
  const states: AuthState[] = [];
  const openExternal = vi.fn(options.openExternal ?? (async () => {}));

  const service = new AuthService({
    vault,
    logger: silentLogger,
    openExternal,
    devFallback: false,
    userAgent: 'b4m-desktop/test',
    onStateChanged: state => states.push(state),
    createDeviceFlowClient: () => device,
    createApiClient: () => ({ get }) as unknown as AuthenticatedApiClient,
  });

  return { service, device, get, vault, states, openExternal };
}

describe('AuthService', () => {
  it('registers under the client id production allowlists', () => {
    expect(DESKTOP_OAUTH_CLIENT_ID).toBe('b4m-cli');
  });

  it('drives the device flow to a signed-in session without exposing a token', async () => {
    process.env[BAKED] = HOSTED;
    const { service, device, vault, states, openExternal } = build({});

    await service.initialize();
    expect(service.getState().status).toBe('signed-out');

    await service.signIn();

    // One client instance served both initiate and redemption, which is what keeps the
    // `client_id` identical across the two calls (RFC 8628 s3.4).
    expect(device.initiateDeviceFlow).toHaveBeenCalledTimes(1);
    expect(device.waitForAuthorization).toHaveBeenCalledWith('device-code', 5);
    expect(openExternal).toHaveBeenCalledWith(`${HOSTED}/activate?code=WDJB-MJHT`);

    const approval = states.find(state => state.status === 'awaiting-approval');
    expect(approval?.pending?.userCode).toBe('WDJB-MJHT');

    expect(service.getState()).toMatchObject({
      status: 'signed-in',
      user: { id: 'user-1', email: 'rider@example.com' },
    });

    // The credential landed in the vault and never in any published state.
    expect(await vault.getTokens(HOSTED)).toMatchObject({ refreshToken: 'refresh-1', userId: 'user-1' });
    expect(JSON.stringify(states)).not.toContain('refresh-1');

    service.dispose();
  });

  it('surfaces the browser handoff failing without failing the sign-in', async () => {
    process.env[BAKED] = HOSTED;
    const { service, states } = build({
      openExternal: async () => {
        throw new Error('no browser');
      },
    });

    await service.initialize();
    await service.signIn();

    // The code and address stay on screen, which is the whole point of the fallback.
    const approval = states.filter(state => state.status === 'awaiting-approval').at(-1);
    expect(approval?.pending?.browserOpened).toBe(false);
    expect(approval?.pending?.userCode).toBe('WDJB-MJHT');
    expect(approval?.pending?.verificationUri).toBe(`${HOSTED}/activate`);
    expect(service.getState().status).toBe('signed-in');

    service.dispose();
  });

  it('keeps the session and offers the policy remedy on a 403 policy gate', async () => {
    process.env[BAKED] = HOSTED;
    const get = vi.fn().mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        response: { status: 403, data: { policyAcceptanceRequired: true, error_description: 'Accept the AUP.' } },
      })
    );
    const { service, vault } = build({ get });

    await service.initialize();
    await service.signIn();

    expect(service.getState()).toMatchObject({
      status: 'policy-acceptance-required',
      error: { remedy: 'accept-policy', message: 'Accept the AUP.' },
    });
    // The token is good; discarding it would force a pointless second device flow.
    expect(await vault.getTokens(HOSTED)).not.toBeNull();

    service.dispose();
  });

  it('keeps the session and offers the MFA remedy on a 401 mfaPending', async () => {
    process.env[BAKED] = HOSTED;
    const get = vi.fn().mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        response: { status: 401, data: { mfaPending: true, error: 'MFA setup or verification required.' } },
      })
    );
    const { service, vault } = build({ get });

    await service.initialize();
    await service.signIn();

    expect(service.getState()).toMatchObject({ status: 'mfa-required', error: { remedy: 'complete-mfa' } });
    expect(await vault.getTokens(HOSTED)).not.toBeNull();

    service.dispose();
  });

  it('reuses a cached session when switching back to an environment', async () => {
    process.env[BAKED] = HOSTED;
    const vault = new TokenVault(cipher, memoryFile(), silentLogger);
    const { service, device } = build({ vault });

    await service.initialize();
    await service.signIn();
    expect(device.initiateDeviceFlow).toHaveBeenCalledTimes(1);

    await service.setEnvironment({ preset: 'local' });
    expect(service.getState()).toMatchObject({ status: 'signed-out', environment: { url: 'http://localhost:3000' } });

    await service.setEnvironment({ preset: 'hosted' });
    expect(service.getState()).toMatchObject({ status: 'signed-in', environment: { url: HOSTED } });
    // No second device flow: the cached token for that environment was adopted.
    expect(device.initiateDeviceFlow).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it('clears the environment credential on sign-out', async () => {
    process.env[BAKED] = HOSTED;
    const { service, vault } = build({});

    await service.initialize();
    await service.signIn();
    await service.signOut();

    expect(service.getState()).toMatchObject({ status: 'signed-out', user: undefined });
    expect(await vault.getTokens(HOSTED)).toBeNull();

    service.dispose();
  });

  it('reports an unconfigured build instead of pointing at a localhost that is not there', async () => {
    const { service } = build({});

    await service.initialize();

    expect(service.getState()).toMatchObject({
      status: 'unconfigured',
      hostedAvailable: false,
      error: { remedy: 'choose-environment' },
    });

    service.dispose();
  });
});

describe('toDesktopUser', () => {
  it('names the account from the identity response', () => {
    expect(toDesktopUser({ _id: 'user-9', email: 'rider@example.com', nickname: 'Rider' }, 'fallback')).toEqual({
      id: 'user-9',
      email: 'rider@example.com',
      username: undefined,
      nickname: 'Rider',
    });
  });

  it("falls back to the token's account id when the response carries no user", () => {
    expect(toDesktopUser(null, 'user-1')).toEqual({ id: 'user-1' });
  });

  it("carries no photo: the renderable url is main's to produce, not the wire's", () => {
    expect(toDesktopUser({ id: 'user-1', photoUrl: 'profile-photos/user-1/a.png' }, '')).not.toHaveProperty(
      'photoUrl',
      'profile-photos/user-1/a.png'
    );
  });
});

describe('readPhotoSource', () => {
  it("reads the account's stored photo key", () => {
    expect(readPhotoSource({ photoUrl: 'profile-photos/user-1/a.png' })).toBe('profile-photos/user-1/a.png');
  });

  it('ignores avatarUrl, which on this entity belongs to a Notion workspace owner', () => {
    expect(readPhotoSource({ avatarUrl: 'https://notion.example.com/owner.png' })).toBeUndefined();
  });

  it('treats a cleared photo as no photo', () => {
    expect(readPhotoSource({ photoUrl: null })).toBeUndefined();
    expect(readPhotoSource({ photoUrl: '' })).toBeUndefined();
    expect(readPhotoSource(undefined)).toBeUndefined();
  });
});
