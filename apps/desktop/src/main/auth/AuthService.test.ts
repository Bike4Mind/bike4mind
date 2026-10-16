import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import {
  AuthenticatedApiClient,
  NotAuthenticatedError,
  type AuthTokens,
  type DeviceFlowClient,
  type RefreshTokenResponse,
} from '@bike4mind/client-auth';
import type { AuthState } from '@shared/auth';
import { AuthService, DESKTOP_OAUTH_CLIENT_ID, readPhotoSource, toDesktopUser } from './AuthService';
import { fetchProfilePhoto, LOCAL_FILE_PROXY_BASE, type ProfilePhotoCache } from './profilePhoto';
import { TokenVault, type SecretCipher, type VaultFile } from './tokenVault';

// The download itself is MediaApiClient's and tested there; what matters here is the base the
// service hands it, which is the only thing standing between a self-host account and initials.
vi.mock('./profilePhoto', async () => {
  const actual = await vi.importActual<typeof import('./profilePhoto')>('./profilePhoto');
  return { ...actual, fetchProfilePhoto: vi.fn().mockResolvedValue(null) };
});

const BAKED = 'B4M_DEFAULT_API_URL';
const HOSTED = 'https://b4m.example.com';

afterEach(() => {
  delete process.env[BAKED];
  vi.mocked(fetchProfilePhoto).mockClear();
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

/** Enough of the cache to get past the service's "is there one?" guard; the fetch is mocked. */
function photoCache(): ProfilePhotoCache {
  return { lookup: vi.fn().mockResolvedValue(null), store: vi.fn(), clear: vi.fn() } as unknown as ProfilePhotoCache;
}

/** A photo source on the identity response is what sends the service looking for a CDN base. */
function identifyWithPhoto(cdnUrl: unknown) {
  return vi.fn(async (path: string) =>
    path === '/api/settings/serverConfig'
      ? { cdnUrl }
      : { user: { id: 'user-1', email: 'rider@example.com', photoUrl: 'profile-photos/user-1/a.png' } }
  );
}

function build(options: {
  device?: ReturnType<typeof fakeDeviceFlow>;
  get?: ReturnType<typeof vi.fn>;
  vault?: TokenVault;
  openExternal?: (url: string) => Promise<void>;
  profilePhotos?: ProfilePhotoCache;
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
    profilePhotos: options.profilePhotos,
  });

  return { service, device, get, vault, states, openExternal };
}

describe('AuthService', () => {
  it('registers under the desktop client id the server allowlists', () => {
    expect(DESKTOP_OAUTH_CLIENT_ID).toBe('b4m-desktop');
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

  /**
   * The bug this covers: a self-host stack whose operator never set `NEXT_PUBLIC_CDN_URL`
   * answers serverConfig with an empty `cdnUrl`, which used to end the photo lookup there.
   */
  it('falls back to the local file proxy when the deployment advertises no CDN', async () => {
    process.env[BAKED] = HOSTED;
    const { service } = build({ get: identifyWithPhoto(''), profilePhotos: photoCache() });

    await service.initialize();
    await service.signIn();

    await vi.waitFor(() =>
      expect(fetchProfilePhoto).toHaveBeenCalledWith(expect.objectContaining({ cdnUrl: LOCAL_FILE_PROXY_BASE }))
    );

    service.dispose();
  });

  it('prefers an advertised CDN over the proxy fallback', async () => {
    process.env[BAKED] = HOSTED;
    const { service } = build({
      get: identifyWithPhoto('https://cdn.example.com'),
      profilePhotos: photoCache(),
    });

    await service.initialize();
    await service.signIn();

    await vi.waitFor(() =>
      expect(fetchProfilePhoto).toHaveBeenCalledWith(expect.objectContaining({ cdnUrl: 'https://cdn.example.com' }))
    );

    service.dispose();
  });

  /**
   * A lookup that never answered says nothing about how the deployment serves files, so it
   * gets no guess - and nothing is cached, so the next attempt asks again.
   */
  it('guesses no base at all when the serverConfig lookup fails', async () => {
    process.env[BAKED] = HOSTED;
    const get = vi.fn(async (path: string) => {
      if (path === '/api/settings/serverConfig') throw new Error('network down');
      return { user: { id: 'user-1', photoUrl: 'profile-photos/user-1/a.png' } };
    });
    const { service } = build({ get, profilePhotos: photoCache() });

    await service.initialize();
    await service.signIn();

    await vi.waitFor(() => expect(fetchProfilePhoto).toHaveBeenCalledWith(expect.objectContaining({ cdnUrl: '' })));

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

/**
 * The real shared client over the vault, so these exercise the refresh rules end to end. The
 * API accepts whichever access tokens are in `accepted`; everything else is a 401.
 */
function buildWithSharedClient(options: { file?: VaultFile; refreshToken: ReturnType<typeof vi.fn> }) {
  const accepted = new Set<string>();
  const device = fakeDeviceFlow({ refreshToken: options.refreshToken as DeviceFlowClient['refreshToken'] });
  const file = options.file ?? memoryFile();
  const vault = new TokenVault(cipher, file, silentLogger);
  const states: AuthState[] = [];

  const service = new AuthService({
    vault,
    logger: silentLogger,
    openExternal: async () => {},
    devFallback: false,
    userAgent: 'b4m-desktop/test',
    onStateChanged: state => states.push(state),
    createDeviceFlowClient: () => device,
    createApiClient: (baseUrl, tokenStore, onTokensCleared) => {
      const client = new AuthenticatedApiClient({
        baseUrl,
        tokenStore,
        oauthClient: device,
        logger: silentLogger,
        onTokensCleared,
        reauthMessages: { refreshFailed: 'expired', stillUnauthorized: 'invalid' },
      });
      client.getAxiosInstance().defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
        const sent = String(config.headers.Authorization ?? '').replace('Bearer ', '');
        if (accepted.has(sent)) {
          return {
            data: { user: { id: 'user-1' } },
            status: 200,
            statusText: 'OK',
            headers: {},
            config,
          } as AxiosResponse;
        }
        throw httpError(401, config);
      }) as AxiosAdapter;
      return client;
    },
  });

  return { service, vault, file, states, accepted, device };
}

function httpError(status: number, config = {} as InternalAxiosRequestConfig): AxiosError {
  return new AxiosError(`HTTP ${status}`, 'ERR_BAD_RESPONSE', config, {}, {
    status,
    statusText: String(status),
    data: {},
    headers: {},
    config,
  } as AxiosResponse);
}

function storedTokens(index: number, expiresInMs: number): AuthTokens {
  return {
    accessToken: `access-${index}`,
    refreshToken: `refresh-${index}`,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    userId: 'user-1',
  };
}

function rotation(index: number): RefreshTokenResponse {
  return {
    access_token: `access-${index}`,
    refresh_token: `refresh-${index}`,
    token_type: 'Bearer',
    expires_in: 1800,
  } as RefreshTokenResponse;
}

describe('AuthService token refresh', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Signed in on `access-0`, whose proactive refresh falls due after the 5 s minimum delay. */
  async function signedIn(refreshToken: ReturnType<typeof vi.fn>, file?: VaultFile) {
    vi.useFakeTimers();
    process.env[BAKED] = HOSTED;
    const harness = buildWithSharedClient({ refreshToken, file });
    harness.accepted.add('access-0');
    await harness.vault.setTokens(HOSTED, storedTokens(0, 60_000));
    await harness.service.initialize();
    expect(harness.service.getState().status).toBe('signed-in');
    return harness;
  }

  it('keeps the session and the vault when a proactive refresh fails transiently', async () => {
    const { service, vault } = await signedIn(vi.fn().mockRejectedValue(httpError(503)));

    await vi.advanceTimersByTimeAsync(5_000);

    expect(service.getState().status).toBe('signed-in');
    expect(await vault.getTokens(HOSTED)).toMatchObject({ refreshToken: 'refresh-0' });
    service.dispose();
  });

  it('shows signed-out with a reason, and empties the vault, when the server rejects the refresh token', async () => {
    const { service, vault } = await signedIn(vi.fn().mockRejectedValue(httpError(401)));

    await vi.advanceTimersByTimeAsync(5_000);

    expect(service.getState()).toMatchObject({
      status: 'signed-out',
      user: undefined,
      error: { message: 'This session has expired. Sign in again.', remedy: 'retry-sign-in' },
    });
    expect(await vault.reloadTokens(HOSTED)).toBeNull();
    expect(silentLogger.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 401'));
  });

  it('stays quietly signed-out when the user signs out while a refresh is pending', async () => {
    let fail: (error: Error) => void = () => {};
    const refreshToken = vi.fn(() => new Promise<RefreshTokenResponse>((_resolve, reject) => (fail = reject)));
    const { service, vault } = await signedIn(refreshToken);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    await service.signOut();
    fail(new NotAuthenticatedError('not logged in'));
    await vi.advanceTimersByTimeAsync(0);

    expect(service.getState()).toMatchObject({ status: 'signed-out', error: undefined });
    expect(await vault.reloadTokens(HOSTED)).toBeNull();
    service.dispose();
  });

  it('shows signed-out when the client clears the tokens on a request 401, instead of staying signed-in', async () => {
    const { service, accepted, vault } = await signedIn(vi.fn().mockRejectedValue(httpError(400)));
    // The access token lapses server-side and locally before the proactive timer runs.
    accepted.clear();
    await vault.setTokens(HOSTED, storedTokens(0, -1_000));

    await expect(service.getApiClient()?.get('/api/anything')).rejects.toThrow('expired');

    expect(service.getState()).toMatchObject({ status: 'signed-out', error: { remedy: 'retry-sign-in' } });
    expect(service.getApiClient()).toBeNull();
    service.dispose();
  });

  it('shares one exchange between the proactive timer and a concurrent 401', async () => {
    let release: (value: RefreshTokenResponse) => void = () => {};
    const refreshToken = vi.fn(() => new Promise<RefreshTokenResponse>(resolve => (release = resolve)));
    const { service, accepted, vault } = await signedIn(refreshToken);
    const api = service.getApiClient();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    accepted.delete('access-0');
    accepted.add('access-1');
    const request = api?.get('/api/anything');

    release(rotation(1));

    await expect(request).resolves.toBeTruthy();
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(await vault.reloadTokens(HOSTED)).toMatchObject({ refreshToken: 'refresh-1' });
    service.dispose();
  });

  it('presents the refresh token another instance rotated into the shared vault file', async () => {
    const file = memoryFile();
    const refreshToken = vi.fn().mockResolvedValue(rotation(6));
    const { service, vault } = await signedIn(refreshToken, file);
    // A second app instance over the same userData rotated the chain on its own, and that
    // access token has lapsed too, so an exchange is due - with the sibling's refresh token.
    await new TokenVault(cipher, file, silentLogger).setTokens(HOSTED, storedTokens(5, -1_000));

    await vi.advanceTimersByTimeAsync(5_000);

    expect(refreshToken).toHaveBeenCalledWith('refresh-5');
    expect(await vault.reloadTokens(HOSTED)).toMatchObject({ refreshToken: 'refresh-6' });
    service.dispose();
  });

  it('adopts a refresh another instance already made instead of rotating again', async () => {
    const file = memoryFile();
    const refreshToken = vi.fn();
    const { service, vault } = await signedIn(refreshToken, file);
    await new TokenVault(cipher, file, silentLogger).setTokens(HOSTED, storedTokens(5, 30 * 60_000));

    await vi.advanceTimersByTimeAsync(5_000);

    expect(refreshToken).not.toHaveBeenCalled();
    expect(await vault.getTokens(HOSTED)).toMatchObject({ refreshToken: 'refresh-5' });
    expect(service.getState().status).toBe('signed-in');
    service.dispose();
  });
});
