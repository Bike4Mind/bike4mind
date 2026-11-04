import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ loadClient: vi.fn(), revokeToken: vi.fn() }));

vi.mock('@bike4mind/mcp/remote', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/mcp/remote')>()),
  revokeRemoteMcpToken: h.revokeToken,
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  decryptToken: (value?: string | null) => {
    if (value?.startsWith('bad:')) throw new Error('decryption failed');
    return value ? value.replace(/^enc:/, '') : null;
  },
}));
vi.mock('./clientIdentity', () => ({ loadConnectionClient: h.loadClient }));
vi.mock('./oauthFetch', () => ({
  withOAuthFetch: (_n: unknown, _o: unknown, fn: (f: unknown) => Promise<unknown>) => fn(vi.fn()),
}));

import { revokeConnectionGrant } from './revoke';

const connection = (oauth: Record<string, unknown> = {}) =>
  ({
    id: 'c1',
    auth: {
      kind: 'oauth',
      oauth: {
        revocationEndpoint: 'https://as.example/revoke',
        accessTokenEnc: 'enc:at',
        refreshTokenEnc: 'enc:rt',
        ...oauth,
      },
    },
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.loadClient.mockResolvedValue({ clientId: 'cid' });
  h.revokeToken.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.useRealTimers());

describe('revokeConnectionGrant', () => {
  it('revokes the refresh token, then the access token', async () => {
    await revokeConnectionGrant(connection(), {} as never);
    expect(h.revokeToken.mock.calls.map(call => [call[1].token, call[1].hint])).toEqual([
      ['rt', 'refresh_token'],
      ['at', 'access_token'],
    ]);
  });

  it('does nothing without a revocation endpoint or tokens', async () => {
    await revokeConnectionGrant(connection({ revocationEndpoint: undefined }), {} as never);
    await revokeConnectionGrant(connection({ accessTokenEnc: undefined, refreshTokenEnc: undefined }), {} as never);
    expect(h.revokeToken).not.toHaveBeenCalled();
  });

  it('resolves, and logs only a code, when a token cannot be decrypted', async () => {
    await expect(
      revokeConnectionGrant(connection({ refreshTokenEnc: 'bad:rt' }), {} as never)
    ).resolves.toBeUndefined();
    expect(h.revokeToken).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).not.toContain('bad:rt');
  });

  it('keeps going when one revocation fails, and logs no token value', async () => {
    h.revokeToken.mockRejectedValueOnce(new Error('boom rt'));
    await revokeConnectionGrant(connection(), {} as never);
    expect(h.revokeToken).toHaveBeenCalledTimes(2);
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).not.toMatch(/\brt\b|\bat\b/);
  });

  it('stops waiting at the deadline when the server does not answer', async () => {
    vi.useFakeTimers();
    h.revokeToken.mockReturnValue(new Promise(() => undefined));
    const done = vi.fn();
    const pending = revokeConnectionGrant(connection(), {} as never, undefined, 3_000).then(done);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await pending;
    expect(done).toHaveBeenCalled();
  });
});
