import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RemoteMcpAuthFailedError,
  RemoteMcpAuthRequiredError,
  RemoteMcpInvalidGrantError,
  RemoteMcpOAuthError,
} from '@bike4mind/mcp/remote';

const h = vi.hoisted(() => ({
  repo: {
    acquireRefreshLease: vi.fn(),
    releaseRefreshLease: vi.fn(async () => true),
    findByIdWithCredentials: vi.fn(),
    completeRefresh: vi.fn(),
    setNeedsReconnectIfHolder: vi.fn(),
  },
  refresh: vi.fn(),
  loadClient: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ mcpConnectionRepository: h.repo }));
vi.mock('@bike4mind/mcp/remote', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/mcp/remote')>()),
  refreshRemoteMcpTokens: h.refresh,
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  encryptToken: (value?: string | null) => (value ? `enc:${value}` : null),
  decryptToken: (value?: string | null) => (value ? value.replace(/^enc:/, '') : null),
}));
vi.mock('./clientIdentity', () => ({ loadConnectionClient: h.loadClient }));
vi.mock('./oauthFetch', () => ({
  withOAuthFetch: (_n: unknown, _o: unknown, fn: (f: unknown) => Promise<unknown>) => fn(vi.fn()),
}));

import {
  OAUTH_EXPIRY_SKEW_MS,
  OAuthGrantSupersededError,
  OAuthReconnectRequiredError,
  OAuthRefreshUnavailableError,
  getOAuthAccessToken,
} from './tokenManager';

const NOW = 1_000_000_000_000;
const network = { ownHosts: [] } as never;
let clock = NOW;
const sleep = vi.fn(async (ms: number) => {
  clock += ms;
});
const options = (extra: Record<string, unknown> = {}) => ({ network, sleep, now: () => clock, ...extra });

type OAuthOverrides = Record<string, unknown>;
const connection = (oauth: OAuthOverrides = {}, status = 'connected') =>
  ({
    id: 'c1',
    ownerKey: 'u1',
    status,
    auth: {
      kind: 'oauth',
      oauth: {
        accessTokenEnc: 'enc:old-access',
        refreshTokenEnc: 'enc:old-refresh',
        expiresAt: new Date(NOW - 1000),
        issuer: 'https://as.example',
        tokenEndpoint: 'https://as.example/token',
        ...oauth,
      },
    },
  }) as never;
const acquired = (conn: unknown) =>
  h.repo.acquireRefreshLease.mockResolvedValue({ outcome: 'acquired', connection: conn });

beforeEach(() => {
  vi.clearAllMocks();
  clock = NOW;
  h.repo.releaseRefreshLease.mockResolvedValue(true);
  h.repo.completeRefresh.mockResolvedValue({ id: 'c1' });
  h.repo.setNeedsReconnectIfHolder.mockResolvedValue({ id: 'c1' });
  h.loadClient.mockResolvedValue({ clientId: 'cid', tokenEndpointAuthMethod: 'none' });
  h.refresh.mockResolvedValue({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresInSeconds: 3600 });
});

describe('getOAuthAccessToken', () => {
  it('has nothing to send before sign-in', async () => {
    const conn = { id: 'c1', ownerKey: 'u1', auth: { kind: 'oauth', oauth: {} } } as never;
    expect(await getOAuthAccessToken(conn, options())).toBeUndefined();
    expect(h.repo.acquireRefreshLease).not.toHaveBeenCalled();
  });

  it('uses a token that is not near expiry without taking the lease', async () => {
    const conn = connection({ expiresAt: new Date(NOW + OAUTH_EXPIRY_SKEW_MS + 1000) });
    expect(await getOAuthAccessToken(conn, options())).toBe('old-access');
    expect(h.repo.acquireRefreshLease).not.toHaveBeenCalled();
  });

  it('refreshes a token inside the expiry skew', async () => {
    const conn = connection({ expiresAt: new Date(NOW + OAUTH_EXPIRY_SKEW_MS - 1000) });
    acquired(conn);
    expect(await getOAuthAccessToken(conn, options())).toBe('new-access');
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes a valid token when forced', async () => {
    const conn = connection({ expiresAt: new Date(NOW + 3_600_000) });
    acquired(conn);
    expect(await getOAuthAccessToken(conn, options({ force: true }))).toBe('new-access');
  });

  it('asks for sign-in when the token expired and there is no refresh token', async () => {
    const conn = connection({ refreshTokenEnc: undefined });
    await expect(getOAuthAccessToken(conn, options())).rejects.toBeInstanceOf(RemoteMcpAuthRequiredError);
    expect(h.repo.acquireRefreshLease).not.toHaveBeenCalled();
  });

  it('stores the refreshed tokens under the lease, with an expiry from the response, and frees it', async () => {
    const conn = connection();
    acquired(conn);
    await getOAuthAccessToken(conn, options());
    expect(h.repo.completeRefresh).toHaveBeenCalledWith('c1', expect.any(String), {
      accessTokenEnc: 'enc:new-access',
      refreshTokenEnc: 'enc:new-refresh',
      expiresAt: new Date(NOW + 3_600_000),
    });
    const holder = h.repo.acquireRefreshLease.mock.calls[0]?.[2];
    expect(h.repo.releaseRefreshLease).toHaveBeenCalledWith('c1', holder);
  });

  describe('after the lease is won', () => {
    it('uses a token another caller stored meanwhile instead of spending the refresh token', async () => {
      acquired(connection({ accessTokenEnc: 'enc:theirs', expiresAt: new Date(NOW + 3_600_000) }));
      expect(await getOAuthAccessToken(connection(), options())).toBe('theirs');
      expect(h.refresh).not.toHaveBeenCalled();
      expect(h.repo.releaseRefreshLease).toHaveBeenCalledTimes(1);
    });

    it('accepts a stored token whose whole life is shorter than the expiry skew', async () => {
      acquired(connection({ accessTokenEnc: 'enc:short', expiresAt: new Date(NOW + 30_000) }));
      expect(await getOAuthAccessToken(connection(), options())).toBe('short');
      expect(h.refresh).not.toHaveBeenCalled();
    });

    it('refreshes when the stored token is the stale one, even if it looks unexpired', async () => {
      const stale = connection({ expiresAt: new Date(NOW + 5_000) });
      acquired(stale);
      await getOAuthAccessToken(stale, options());
      expect(h.refresh).toHaveBeenCalledTimes(1);
    });

    it('asks for sign-in when the refresh token vanished', async () => {
      acquired(connection({ refreshTokenEnc: undefined }));
      await expect(getOAuthAccessToken(connection(), options())).rejects.toBeInstanceOf(RemoteMcpAuthRequiredError);
      expect(h.repo.releaseRefreshLease).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the lease was lost during the refresh', () => {
    it('returns what is stored now, never the token that could not be written', async () => {
      acquired(connection());
      h.repo.completeRefresh.mockResolvedValue(null);
      h.repo.findByIdWithCredentials.mockResolvedValue(
        connection({ accessTokenEnc: 'enc:winner', expiresAt: new Date(NOW + 3_600_000) })
      );
      expect(await getOAuthAccessToken(connection(), options())).toBe('winner');
    });

    it('asks for sign-in when nothing usable is stored', async () => {
      acquired(connection());
      h.repo.completeRefresh.mockResolvedValue(null);
      h.repo.findByIdWithCredentials.mockResolvedValue(connection());
      await expect(getOAuthAccessToken(connection(), options())).rejects.toBeInstanceOf(OAuthGrantSupersededError);
    });
  });

  describe('failures of the token request', () => {
    it('a lost grant marks reconnect, but only while the caller still holds the lease', async () => {
      acquired(connection());
      h.refresh.mockRejectedValue(new RemoteMcpInvalidGrantError());
      await expect(getOAuthAccessToken(connection(), options())).rejects.toBeInstanceOf(OAuthReconnectRequiredError);
      const holder = h.repo.acquireRefreshLease.mock.calls[0]?.[2];
      expect(h.repo.setNeedsReconnectIfHolder).toHaveBeenCalledWith(
        'c1',
        holder,
        expect.objectContaining({ code: 'invalid_grant' })
      );
    });

    it('a late invalid_grant from a holder that lost its lease does not mark reconnect', async () => {
      acquired(connection());
      h.refresh.mockRejectedValue(new RemoteMcpInvalidGrantError());
      h.repo.setNeedsReconnectIfHolder.mockResolvedValue(null);
      h.repo.findByIdWithCredentials.mockResolvedValue(
        connection({ accessTokenEnc: 'enc:winner', expiresAt: new Date(NOW + 3_600_000) })
      );
      expect(await getOAuthAccessToken(connection(), options())).toBe('winner');
    });

    it.each([
      ['a network error', new TypeError('fetch failed')],
      ['an unavailable token endpoint', new RemoteMcpOAuthError('token_unavailable', 'unavailable')],
    ])('%s is a timeout, with the status and the grant untouched', async (_name, failure) => {
      acquired(connection());
      h.refresh.mockRejectedValue(failure);
      const outcome = await getOAuthAccessToken(connection(), options()).catch((e: unknown) => e);
      expect(outcome).toBeInstanceOf(OAuthRefreshUnavailableError);
      expect(outcome).toMatchObject({ code: 'timeout' });
      expect(h.repo.setNeedsReconnectIfHolder).not.toHaveBeenCalled();
      expect(h.repo.completeRefresh).not.toHaveBeenCalled();
      expect(h.repo.releaseRefreshLease).toHaveBeenCalledTimes(1);
    });

    it('a definitive refusal is an auth failure, not a timeout', async () => {
      acquired(connection());
      h.refresh.mockRejectedValue(new RemoteMcpOAuthError('token_failed', 'refused'));
      await expect(getOAuthAccessToken(connection(), options())).rejects.toBeInstanceOf(RemoteMcpAuthFailedError);
      expect(h.repo.setNeedsReconnectIfHolder).not.toHaveBeenCalled();
    });
  });

  describe('while another caller holds the lease', () => {
    const held = () => h.repo.acquireRefreshLease.mockResolvedValue({ outcome: 'held' });

    it('takes the token the holder stores, polling instead of calling the token endpoint', async () => {
      held();
      h.repo.findByIdWithCredentials
        .mockResolvedValueOnce(connection())
        .mockResolvedValueOnce(connection({ accessTokenEnc: 'enc:shared', expiresAt: new Date(NOW + 3_600_000) }));
      expect(await getOAuthAccessToken(connection(), options())).toBe('shared');
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(h.refresh).not.toHaveBeenCalled();
    });

    it('takes a short-lived token the holder stores', async () => {
      held();
      h.repo.findByIdWithCredentials.mockResolvedValue(
        connection({ accessTokenEnc: 'enc:short', expiresAt: new Date(NOW + 20_000) })
      );
      expect(await getOAuthAccessToken(connection(), options())).toBe('short');
    });

    it('gives up with a timeout, not a reconnect, when the holder never finishes', async () => {
      held();
      h.repo.findByIdWithCredentials.mockResolvedValue(connection());
      await expect(getOAuthAccessToken(connection(), options())).rejects.toBeInstanceOf(OAuthRefreshUnavailableError);
      expect(clock - NOW).toBeGreaterThanOrEqual(12_000);
      expect(h.repo.setNeedsReconnectIfHolder).not.toHaveBeenCalled();
    });

    it('does not return the rejected token while the holder is still refreshing, but takes its replacement', async () => {
      held();
      const stale = { accessTokenEnc: 'enc:old-access', expiresAt: new Date(NOW + 3_600_000) };
      h.repo.findByIdWithCredentials
        .mockResolvedValueOnce(connection(stale))
        .mockResolvedValueOnce(connection(stale))
        .mockResolvedValueOnce(connection({ accessTokenEnc: 'enc:new', expiresAt: new Date(NOW + 3_600_000) }));
      const token = await getOAuthAccessToken(connection(stale), options({ force: true }));
      expect(token).toBe('new');
      expect(sleep).toHaveBeenCalledTimes(3);
    });

    it('surfaces a reconnect the holder recorded', async () => {
      held();
      h.repo.findByIdWithCredentials.mockResolvedValue(connection({}, 'needs_reconnect'));
      await expect(getOAuthAccessToken(connection(), options())).rejects.toBeInstanceOf(OAuthReconnectRequiredError);
    });

    it('a waiter that wins the lease after the holder released it reuses the stored token', async () => {
      h.repo.acquireRefreshLease.mockResolvedValueOnce({ outcome: 'held' }).mockResolvedValueOnce({
        outcome: 'acquired',
        connection: connection({ accessTokenEnc: 'enc:winner', expiresAt: new Date(NOW + 3_600_000) }),
      });
      h.repo.findByIdWithCredentials.mockResolvedValue(connection());
      expect(await getOAuthAccessToken(connection(), options())).toBe('winner');
      expect(h.refresh).not.toHaveBeenCalled();
    });
  });
});
