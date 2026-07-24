import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUserApiKey, EMBED_SPEND_CAP_MAX_CREDITS } from '../create';
import { ApiKeyScope, ApiKeyStatus, CreditHolderType } from '@bike4mind/common';

vi.mock('bcryptjs', async () => {
  const { bcryptMockFactory } = await import('./helpers/bcryptMock');
  return bcryptMockFactory();
});

function makeRepo(
  overrides: Partial<{
    countActiveByUserId: ReturnType<typeof vi.fn>;
    countActiveByProductId: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    updateLastUsed: ReturnType<typeof vi.fn>;
  }> = {}
) {
  return {
    countActiveByUserId: overrides.countActiveByUserId ?? vi.fn().mockResolvedValue(0),
    countActiveByProductId: overrides.countActiveByProductId ?? vi.fn().mockResolvedValue(0),
    updateLastUsed: overrides.updateLastUsed ?? vi.fn().mockResolvedValue(undefined),
    create:
      overrides.create ??
      vi.fn().mockImplementation((doc: Record<string, unknown>) => ({
        ...doc,
        id: 'key-1',
        createdAt: new Date(),
      })),
  };
}

const baseParams = {
  name: 'test-key',
  scopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE],
  metadata: { createdFrom: 'overwatch-admin' as const, createdByUserId: 'admin-1' },
  productId: 'vibeswire',
  productName: 'VibesWire',
};

describe('createUserApiKey — overwatch ingest scope', () => {
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    repo = makeRepo();
  });

  it('creates a key with productId persisted', async () => {
    await createUserApiKey('sys-1', baseParams, { db: { userApiKeys: repo as any }, systemUserId: 'sys-1' });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 'vibeswire', productName: 'VibesWire' })
    );
  });

  it('returns the raw plaintext key (only time it is exposed)', async () => {
    const result = await createUserApiKey('sys-1', baseParams, {
      db: { userApiKeys: repo as any },
      systemUserId: 'sys-1',
    });
    expect(result.key).toMatch(/^b4m_live_/);
  });

  it('throws BadRequestError when OVERWATCH_INGEST_WRITE used without productId', async () => {
    const params = { ...baseParams, productId: undefined };
    await expect(
      createUserApiKey('sys-1', params as any, { db: { userApiKeys: repo as any }, systemUserId: 'sys-1' })
    ).rejects.toThrow('productId is required for overwatch-ingest:write scope');
  });

  it('enforces per-product 20-key cap (counts ACTIVE + RATE_LIMITED)', async () => {
    repo = makeRepo({ countActiveByProductId: vi.fn().mockResolvedValue(20) });
    await expect(
      createUserApiKey('sys-1', baseParams, { db: { userApiKeys: repo as any }, systemUserId: 'sys-1' })
    ).rejects.toThrow('Maximum 20 active ingest keys allowed per product');
  });

  it('counts ACTIVE + RATE_LIMITED toward cap (19 is under cap)', async () => {
    repo = makeRepo({ countActiveByProductId: vi.fn().mockResolvedValue(19) });
    await expect(
      createUserApiKey('sys-1', baseParams, { db: { userApiKeys: repo as any }, systemUserId: 'sys-1' })
    ).resolves.toBeDefined();
  });

  it('system user bypasses per-user 10-key cap', async () => {
    repo = makeRepo({
      countActiveByUserId: vi.fn().mockResolvedValue(15),
      countActiveByProductId: vi.fn().mockResolvedValue(0),
    });
    // systemUserId === userId, so bypass
    await expect(
      createUserApiKey('sys-1', baseParams, { db: { userApiKeys: repo as any }, systemUserId: 'sys-1' })
    ).resolves.toBeDefined();
  });

  it('rogue-admin scenario: non-system user hits 10-key cap', async () => {
    repo = makeRepo({ countActiveByUserId: vi.fn().mockResolvedValue(10) });
    await expect(
      createUserApiKey('admin-1', baseParams, { db: { userApiKeys: repo as any }, systemUserId: 'sys-1' })
    ).rejects.toThrow('Maximum 10 active API keys allowed per user');
  });

  it('stores createdByUserId in metadata', async () => {
    await createUserApiKey('sys-1', baseParams, { db: { userApiKeys: repo as any }, systemUserId: 'sys-1' });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ createdByUserId: 'admin-1' }) })
    );
  });

  it('sets status ACTIVE on creation', async () => {
    await createUserApiKey('sys-1', baseParams, { db: { userApiKeys: repo as any }, systemUserId: 'sys-1' });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ status: ApiKeyStatus.ACTIVE }));
  });
});

describe('createUserApiKey — embed keys (epic #41)', () => {
  let repo: ReturnType<typeof makeRepo>;
  const adapters = () => ({ db: { userApiKeys: repo as any } });
  // Embed keys must be org-billed (they are otherwise never servable), so every
  // valid embed create carries an organizationId + Organization billing.
  const embedParams = {
    name: 'Embed key',
    scopes: [ApiKeyScope.EMBED_CHAT],
    metadata: { createdFrom: 'dashboard' as const },
    agentId: 'agent-1',
    organizationId: 'org-1',
    billingOwnerType: CreditHolderType.Organization,
  };

  beforeEach(() => {
    repo = makeRepo();
  });

  it('rejects an embed:chat key with no organizationId (never servable)', async () => {
    const { organizationId: _org, billingOwnerType: _bill, ...noOrg } = embedParams;
    await expect(createUserApiKey('user1', noOrg, adapters())).rejects.toThrow(
      /embed:chat keys must be billed to an organization/
    );
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('accepts an embed:chat key billed to an organization', async () => {
    const result = await createUserApiKey('user1', embedParams, adapters());
    expect(result.organizationId).toBe('org-1');
    expect(result.billingOwnerType).toBe(CreditHolderType.Organization);
  });

  it('persists agentId, normalized origins, and branding', async () => {
    const result = await createUserApiKey(
      'user1',
      {
        ...embedParams,
        allowedOrigins: ['https://example.com', 'https://example.com', 'https://Widgets.example.org'],
        branding: { displayName: 'Acme Assistant', hideBranding: true },
      },
      adapters()
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
    await expect(createUserApiKey('user1', noAgent, adapters())).rejects.toThrow(
      /agentId is required for embed:chat scope/
    );
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects an empty-string agentId (never a meaningful binding)', async () => {
    await expect(createUserApiKey('user1', { ...embedParams, agentId: '' }, adapters())).rejects.toThrow();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects agentId without the embed:chat scope', async () => {
    await expect(
      createUserApiKey(
        'user1',
        { ...baseParams, productId: undefined, scopes: [ApiKeyScope.AI_CHAT], agentId: 'agent-1' },
        adapters()
      )
    ).rejects.toThrow(/require the embed:chat scope/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects allowedOrigins without the embed:chat scope (including an explicit empty array)', async () => {
    await expect(
      createUserApiKey(
        'user1',
        {
          name: 'x',
          scopes: [ApiKeyScope.AI_CHAT],
          metadata: { createdFrom: 'dashboard' as const },
          allowedOrigins: [],
        },
        adapters()
      )
    ).rejects.toThrow(/require the embed:chat scope/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects branding without the embed:chat scope', async () => {
    await expect(
      createUserApiKey(
        'user1',
        {
          name: 'x',
          scopes: [ApiKeyScope.AI_CHAT],
          metadata: { createdFrom: 'dashboard' as const },
          branding: { displayName: 'x' },
        },
        adapters()
      )
    ).rejects.toThrow(/require the embed:chat scope/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects a non-https (or otherwise malformed) origin', async () => {
    await expect(
      createUserApiKey('user1', { ...embedParams, allowedOrigins: ['http://example.com'] }, adapters())
    ).rejects.toThrow(/normalized https origin/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  // Branding format validation (shared EmbedBrandingSchema): removing the schema
  // from createUserApiKeySchema lets any of these mint.
  it.each([
    ['a javascript: logo URL', { logoUrl: 'javascript:alert(1)' }],
    ['a data: logo URL', { logoUrl: 'data:image/png;base64,xx' }],
    ['a non-hex primaryColor', { primaryColor: 'rgb(0,0,0)' }],
    ['an overlong displayName', { displayName: 'a'.repeat(65) }],
  ])('rejects branding with %s', async (_label, branding) => {
    await expect(createUserApiKey('user1', { ...embedParams, branding }, adapters())).rejects.toThrow();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects more than EMBED_ORIGINS_MAX origins', async () => {
    const tooMany = Array.from({ length: 6 }, (_, i) => `https://site${i}.example.com`);
    await expect(createUserApiKey('user1', { ...embedParams, allowedOrigins: tooMany }, adapters())).rejects.toThrow();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('persists and echoes spendCap on an embed key', async () => {
    const result = await createUserApiKey('user1', { ...embedParams, spendCap: 5000 }, adapters());
    expect(result.spendCap).toBe(5000);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ spendCap: 5000 }));
  });

  it('allows an embed key with no spendCap (uncapped)', async () => {
    const result = await createUserApiKey('user1', embedParams, adapters());
    expect(result.spendCap).toBeUndefined();
  });

  it('rejects spendCap without the embed:chat scope', async () => {
    await expect(
      createUserApiKey(
        'user1',
        {
          name: 'x',
          scopes: [ApiKeyScope.AI_CHAT],
          metadata: { createdFrom: 'dashboard' as const },
          spendCap: 5000,
        },
        adapters()
      )
    ).rejects.toThrow(/require the embed:chat scope/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', 0],
    ['negative', -100],
    ['fractional', 10.5],
    ['above the ceiling', EMBED_SPEND_CAP_MAX_CREDITS + 1],
    ['a non-number', '100' as unknown as number],
  ])('rejects a spendCap that is %s', async (_label, spendCap) => {
    await expect(createUserApiKey('user1', { ...embedParams, spendCap }, adapters())).rejects.toThrow();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('accepts a spendCap at exactly the ceiling', async () => {
    const result = await createUserApiKey(
      'user1',
      { ...embedParams, spendCap: EMBED_SPEND_CAP_MAX_CREDITS },
      adapters()
    );
    expect(result.spendCap).toBe(EMBED_SPEND_CAP_MAX_CREDITS);
  });

  it('allows an embed:chat key with no origins, and with an explicit empty array', async () => {
    const noOrigins = await createUserApiKey('user1', embedParams, adapters());
    expect(noOrigins.agentId).toBe('agent-1');
    expect(noOrigins.allowedOrigins).toBeUndefined();

    const emptyArray = await createUserApiKey('user1', { ...embedParams, allowedOrigins: [] }, adapters());
    expect(emptyArray.allowedOrigins).toEqual([]);
  });
});
