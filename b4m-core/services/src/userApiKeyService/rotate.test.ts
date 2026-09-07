import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import { rotateUserApiKey } from './rotate';

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

  it('refuses on a partial overlap, not just a total mismatch', async () => {
    const adapters = makeAdapters(key({ scopes: [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.ADMIN] }), [
      ApiKeyScope.READ_NOTEBOOKS,
    ]);

    await expect(rotateUserApiKey('owner-1', { keyId: 'k1' }, adapters as never)).rejects.toThrow(/scopes/i);
  });
});
