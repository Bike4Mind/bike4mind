import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { findById, updateOne, config } = vi.hoisted(() => ({
  findById: vi.fn(),
  updateOne: vi.fn(),
  config: {
    APPLE_CLIENT_ID: 'com.example.services' as string | undefined,
    APPLE_TEAM_ID: 'TEAM',
    APPLE_KEY_ID: 'KEY',
    APPLE_PRIVATE_KEY: '',
  },
}));
vi.mock('@bike4mind/database', () => ({ User: { findById, updateOne } }));
vi.mock('@bike4mind/utils/security', () => ({ decryptAtRest: (value: string) => value.replace(/^enc:/, '') }));
vi.mock('../utils/config', () => ({ Config: config }));

import { revokeAppleTokens } from './revokeAppleTokens';

const lean = (user: unknown) => findById.mockReturnValue({ lean: async () => user });

describe('revokeAppleTokens', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    config.APPLE_CLIENT_ID = 'com.example.services';
    config.APPLE_PRIVATE_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    findById.mockReset();
    updateOne.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts the decrypted refresh token to Apple and clears the stored tokens', async () => {
    lean({ authProviders: [{ strategy: 'apple', id: 'sub', encrypted: true, refreshToken: 'enc:r-token' }] });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await expect(revokeAppleTokens('u1')).resolves.toEqual({ status: 'revoked' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://appleid.apple.com/auth/revoke');
    expect(init.method).toBe('POST');
    const body = init.body as URLSearchParams;
    expect(body.get('token')).toBe('r-token');
    expect(body.get('token_type_hint')).toBe('refresh_token');
    expect(body.get('client_id')).toBe('com.example.services');
    expect(body.get('client_secret')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(updateOne).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the user has no Apple token', async () => {
    lean({ authProviders: [{ strategy: 'google', id: 'g', refreshToken: 'x' }] });

    await expect(revokeAppleTokens('u1')).resolves.toEqual({ status: 'no_token' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('is a no-op for a missing user', async () => {
    lean(null);
    await expect(revokeAppleTokens('u1')).resolves.toEqual({ status: 'no_token' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports not_configured, without calling Apple, when a token exists but credentials are unset', async () => {
    config.APPLE_CLIENT_ID = undefined;
    lean({ authProviders: [{ strategy: 'apple', id: 'sub', refreshToken: 'r' }] });

    await expect(revokeAppleTokens('u1')).resolves.toEqual({ status: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws and keeps the tokens when Apple refuses', async () => {
    lean({ authProviders: [{ strategy: 'apple', id: 'sub', refreshToken: 'r' }] });
    fetchMock.mockResolvedValue({ ok: false, status: 400 });

    await expect(revokeAppleTokens('u1')).rejects.toThrow(/400/);
    expect(updateOne).not.toHaveBeenCalled();
  });
});
