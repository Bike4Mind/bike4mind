import { describe, it, expect, vi } from 'vitest';
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
  };

  return { repo, getStored: () => stored };
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
  const { repo, getStored } = makeSyncedRepo();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapters = { db: { userApiKeys: repo as any } };

  const { key } = await createUserApiKey('sys-1', mintParams, {
    ...adapters,
    systemUserId: 'sys-1',
  });

  getStored()!.keyPrefix = key.substring(0, 12); // legacy prefix length

  return { key, repo, getStored, adapters };
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

    expect(repo.update).toHaveBeenCalled();
    expect(getStored()!.keyPrefix).toBe(key.substring(0, KEY_PREFIX_LENGTH));
  });

  it('does not self-heal the prefix of an expired legacy key (only valid keys are healed)', async () => {
    const { key, repo, getStored, adapters } = await mintLegacyKey();
    getStored()!.expiresAt = new Date(Date.now() - 1000);

    const result = await validateUserApiKey(key, adapters);

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('expired');
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects a wrong key that collides on the legacy prefix', async () => {
    const { key, repo, adapters } = await mintLegacyKey();

    // Same first 12 chars, different remainder -> prefix lookup hits, bcrypt must reject
    const impostor = key.substring(0, 12) + 'f'.repeat(key.length - 12);
    const result = await validateUserApiKey(impostor, adapters);

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('invalid_hash');
    // Must NOT self-heal the prefix from a failed validation
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('still rejects unknown keys when both prefix lookups miss', async () => {
    const { adapters } = await mintLegacyKey();

    const result = await validateUserApiKey('b4m_live_' + '0'.repeat(32), adapters);

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('does not touch the stored prefix for current-format keys', async () => {
    const { repo, getStored } = makeSyncedRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any } };

    const { key } = await createUserApiKey('sys-1', mintParams, {
      ...adapters,
      systemUserId: 'sys-1',
    });

    const result = await validateUserApiKey(key, adapters);

    expect(result.isValid).toBe(true);
    expect(repo.update).not.toHaveBeenCalled();
    expect(getStored()!.keyPrefix).toHaveLength(KEY_PREFIX_LENGTH);
  });
});

describe('validateUserApiKey - embed context fields', () => {
  it('flows agentId and allowedOrigins through for an embed:chat key', async () => {
    const { repo } = makeSyncedRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any } };

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

  it('leaves embed fields undefined for a non-embed key', async () => {
    const { repo } = makeSyncedRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any } };

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { repo, adapters: { db: { userApiKeys: repo as any } } };
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
