import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUserApiKey } from './create';
import { ApiKeyScope, CreditHolderType, IUserApiKeyDocument, IUserApiKeyRepository } from '@bike4mind/common';

// Echo the created document back so we can assert what the service persisted.
const makeRepo = () =>
  ({
    countActiveByUserId: vi.fn().mockResolvedValue(0),
    countActiveByProductId: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation(async (doc: Partial<IUserApiKeyDocument>) => ({
      id: 'key1',
      createdAt: new Date('2026-01-01'),
      ...doc,
    })),
  }) as unknown as IUserApiKeyRepository;

const baseParams = {
  name: 'Test key',
  scopes: [ApiKeyScope.AI_CHAT],
  metadata: { createdFrom: 'dashboard' as const },
};

describe('userApiKeyService - createUserApiKey org billing', () => {
  let repo: IUserApiKeyRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = makeRepo();
  });

  it('defaults to User billing when no billing target is given', async () => {
    const result = await createUserApiKey('user1', baseParams, { db: { userApiKeys: repo } });

    expect(result.billingOwnerType).toBe(CreditHolderType.User);
    expect(result.organizationId).toBeUndefined();
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ billingOwnerType: CreditHolderType.User, organizationId: undefined })
    );
  });

  it('persists an org billing target when both fields agree', async () => {
    const result = await createUserApiKey(
      'user1',
      { ...baseParams, billingOwnerType: CreditHolderType.Organization, organizationId: 'org1' },
      { db: { userApiKeys: repo } }
    );

    expect(result.billingOwnerType).toBe(CreditHolderType.Organization);
    expect(result.organizationId).toBe('org1');
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ billingOwnerType: CreditHolderType.Organization, organizationId: 'org1' })
    );
  });

  it('rejects Organization billing without an organizationId', async () => {
    await expect(
      createUserApiKey(
        'user1',
        { ...baseParams, billingOwnerType: CreditHolderType.Organization },
        { db: { userApiKeys: repo } }
      )
    ).rejects.toThrow(/organizationId must be set/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects an organizationId without Organization billing', async () => {
    await expect(
      createUserApiKey('user1', { ...baseParams, organizationId: 'org1' }, { db: { userApiKeys: repo } })
    ).rejects.toThrow(/organizationId must be set/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects billing an API key to an agent', async () => {
    await expect(
      createUserApiKey(
        'user1',
        { ...baseParams, billingOwnerType: CreditHolderType.Agent, organizationId: 'org1' },
        { db: { userApiKeys: repo } }
      )
    ).rejects.toThrow(/cannot be billed to an agent/);
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('userApiKeyService - createUserApiKey embed keys', () => {
  let repo: IUserApiKeyRepository;

  const embedParams = {
    name: 'Embed key',
    scopes: [ApiKeyScope.EMBED_CHAT],
    metadata: { createdFrom: 'dashboard' as const },
    agentId: 'agent-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    repo = makeRepo();
  });

  it('persists agentId, normalized origins, and branding for an embed:chat key', async () => {
    const result = await createUserApiKey(
      'user1',
      {
        ...embedParams,
        allowedOrigins: ['https://example.com', 'https://example.com', 'https://Widgets.example.org'],
        branding: { displayName: 'Acme Assistant', hideBranding: true },
      },
      { db: { userApiKeys: repo } }
    );

    expect(result.agentId).toBe('agent-1');
    // EmbedOriginsSchema lowercases + dedupes.
    expect(result.allowedOrigins).toEqual(['https://example.com', 'https://widgets.example.org']);
    expect(result.branding).toEqual({ displayName: 'Acme Assistant', hideBranding: true });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        allowedOrigins: ['https://example.com', 'https://widgets.example.org'],
      })
    );
  });

  it('requires an agentId when the embed:chat scope is present', async () => {
    const { agentId: _omit, ...noAgent } = embedParams;
    await expect(createUserApiKey('user1', noAgent, { db: { userApiKeys: repo } })).rejects.toThrow(
      /agentId is required for embed:chat scope/
    );
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects embed fields when the embed:chat scope is absent', async () => {
    await expect(
      createUserApiKey('user1', { ...baseParams, agentId: 'agent-1' }, { db: { userApiKeys: repo } })
    ).rejects.toThrow(/require the embed:chat scope/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects a non-https (or otherwise malformed) origin', async () => {
    await expect(
      createUserApiKey(
        'user1',
        { ...embedParams, allowedOrigins: ['http://example.com'] },
        { db: { userApiKeys: repo } }
      )
    ).rejects.toThrow(/normalized https origin/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects more than EMBED_ORIGINS_MAX origins', async () => {
    const tooMany = Array.from({ length: 6 }, (_, i) => `https://site${i}.example.com`);
    await expect(
      createUserApiKey('user1', { ...embedParams, allowedOrigins: tooMany }, { db: { userApiKeys: repo } })
    ).rejects.toThrow();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('allows an embed:chat key with no origins (allow-list set later)', async () => {
    const result = await createUserApiKey('user1', embedParams, { db: { userApiKeys: repo } });
    expect(result.agentId).toBe('agent-1');
    expect(result.allowedOrigins).toBeUndefined();
  });
});
