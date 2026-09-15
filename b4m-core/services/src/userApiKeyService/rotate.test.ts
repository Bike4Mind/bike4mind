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
