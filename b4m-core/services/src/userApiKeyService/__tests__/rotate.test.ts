import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { createUserApiKey } from '../create';
import { rotateUserApiKey } from '../rotate';
import { validateUserApiKey } from '../validate';
import { ApiKeyScope, CreditHolderType } from '@bike4mind/common';
import type { IUserApiKeyDocument } from '@bike4mind/common';
import { KEY_PREFIX_LENGTH } from '../constants';

vi.mock('bcryptjs', async () => {
  const { bcryptMockFactory } = await import('./helpers/bcryptMock');
  return bcryptMockFactory();
});

// Shared in-memory store that wires create / rotate / validate together
function makeSyncedRepo() {
  let stored: IUserApiKeyDocument | null = null;

  const repo = {
    countActiveByUserId: vi.fn().mockResolvedValue(0),
    countActiveByProductId: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation((doc: Record<string, unknown>) => {
      stored = { ...doc, id: 'key-1', createdAt: new Date() } as unknown as IUserApiKeyDocument;
      return Promise.resolve(stored);
    }),
    // rotate.ts mutates apiKey in place then calls update - the mutation lands on `stored` too
    findByUserIdAndId: vi.fn().mockImplementation(() => Promise.resolve(stored)),
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

describe('rotateUserApiKey — round-trip regression guard', () => {
  it('rotated key validates successfully and prefix length matches KEY_PREFIX_LENGTH', async () => {
    const { repo, getStored } = makeSyncedRepo();
    const adapters = {
      db: {
        userApiKeys: repo as any,
        agents: { findById: vi.fn().mockResolvedValue({ organizationId: 'org-1', userId: 'user1' }) } as any,
      },
    };

    const { key: originalKey } = await createUserApiKey('sys-1', mintParams, {
      ...adapters,
      systemUserId: 'sys-1',
    });

    const { key: rotatedKey } = await rotateUserApiKey('sys-1', { keyId: 'key-1' }, adapters);

    expect(rotatedKey).not.toBe(originalKey);
    expect(rotatedKey).toMatch(/^b4m_live_/);

    // Regression guard: stored prefix must be KEY_PREFIX_LENGTH chars so validate can find it
    expect(getStored()!.keyPrefix).toHaveLength(KEY_PREFIX_LENGTH);
    expect(getStored()!.keyPrefix).toBe(rotatedKey.substring(0, KEY_PREFIX_LENGTH));

    const result = await validateUserApiKey(rotatedKey, adapters);
    expect(result.isValid).toBe(true);
    expect(result.keyId).toBe('key-1');
  });

  it('rotation preserves spendCap and accumulated spend (rotating the secret must not reset the meter)', async () => {
    const { repo, getStored } = makeSyncedRepo();
    const adapters = {
      db: {
        userApiKeys: repo as any,
        agents: { findById: vi.fn().mockResolvedValue({ organizationId: 'org-1', userId: 'user1' }) } as any,
      },
    };

    await createUserApiKey(
      'sys-1',
      {
        name: 'embed-key',
        scopes: [ApiKeyScope.EMBED_CHAT],
        metadata: { createdFrom: 'dashboard' as const },
        agentId: 'agent-1',
        billingOwnerType: CreditHolderType.Organization,
        organizationId: 'org-1',
        spendCap: 5000,
      },
      { ...adapters, systemUserId: 'sys-1' }
    );

    // Simulate spend accumulated before the rotation
    getStored()!.usage.totalSpendCredits = 4200;

    await rotateUserApiKey('sys-1', { keyId: 'key-1' }, adapters);

    expect(getStored()!.spendCap).toBe(5000);
    expect(getStored()!.usage.totalSpendCredits).toBe(4200);
  });

  it('rotation stores the SHA-256 digest of the new key and never returns it', async () => {
    const { repo, getStored } = makeSyncedRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = { db: { userApiKeys: repo as any, organizations: {} as any } };

    await createUserApiKey('sys-1', mintParams, { ...adapters, systemUserId: 'sys-1' });
    delete getStored()!.keyDigest; // a key minted before the digest existed

    const result = await rotateUserApiKey('sys-1', { keyId: 'key-1' }, adapters);
    const digest = createHash('sha256').update(result.key).digest('hex');

    expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'key-1', keyDigest: digest }));
    expect(getStored()!.keyDigest).toBe(digest);
    expect(result).not.toHaveProperty('keyDigest');
    expect(result).not.toHaveProperty('keyHash');
  });

  it('original key is invalid after rotation', async () => {
    const { repo } = makeSyncedRepo();
    const adapters = {
      db: {
        userApiKeys: repo as any,
        agents: { findById: vi.fn().mockResolvedValue({ organizationId: 'org-1', userId: 'user1' }) } as any,
      },
    };

    const { key: originalKey } = await createUserApiKey('sys-1', mintParams, {
      ...adapters,
      systemUserId: 'sys-1',
    });

    await rotateUserApiKey('sys-1', { keyId: 'key-1' }, adapters);

    const result = await validateUserApiKey(originalKey, adapters);
    expect(result.isValid).toBe(false);
  });

  // #909: an org admin can rotate a key billed to an org they administer, even a
  // key they did not mint - resolved via the org-admin fallback.
  describe('org-admin rotate (#909)', () => {
    it('rotates a teammate org key when the caller administers its billing org', async () => {
      const stored = {
        id: 'key-1',
        name: 'Org embed key',
        userId: 'minter',
        keyPrefix: 'b4m_live_orig000',
      } as unknown as IUserApiKeyDocument;
      const repo = {
        findByUserIdAndId: vi.fn().mockResolvedValue(null),
        findByOrganizationIdsAndId: vi.fn().mockResolvedValue(stored),
        update: vi.fn().mockResolvedValue(undefined),
        setCallbackSigningSecret: vi.fn().mockResolvedValue(undefined),
      };
      const orgs = { findIdsAdministeredBy: vi.fn().mockResolvedValue(['org-1']) };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapters = { db: { userApiKeys: repo as any, organizations: orgs as any } };

      const { key, previousOwnerUserId, callbackSigningSecret } = await rotateUserApiKey(
        'admin-user',
        { keyId: 'key-1' },
        adapters
      );

      expect(orgs.findIdsAdministeredBy).toHaveBeenCalledWith('admin-user');
      expect(repo.findByOrganizationIdsAndId).toHaveBeenCalledWith(['org-1'], 'key-1');
      expect(key).toMatch(/^b4m_live_/);
      expect(repo.update).toHaveBeenCalledWith({
        id: 'key-1',
        keyHash: expect.any(String),
        keyDigest: expect.any(String),
        keyPrefix: expect.any(String),
        userId: 'admin-user',
      });

      // The rotated credential must authenticate as the admin who now holds it,
      // not as the teammate who minted it.
      expect(stored.userId).toBe('admin-user');
      expect(previousOwnerUserId).toBe('minter');

      // The minter knew the old callback signing secret; a re-owned key must not keep it.
      expect(callbackSigningSecret).toMatch(/^whsec_/);
      expect(repo.setCallbackSigningSecret).toHaveBeenCalledWith('key-1', callbackSigningSecret, expect.any(Date));
    });

    it('leaves ownership alone when the minter rotates their own key', async () => {
      const stored = {
        id: 'key-1',
        name: 'Own key',
        userId: 'minter',
        keyPrefix: 'b4m_live_orig000',
      } as unknown as IUserApiKeyDocument;
      const repo = {
        findByUserIdAndId: vi.fn().mockResolvedValue(stored),
        findByOrganizationIdsAndId: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue(undefined),
        setCallbackSigningSecret: vi.fn().mockResolvedValue(undefined),
      };
      const orgs = { findIdsAdministeredBy: vi.fn().mockResolvedValue([]) };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapters = { db: { userApiKeys: repo as any, organizations: orgs as any } };

      const result = await rotateUserApiKey('minter', { keyId: 'key-1' }, adapters);

      expect(stored.userId).toBe('minter');
      expect(result.previousOwnerUserId).toBeUndefined();
      expect(repo.update).toHaveBeenCalledWith({
        id: 'key-1',
        keyHash: expect.any(String),
        keyDigest: expect.any(String),
        keyPrefix: expect.any(String),
      });
      // The owner's receivers keep verifying: their own rotation leaves the signing secret alone.
      expect(result.callbackSigningSecret).toBeUndefined();
      expect(repo.setCallbackSigningSecret).not.toHaveBeenCalled();
    });

    it('throws NotFound when the caller neither minted nor administers the key', async () => {
      const repo = {
        findByUserIdAndId: vi.fn().mockResolvedValue(null),
        findByOrganizationIdsAndId: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue(undefined),
      };
      const orgs = { findIdsAdministeredBy: vi.fn().mockResolvedValue([]) };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapters = { db: { userApiKeys: repo as any, organizations: orgs as any } };

      await expect(rotateUserApiKey('other-user', { keyId: 'key-1' }, adapters)).rejects.toThrow(/not found/);
      expect(repo.update).not.toHaveBeenCalled();
    });
  });
});

/**
 * Rotation returns a working plaintext credential, so it is an escalation primitive
 * unless the caller already holds the target key's scopes.
 */

const key = (over: Record<string, unknown> = {}) => ({
  id: 'k1',
  name: 'a key',
  userId: 'owner-1',
  keyPrefix: 'b4m_live_aaaa',
  keyHash: 'old-hash',
  scopes: [ApiKeyScope.READ_NOTEBOOKS],
  ...over,
});

const makeAdapters = (stored: Record<string, unknown>, callerScopes?: ApiKeyScope[]) => ({
  db: {
    userApiKeys: {
      findByUserIdAndId: vi.fn().mockResolvedValue(stored),
      findByOrganizationIdsAndId: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(stored),
      setCallbackSigningSecret: vi.fn().mockResolvedValue(undefined),
    } as never,
    organizations: { findIdsAdministeredBy: vi.fn().mockResolvedValue([]) },
  },
  ...(callerScopes ? { callerScopes } : {}),
});

describe('rotateUserApiKey - no escalation by rotation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses an API-key caller rotating a key with scopes it does not hold', async () => {
    const adapters = makeAdapters(key({ scopes: [ApiKeyScope.ADMIN] }), [ApiKeyScope.READ_NOTEBOOKS]);

    await expect(rotateUserApiKey('owner-1', { keyId: 'k1' }, adapters as never)).rejects.toThrow(
      /scopes the calling key does not have/i
    );
    expect(adapters.db.userApiKeys.update).not.toHaveBeenCalled();
  });

  it('allows an API-key caller rotating a key whose scopes it already holds', async () => {
    const adapters = makeAdapters(key({ scopes: [ApiKeyScope.READ_NOTEBOOKS] }), [
      ApiKeyScope.READ_NOTEBOOKS,
      ApiKeyScope.AI_CHAT,
    ]);

    const result = await rotateUserApiKey('owner-1', { keyId: 'k1' }, adapters as never);

    expect(result.key).toMatch(/^b4m_live_/);
    expect(adapters.db.userApiKeys.update).toHaveBeenCalled();
  });

  it('leaves a browser/JWT caller unrestricted - they are already the whole account', async () => {
    const adapters = makeAdapters(key({ scopes: [ApiKeyScope.ADMIN] }));

    const result = await rotateUserApiKey('owner-1', { keyId: 'k1' }, adapters as never);

    expect(result.key).toMatch(/^b4m_live_/);
  });

  it('denies an empty-scope caller rotating any scoped key (fail-closed, not read as unrestricted)', async () => {
    // The empty array is truthy, so it MUST enter the containment check and deny. Guards
    // against a "simplify to a truthiness/length test" cleanup silently reopening fail-open.
    const adapters = makeAdapters(key({ scopes: [ApiKeyScope.READ_NOTEBOOKS] }), []);

    await expect(rotateUserApiKey('owner-1', { keyId: 'k1' }, adapters as never)).rejects.toThrow(/scopes/i);
    expect(adapters.db.userApiKeys.update).not.toHaveBeenCalled();
  });

  it('refuses on a partial overlap, not just a total mismatch', async () => {
    const adapters = makeAdapters(key({ scopes: [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.ADMIN] }), [
      ApiKeyScope.READ_NOTEBOOKS,
    ]);

    await expect(rotateUserApiKey('owner-1', { keyId: 'k1' }, adapters as never)).rejects.toThrow(/scopes/i);
  });

  it('refuses an admin:*-scoped API-key caller rotating a key holding a scope it does not literally list', async () => {
    // admin:* is deliberately not treated as a superset for rotation - containment is literal.
    const adapters = makeAdapters(key({ scopes: [ApiKeyScope.READ_NOTEBOOKS] }), [ApiKeyScope.ADMIN]);

    await expect(rotateUserApiKey('owner-1', { keyId: 'k1' }, adapters as never)).rejects.toThrow(
      /scopes the calling key does not have/i
    );
    expect(adapters.db.userApiKeys.update).not.toHaveBeenCalled();
  });
});

/**
 * An embed:chat key's userId is the embed runtime's identity, not just an owner label:
 * the bound agent's ownership check AND the owner's BYOK LLM keys, tools and KB all
 * resolve from it. A cross-owner rotation therefore corrupts the public widget, so it is
 * refused outright - only the owner rotating their own key passes.
 */
describe('rotateUserApiKey - embed:chat re-ownership binding guard', () => {
  beforeEach(() => vi.clearAllMocks());

  const embedKey = (over: Record<string, unknown> = {}) =>
    key({ scopes: [ApiKeyScope.EMBED_CHAT], agentId: 'agent-1', organizationId: 'org-1', ...over });

  const makeEmbedAdapters = (stored: Record<string, unknown>) => ({
    db: {
      userApiKeys: {
        findByUserIdAndId: vi.fn().mockResolvedValue(stored),
        findByOrganizationIdsAndId: vi.fn().mockResolvedValue(stored),
        update: vi.fn().mockResolvedValue(stored),
        setCallbackSigningSecret: vi.fn().mockResolvedValue(undefined),
      } as never,
      organizations: { findIdsAdministeredBy: vi.fn().mockResolvedValue(['org-1']) },
    },
  });

  it('refuses re-owning an agent-bound embed key when the agent is the owner personal (loud widget break)', async () => {
    // Re-owning to admin-2 would 403 the widget: the bound agent is owner-1's personal
    // agent, so isAgentOwnedByEmbedKey fails for the new owner.
    const adapters = makeEmbedAdapters(embedKey());

    await expect(rotateUserApiKey('admin-2', { keyId: 'k1' }, adapters as never)).rejects.toThrow(
      /cannot rotate this embed key to a new owner/i
    );
    expect(adapters.db.userApiKeys.update).not.toHaveBeenCalled();
  });

  it('refuses re-owning an agent-bound embed key even when the agent is org-shared (silent BYOK/tool/KB swap)', async () => {
    // The ownership check still passes for an org-shared agent, so the pre-fix code
    // re-owned and silently repointed the widget to the rotator's BYOK keys, tools and
    // KB. The guard no longer inspects the agent - any cross-owner re-own is refused.
    const adapters = makeEmbedAdapters(embedKey({ organizationId: 'org-1' }));

    await expect(rotateUserApiKey('admin-2', { keyId: 'k1' }, adapters as never)).rejects.toThrow(
      /cannot rotate this embed key to a new owner/i
    );
    expect(adapters.db.userApiKeys.update).not.toHaveBeenCalled();
  });

  it('allows the owner to rotate their own embed key (no re-owning)', async () => {
    const adapters = makeEmbedAdapters(embedKey());

    const result = await rotateUserApiKey('owner-1', { keyId: 'k1' }, adapters as never);

    expect(result.key).toMatch(/^b4m_live_/);
    expect(adapters.db.userApiKeys.update).toHaveBeenCalled();
  });

  it('does not gate re-owning a non-embed key on the agent binding', async () => {
    // A stray agentId on a non-embed key must not drag in the embed guard.
    const adapters = makeEmbedAdapters(key({ scopes: [ApiKeyScope.READ_NOTEBOOKS], agentId: 'agent-1' }));

    const result = await rotateUserApiKey('admin-2', { keyId: 'k1' }, adapters as never);

    expect(result.previousOwnerUserId).toBe('owner-1');
    expect(adapters.db.userApiKeys.update).toHaveBeenCalled();
  });
});
