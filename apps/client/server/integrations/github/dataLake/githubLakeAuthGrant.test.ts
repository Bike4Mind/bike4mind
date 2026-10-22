import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@bike4mind/observability';

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  findLive: vi.fn(),
  consume: vi.fn(),
  encryptToken: vi.fn(),
  decryptToken: vi.fn(),
  revokeInstallerToken: vi.fn(),
}));

vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    gitHubLakeAuthGrantRepository: { replace: h.replace, findLive: h.findLive, consume: h.consume },
  };
});
vi.mock('@server/security/tokenEncryption', () => ({
  encryptToken: h.encryptToken,
  decryptToken: h.decryptToken,
}));
vi.mock('./lakeAppClient', () => ({ revokeInstallerToken: h.revokeInstallerToken }));

import {
  requireGitHubLakeFlowNonce,
  storeGitHubLakeAuthGrant,
  readGitHubLakeUserToken,
  consumeGitHubLakeAuthGrant,
  GITHUB_LAKE_AUTH_GRANT_TTL_MS,
} from './githubLakeAuthGrant';
import type { GitHubLakeAppConfig } from './lakeAppClient';

const CONFIG: GitHubLakeAppConfig = {
  appId: 'app-1',
  slug: 'test-lake-app',
  privateKey: 'key',
  clientId: 'client-1',
  clientSecret: 'secret-1',
};

const GRANT = {
  _id: 'grant1',
  nonceHash: 'nonce-hash-a',
  userId: 'user-1',
  dataLakeId: 'lake1',
  encryptedToken: 'enc(user-token)',
  expiresAt: new Date(Date.now() + GITHUB_LAKE_AUTH_GRANT_TTL_MS),
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('requireGitHubLakeFlowNonce', () => {
  it('returns the nonce hash unchanged when present', () => {
    expect(requireGitHubLakeFlowNonce('nonce-hash-a')).toBe('nonce-hash-a');
  });

  it('403s when the browser has no nonce cookie for the flow', () => {
    expect(() => requireGitHubLakeFlowNonce(null)).toThrow(/GitHub authorization expired/i);
    try {
      requireGitHubLakeFlowNonce(null);
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).toBe(403);
    }
  });
});

describe('storeGitHubLakeAuthGrant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.encryptToken.mockReturnValue('enc(user-token)');
    h.replace.mockResolvedValue(null);
    h.decryptToken.mockReturnValue('old-token');
    h.revokeInstallerToken.mockResolvedValue(undefined);
  });

  it('encrypts the token and upserts the grant keyed by nonceHash', async () => {
    await storeGitHubLakeAuthGrant(CONFIG, {
      nonceHash: 'nonce-hash-a',
      userId: 'user-1',
      dataLakeId: 'lake1',
      userToken: 'user-token',
    });
    expect(h.encryptToken).toHaveBeenCalledWith('user-token');
    expect(h.replace).toHaveBeenCalledWith(
      expect.objectContaining({
        nonceHash: 'nonce-hash-a',
        userId: 'user-1',
        dataLakeId: 'lake1',
        encryptedToken: 'enc(user-token)',
      })
    );
    expect(h.replace.mock.calls[0][0].expiresAt).toBeInstanceOf(Date);
  });

  it('throws when the token cannot be encrypted, and stores nothing', async () => {
    h.encryptToken.mockReturnValue(null);
    await expect(
      storeGitHubLakeAuthGrant(CONFIG, {
        nonceHash: 'nonce-hash-a',
        userId: 'user-1',
        dataLakeId: 'lake1',
        userToken: 'user-token',
      })
    ).rejects.toThrow(/could not secure/i);
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('revokes a replaced grant token (a second authorize in the same flow supersedes the first)', async () => {
    h.replace.mockResolvedValue({ ...GRANT, encryptedToken: 'enc(old-token)' });
    h.decryptToken.mockReturnValue('old-token');
    await storeGitHubLakeAuthGrant(CONFIG, {
      nonceHash: 'nonce-hash-a',
      userId: 'user-1',
      dataLakeId: 'lake1',
      userToken: 'new-token',
    });
    expect(h.revokeInstallerToken).toHaveBeenCalledWith(CONFIG, 'old-token');
  });

  it('revokes nothing when there was no prior grant to replace', async () => {
    h.replace.mockResolvedValue(null);
    await storeGitHubLakeAuthGrant(CONFIG, {
      nonceHash: 'nonce-hash-a',
      userId: 'user-1',
      dataLakeId: 'lake1',
      userToken: 'user-token',
    });
    expect(h.revokeInstallerToken).not.toHaveBeenCalled();
  });
});

describe('readGitHubLakeUserToken', () => {
  const USER = { id: 'user-1' };

  beforeEach(() => {
    vi.clearAllMocks();
    h.findLive.mockResolvedValue(GRANT);
    h.decryptToken.mockReturnValue('user-token');
  });

  it('decrypts and returns the live grant token for the matching user and lake', async () => {
    await expect(readGitHubLakeUserToken('nonce-hash-a', USER, 'lake1')).resolves.toBe('user-token');
    expect(h.findLive).toHaveBeenCalledWith('nonce-hash-a');
    expect(h.decryptToken).toHaveBeenCalledWith(GRANT.encryptedToken);
  });

  it('403s when no live grant matches the nonce', async () => {
    h.findLive.mockResolvedValue(null);
    await expect(readGitHubLakeUserToken('nonce-hash-a', USER, 'lake1')).rejects.toMatchObject({ statusCode: 403 });
  });

  // Load-bearing: a grant minted for a different user or lake must never be handed back, even
  // if its nonceHash somehow collided or was replayed.
  it('403s a user mismatch', async () => {
    await expect(readGitHubLakeUserToken('nonce-hash-a', { id: 'user-2' }, 'lake1')).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('403s a lake mismatch', async () => {
    await expect(readGitHubLakeUserToken('nonce-hash-a', USER, 'lake-other')).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('403s when the stored token fails to decrypt', async () => {
    h.decryptToken.mockReturnValue(null);
    await expect(readGitHubLakeUserToken('nonce-hash-a', USER, 'lake1')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('consumeGitHubLakeAuthGrant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.decryptToken.mockReturnValue('user-token');
    h.revokeInstallerToken.mockResolvedValue(undefined);
  });

  it('deletes the grant and revokes its token', async () => {
    h.consume.mockResolvedValue(GRANT);
    await consumeGitHubLakeAuthGrant(CONFIG, 'nonce-hash-a');
    expect(h.consume).toHaveBeenCalledWith('nonce-hash-a');
    expect(h.revokeInstallerToken).toHaveBeenCalledWith(CONFIG, 'user-token');
  });

  it('is a no-op when another request already consumed the grant', async () => {
    h.consume.mockResolvedValue(null);
    await consumeGitHubLakeAuthGrant(CONFIG, 'nonce-hash-a');
    expect(h.revokeInstallerToken).not.toHaveBeenCalled();
  });

  it('swallows (and logs) a revoke failure instead of throwing', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    h.consume.mockResolvedValue(GRANT);
    h.revokeInstallerToken.mockRejectedValue(new Error('GitHub is down'));
    await expect(consumeGitHubLakeAuthGrant(CONFIG, 'nonce-hash-a')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not revoke/i), expect.any(Object));
    warn.mockRestore();
  });

  it('swallows a decryption failure as well, since nothing holds the token any more', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    h.consume.mockResolvedValue(GRANT);
    h.decryptToken.mockImplementation(() => {
      throw new Error('bad ciphertext');
    });
    await expect(consumeGitHubLakeAuthGrant(CONFIG, 'nonce-hash-a')).resolves.toBeUndefined();
    expect(h.revokeInstallerToken).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
