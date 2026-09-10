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
});

/**
 * Re-owning an embed:chat key repoints the embed runtime's agent/BYOK/tool resolution
 * to the rotator, so the bound agent must be owned by the new owner or the rotation is
 * refused rather than allowed to corrupt the public widget.
 */
describe('rotateUserApiKey - embed:chat re-ownership binding guard', () => {
  beforeEach(() => vi.clearAllMocks());

  const embedKey = (over: Record<string, unknown> = {}) =>
    key({ scopes: [ApiKeyScope.EMBED_CHAT], agentId: 'agent-1', organizationId: 'org-1', ...over });

  const makeEmbedAdapters = (
    stored: Record<string, unknown>,
    agent: { userId?: string; organizationId?: string } | null | undefined
  ) => ({
    db: {
      userApiKeys: {
        findByUserIdAndId: vi.fn().mockResolvedValue(stored),
        findByOrganizationIdsAndId: vi.fn().mockResolvedValue(stored),
        update: vi.fn().mockResolvedValue(stored),
      } as never,
      organizations: { findIdsAdministeredBy: vi.fn().mockResolvedValue(['org-1']) },
      // `undefined` omits the adapter entirely, to prove the fail-closed path.
      ...(agent === undefined ? {} : { agents: { findById: vi.fn().mockResolvedValue(agent) } as never }),
    },
  });

  it('refuses re-owning to a rotator when the bound agent is not owned by them', async () => {
    // Agent belongs to the original owner personally; the org-admin rotator does not own it.
    const adapters = makeEmbedAdapters(embedKey(), { userId: 'owner-1' });

    await expect(rotateUserApiKey('admin-2', { keyId: 'k1' }, adapters as never)).rejects.toThrow(
      /bound agent is not owned by you/i
    );
    expect(adapters.db.userApiKeys.update).not.toHaveBeenCalled();
  });

  it('allows re-owning when the bound agent belongs to the org the key bills', async () => {
    const adapters = makeEmbedAdapters(embedKey(), { organizationId: 'org-1' });

    const result = await rotateUserApiKey('admin-2', { keyId: 'k1' }, adapters as never);

    expect(result.previousOwnerUserId).toBe('owner-1');
    expect(adapters.db.userApiKeys.update).toHaveBeenCalled();
  });

  it('fails closed when the agents adapter is absent on a re-owning embed rotation', async () => {
    const adapters = makeEmbedAdapters(embedKey(), undefined);

    await expect(rotateUserApiKey('admin-2', { keyId: 'k1' }, adapters as never)).rejects.toThrow(
      /agents adapter is required/i
    );
    expect(adapters.db.userApiKeys.update).not.toHaveBeenCalled();
  });

  it('skips the guard when the owner rotates their own embed key (no re-owning)', async () => {
    const adapters = makeEmbedAdapters(embedKey(), undefined);

    const result = await rotateUserApiKey('owner-1', { keyId: 'k1' }, adapters as never);

    expect(result.key).toMatch(/^b4m_live_/);
    expect(adapters.db.userApiKeys.update).toHaveBeenCalled();
  });

  it('does not gate re-owning a non-embed key on the agent binding', async () => {
    // A stray agentId on a non-embed key must not drag in the embed guard.
    const adapters = makeEmbedAdapters(key({ scopes: [ApiKeyScope.READ_NOTEBOOKS], agentId: 'agent-1' }), undefined);

    const result = await rotateUserApiKey('admin-2', { keyId: 'k1' }, adapters as never);

    expect(result.previousOwnerUserId).toBe('owner-1');
    expect(adapters.db.userApiKeys.update).toHaveBeenCalled();
  });
});
