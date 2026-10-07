import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'crypto';
import bcrypt from 'bcryptjs';
import { createUserApiKey } from '../create';
import { validateUserApiKey, validateUserApiKeyById } from '../validate';
import { ApiKeyScope, ApiKeyStatus, CreditHolderType } from '@bike4mind/common';
import type { IUserApiKeyDocument } from '@bike4mind/common';
import { KEY_PREFIX_LENGTH } from '../constants';

vi.mock('bcryptjs', async () => {
  const { bcryptMockFactory } = await import('./helpers/bcryptMock');
  return bcryptMockFactory();
});

// Shared in-memory store that wires create / validate together (same pattern as rotate.test.ts)
function makeSyncedRepo() {
  let stored: IUserApiKeyDocument | null = null;

  const repo = {
    countActiveByUserId: vi.fn().mockResolvedValue(0),
    countActiveByProductId: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation((doc: Record<string, unknown>) => {
      stored = { ...doc, id: 'key-1', createdAt: new Date() } as unknown as IUserApiKeyDocument;
      return Promise.resolve(stored);
    }),
    update: vi.fn().mockResolvedValue(undefined),
    findActiveByKeyPrefix: vi
      .fn()
      .mockImplementation((prefix: string) => Promise.resolve(stored?.keyPrefix === prefix ? stored : null)),
    updateLastUsed: vi.fn().mockResolvedValue(undefined),
    // Both heals mirror the Mongo filter in UserApiKeyModel: they only land while the hash the
    // caller validated against is still the stored one.
    setKeyDigest: vi.fn().mockImplementation((_id: string, keyDigest: string, expectedKeyHash: string) => {
      if (stored && stored.keyHash === expectedKeyHash && !stored.keyDigest) stored.keyDigest = keyDigest;
      return Promise.resolve();
    }),
    healKeyPrefix: vi.fn().mockImplementation((_id: string, keyPrefix: string, expectedKeyHash: string) => {
      if (stored && stored.keyHash === expectedKeyHash) stored.keyPrefix = keyPrefix;
      return Promise.resolve();
    }),
  };

  return {
    repo,
    getStored: () => stored,
    setStored: (doc: IUserApiKeyDocument) => {
      stored = doc;
    },
  };
}

const mintParams = {
  name: 'test-key',
  scopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE],
  metadata: { createdFrom: 'overwatch-admin' as const },
  productId: 'vibeswire',
};

/**
 * Mints a key, then rewrites the stored keyPrefix to the legacy 12-char length
 * used by create.ts/validate.ts before Jun 2026 (KEY_PREFIX_LENGTH was 12).
 * Keys minted back then are stored in Mongo with 12-char prefixes and cannot
 * be re-derived from the bcrypt keyHash - validate must fall back to a
 * 12-char lookup or every pre-existing key 401s.
 */
async function mintLegacyKey() {
  const { repo, getStored, setStored } = makeSyncedRepo();

  const adapters = {
    db: {
      userApiKeys: repo as any,
      agents: { findById: vi.fn().mockResolvedValue({ organizationId: 'org-1', userId: 'user1' }) } as any,
    },
  };

  const { key } = await createUserApiKey('sys-1', mintParams, {
    ...adapters,
    systemUserId: 'sys-1',
  });

  getStored()!.keyPrefix = key.substring(0, 12); // legacy prefix length

  return { key, repo, getStored, setStored, adapters };
}

describe('validateUserApiKey — legacy 12-char prefix fallback', () => {
  it('validates a key stored with a legacy 12-char prefix', async () => {
    const { key, adapters } = await mintLegacyKey();

    const result = await validateUserApiKey(key, adapters);

    expect(result.isValid).toBe(true);
    expect(result.keyId).toBe('key-1');
  });

  it('self-heals the stored prefix to KEY_PREFIX_LENGTH on successful validation', async () => {
    const { key, repo, getStored, adapters } = await mintLegacyKey();

    await validateUserApiKey(key, adapters);

    expect(repo.healKeyPrefix).toHaveBeenCalledWith('key-1', key.substring(0, KEY_PREFIX_LENGTH), getStored()!.keyHash);
    expect(getStored()!.keyPrefix).toBe(key.substring(0, KEY_PREFIX_LENGTH));
  });

  it('does not self-heal the prefix of an expired legacy key (only valid keys are healed)', async () => {
    const { key, repo, getStored, adapters } = await mintLegacyKey();
    getStored()!.expiresAt = new Date(Date.now() - 1000);

    const result = await validateUserApiKey(key, adapters);

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('expired');
    expect(repo.healKeyPrefix).not.toHaveBeenCalled();
  });

  it('rejects a wrong key that collides on the legacy prefix', async () => {
    const { key, repo, adapters } = await mintLegacyKey();

    // Same first 12 chars, different remainder -> prefix lookup hits, bcrypt must reject
    const impostor = key.substring(0, 12) + 'f'.repeat(key.length - 12);
    const result = await validateUserApiKey(impostor, adapters);

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('invalid_hash');
    // Must NOT self-heal the prefix from a failed validation
    expect(repo.healKeyPrefix).not.toHaveBeenCalled();
  });

  // A rotation that commits during the bcrypt compare: the request validated K1 against the hash
  // it loaded, but by the time its heals fire the doc holds K2. Unguarded, the late writes left
  // keyPrefix = K1's and keyDigest = D(K1) beside H(K2), so the rotated-away key authenticated on
  // the digest path indefinitely and K2 never did.
  it('does not let a heal racing a rotation revive the rotated-away key', async () => {
    const { key, repo, getStored, setStored, adapters } = await mintLegacyKey();
    delete getStored()!.keyDigest;
    const loaded = getStored()!;
    const rotated = {
      ...loaded,
      keyHash: '$2b$12$rotatedrotatedrotatedr',
      keyDigest: 'b'.repeat(64),
      keyPrefix: 'b4m_live_rotated',
    } as IUserApiKeyDocument;
    const realCompare = bcrypt.compare;
    const compare = vi.spyOn(bcrypt, 'compare').mockImplementation(async (...args: Parameters<typeof realCompare>) => {
      const ok = await realCompare(...args);
      setStored(rotated);
      return ok;
    });

    const result = await validateUserApiKey(key, adapters);
    await new Promise(resolve => setImmediate(resolve));

    expect(result.isValid).toBe(true); // K1 was valid when the request read it
    expect(repo.healKeyPrefix).toHaveBeenCalledWith('key-1', key.substring(0, KEY_PREFIX_LENGTH), loaded.keyHash);
    expect(repo.setKeyDigest).toHaveBeenCalledWith('key-1', expect.any(String), loaded.keyHash);
    expect(getStored()).toMatchObject({ keyDigest: 'b'.repeat(64), keyPrefix: 'b4m_live_rotated' });
    expect(await validateUserApiKey(key, adapters)).toMatchObject({ isValid: false });
    compare.mockRestore();
  });

  it('still rejects unknown keys when both prefix lookups miss', async () => {
    const { adapters } = await mintLegacyKey();

    const result = await validateUserApiKey('b4m_live_' + '0'.repeat(32), adapters);

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('does not touch the stored prefix for current-format keys', async () => {
    const { repo, getStored } = makeSyncedRepo();

    const adapters = {
      db: {
        userApiKeys: repo as any,
        agents: { findById: vi.fn().mockResolvedValue({ organizationId: 'org-1', userId: 'user1' }) } as any,
      },
    };

    const { key } = await createUserApiKey('sys-1', mintParams, {
      ...adapters,
      systemUserId: 'sys-1',
    });

    const result = await validateUserApiKey(key, adapters);

    expect(result.isValid).toBe(true);
    expect(repo.healKeyPrefix).not.toHaveBeenCalled();
    expect(getStored()!.keyPrefix).toHaveLength(KEY_PREFIX_LENGTH);
  });
});

describe('validateUserApiKey - embed context fields', () => {
  it('flows agentId and allowedOrigins through for an embed:chat key', async () => {
    const { repo } = makeSyncedRepo();

    const adapters = {
      db: {
        userApiKeys: repo as any,
        agents: { findById: vi.fn().mockResolvedValue({ organizationId: 'org-1', userId: 'user1' }) } as any,
      },
    };

    const { key } = await createUserApiKey(
      'sys-1',
      {
        name: 'embed-key',
        scopes: [ApiKeyScope.EMBED_CHAT],
        agentId: 'agent-1',
        billingOwnerType: CreditHolderType.Organization,
        organizationId: 'org-1',
        allowedOrigins: ['https://example.com'],
        branding: { displayName: 'Acme', primaryColor: '#336699', hideBranding: true },
        metadata: { createdFrom: 'dashboard' as const },
      },
      { ...adapters, systemUserId: 'sys-1' }
    );

    const result = await validateUserApiKey(key, adapters);

    expect(result.isValid).toBe(true);
    expect(result.agentId).toBe('agent-1');
    expect(result.allowedOrigins).toEqual(['https://example.com']);
    // The serve route reads branding off this projection; dropping it from
    // finalizeApiKeyValidation silently un-themes every widget.
    expect(result.branding).toEqual({ displayName: 'Acme', primaryColor: '#336699', hideBranding: true });
  });

  it('carries preauthorizedLakeIds through the projection', async () => {
    const { repo } = makeSyncedRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any } };

    const { key } = await createUserApiKey(
      'sys-1',
      { ...mintParams, preauthorizedLakeIds: ['lake-a', 'lake-b'] },
      { ...adapters, systemUserId: 'sys-1' }
    );

    const result = await validateUserApiKey(key, adapters);

    // apiKeyAuth copies this onto req.apiKeyInfo and /api/sessions/create refuses every lake the
    // key is not bound to, so dropping it here silently un-binds every key that has a binding.
    expect(result.preauthorizedLakeIds).toEqual(['lake-a', 'lake-b']);
  });

  it('leaves embed fields undefined for a non-embed key', async () => {
    const { repo } = makeSyncedRepo();

    const adapters = {
      db: {
        userApiKeys: repo as any,
        agents: { findById: vi.fn().mockResolvedValue({ organizationId: 'org-1', userId: 'user1' }) } as any,
      },
    };

    const { key } = await createUserApiKey('sys-1', mintParams, {
      ...adapters,
      systemUserId: 'sys-1',
    });

    const result = await validateUserApiKey(key, adapters);

    expect(result.isValid).toBe(true);
    expect(result.agentId).toBeUndefined();
    expect(result.allowedOrigins).toBeUndefined();
    expect(result.branding).toBeUndefined();
  });
});

describe('validateUserApiKeyById + shared finalize gates', () => {
  // The by-id path (embed session token) loads via findById, which is NOT pre-filtered
  // to ACTIVE/non-expired the way findActiveByKeyPrefix is - so this is the ONLY path
  // that actually exercises finalizeApiKeyValidation's expiry + status gates. Without
  // these cases a dropped gate passes CI silently (confirmed by mutation testing).
  const baseDoc = {
    id: 'key-1',
    userId: 'u1',
    scopes: [ApiKeyScope.EMBED_CHAT],
    rateLimit: { requestsPerMinute: 10, requestsPerDay: 100 },
    status: ApiKeyStatus.ACTIVE,
    agentId: 'agent-1',
    allowedOrigins: ['https://example.com'],
    branding: { hideBranding: true },
  } as unknown as IUserApiKeyDocument;

  function repoWith(doc: IUserApiKeyDocument | null) {
    const repo = {
      findById: vi.fn().mockResolvedValue(doc),
      updateLastUsed: vi.fn().mockResolvedValue(undefined),
    };

    return {
      repo,
      adapters: {
        db: {
          userApiKeys: repo as any,
          agents: { findById: vi.fn().mockResolvedValue({ organizationId: 'org-1', userId: 'user1' }) } as any,
        },
      },
    };
  }

  it('validates an active key located by id and bumps last-used', async () => {
    const { repo, adapters } = repoWith(baseDoc);
    const result = await validateUserApiKeyById('key-1', adapters);
    expect(result.isValid).toBe(true);
    expect(result.keyId).toBe('key-1');
    expect(result.agentId).toBe('agent-1');
    expect(result.branding).toEqual({ hideBranding: true });
    // updateLastUsed must fire on the token path too (the drift the refactor fixed).
    expect(repo.updateLastUsed).toHaveBeenCalledWith('key-1');
  });

  it('returns not_found when the id does not resolve', async () => {
    const { adapters } = repoWith(null);
    const result = await validateUserApiKeyById('missing', adapters);
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('rejects an expired key via the by-id path (finalize expiry gate)', async () => {
    const { repo, adapters } = repoWith({
      ...baseDoc,
      expiresAt: new Date(Date.now() - 1000),
    } as unknown as IUserApiKeyDocument);
    const result = await validateUserApiKeyById('key-1', adapters);
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('expired');
    expect(repo.updateLastUsed).not.toHaveBeenCalled();
  });

  it('rejects a disabled key via the by-id path (finalize status gate)', async () => {
    const { repo, adapters } = repoWith({
      ...baseDoc,
      status: ApiKeyStatus.DISABLED,
    } as unknown as IUserApiKeyDocument);
    const result = await validateUserApiKeyById('key-1', adapters);
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('disabled');
    expect(repo.updateLastUsed).not.toHaveBeenCalled();
  });
});

describe('validateUserApiKey - SHA-256 digest fast path', () => {
  const sha256 = (k: string) => createHash('sha256').update(k).digest('hex');

  async function mint() {
    const { repo, getStored } = makeSyncedRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any } };
    const { key } = await createUserApiKey('sys-1', mintParams, { ...adapters, systemUserId: 'sys-1' });
    return { key, repo, getStored, adapters };
  }

  it('validates a key with a stored digest without calling bcrypt', async () => {
    const { key, repo, getStored, adapters } = await mint();
    expect(getStored()!.keyDigest).toBe(sha256(key));
    const compare = vi.spyOn(bcrypt, 'compare');

    const result = await validateUserApiKey(key, adapters);

    expect(result.isValid).toBe(true);
    expect(result.keyId).toBe('key-1');
    expect(compare).not.toHaveBeenCalled();
    expect(repo.setKeyDigest).not.toHaveBeenCalled();
    compare.mockRestore();
  });

  it('rejects a wrong key sharing the prefix without falling back to bcrypt', async () => {
    const { key, repo, adapters } = await mint();
    const compare = vi.spyOn(bcrypt, 'compare');

    const impostor = key.substring(0, KEY_PREFIX_LENGTH) + 'f'.repeat(key.length - KEY_PREFIX_LENGTH);
    const result = await validateUserApiKey(impostor, adapters);

    expect(result).toEqual({ isValid: false, reason: 'invalid_hash' });
    expect(compare).not.toHaveBeenCalled();
    expect(repo.setKeyDigest).not.toHaveBeenCalled();
    expect(repo.updateLastUsed).not.toHaveBeenCalled();
    compare.mockRestore();
  });

  it('treats a malformed stored digest as a miss instead of throwing', async () => {
    const { key, getStored, adapters } = await mint();
    getStored()!.keyDigest = 'abc123';

    const result = await validateUserApiKey(key, adapters);

    expect(result).toEqual({ isValid: false, reason: 'invalid_hash' });
  });

  it('validates a pre-digest key via bcrypt and backfills its digest', async () => {
    const { key, repo, getStored, adapters } = await mint();
    delete getStored()!.keyDigest; // minted before the digest existed
    const compare = vi.spyOn(bcrypt, 'compare');

    const result = await validateUserApiKey(key, adapters);

    expect(result.isValid).toBe(true);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(repo.setKeyDigest).toHaveBeenCalledWith('key-1', sha256(key), getStored()!.keyHash);
    expect(getStored()!.keyDigest).toBe(sha256(key));

    // Migrated: the next request takes the fast path.
    compare.mockClear();
    expect((await validateUserApiKey(key, adapters)).isValid).toBe(true);
    expect(compare).not.toHaveBeenCalled();
    expect(repo.setKeyDigest).toHaveBeenCalledTimes(1);
    compare.mockRestore();
  });

  it('does not backfill a digest from a failed bcrypt check', async () => {
    const { key, repo, getStored, adapters } = await mint();
    delete getStored()!.keyDigest;

    const impostor = key.substring(0, KEY_PREFIX_LENGTH) + 'f'.repeat(key.length - KEY_PREFIX_LENGTH);
    const result = await validateUserApiKey(impostor, adapters);

    expect(result).toEqual({ isValid: false, reason: 'invalid_hash' });
    expect(repo.setKeyDigest).not.toHaveBeenCalled();
    expect(getStored()!.keyDigest).toBeUndefined();
  });

  it('does not backfill the digest of an expired pre-digest key', async () => {
    const { key, repo, getStored, adapters } = await mint();
    delete getStored()!.keyDigest;
    getStored()!.expiresAt = new Date(Date.now() - 1000);

    const result = await validateUserApiKey(key, adapters);

    expect(result.reason).toBe('expired');
    expect(repo.setKeyDigest).not.toHaveBeenCalled();
  });

  it('a failed digest backfill does not fail the request', async () => {
    const { key, repo, getStored, adapters } = await mint();
    delete getStored()!.keyDigest;
    repo.setKeyDigest.mockRejectedValueOnce(new Error('db down'));

    const result = await validateUserApiKey(key, adapters);

    expect(result.isValid).toBe(true);
  });

  it('never returns the digest or hash in the validation result', async () => {
    const { key, adapters } = await mint();

    const result = await validateUserApiKey(key, adapters);

    expect(result.isValid).toBe(true);
    expect(JSON.stringify(result)).not.toContain(sha256(key));
    expect(result).not.toHaveProperty('keyDigest');
    expect(result).not.toHaveProperty('keyHash');
  });
});
