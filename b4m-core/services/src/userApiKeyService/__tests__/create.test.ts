import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createUserApiKey,
  EMBED_SPEND_CAP_MAX_CREDITS,
  API_KEY_USER_CAP_ERROR_CODE,
  MAX_ACTIVE_EXCHANGE_KEYS_PER_USER,
  MAX_ACTIVE_KEYS_PER_USER,
} from '../create';
import { ApiKeyScope, ApiKeyStatus, BadRequestError, CreditHolderType } from '@bike4mind/common';

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

  it('rogue-admin scenario: non-system user hits 10-key cap, tagged with a stable code', async () => {
    repo = makeRepo({ countActiveByUserId: vi.fn().mockResolvedValue(10) });
    const error = await createUserApiKey('admin-1', baseParams, {
      db: { userApiKeys: repo as any },
      systemUserId: 'sys-1',
    }).then(
      () => null,
      (err: unknown) => err
    );

    expect(error).toBeInstanceOf(BadRequestError);
    expect((error as BadRequestError).message).toBe('Maximum 10 active API keys allowed per user');
    // The tag is the contract the OAuth ai-token route matches on; the message is not.
    expect((error as BadRequestError).additionalInfo).toEqual({ errorCode: API_KEY_USER_CAP_ERROR_CODE });
    expect(repo.create).not.toHaveBeenCalled();
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

describe('createUserApiKey - callback signing secret', () => {
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    repo = makeRepo();
  });

  it('returns a plaintext callbackSigningSecret prefixed whsec_', async () => {
    const result = await createUserApiKey('sys-1', baseParams, {
      db: { userApiKeys: repo as any },
      systemUserId: 'sys-1',
    });
    expect(result.callbackSigningSecret).toMatch(/^whsec_/);
  });

  it('persists a callbackSigningSecretCreatedAt on the created document', async () => {
    await createUserApiKey('sys-1', baseParams, { db: { userApiKeys: repo as any }, systemUserId: 'sys-1' });
    const [document] = repo.create.mock.calls[0];
    expect(document.callbackSigningSecretCreatedAt).toBeInstanceOf(Date);
  });

  // encryptAtRest (b4m-core/utils/src/security/secretsAtRest.ts) degrades to a
  // pass-through when no SECRET_ENCRYPTION_KEY is configured, which is the case in
  // this test environment - so the persisted field is not guaranteed to differ from
  // the plaintext here. We only pin that the document carries *some* string field
  // for it, not its ciphertext shape (that belongs to secretsAtRest's own tests).
  it('passes a callbackSigningSecret string through to the persisted document', async () => {
    const result = await createUserApiKey('sys-1', baseParams, {
      db: { userApiKeys: repo as any },
      systemUserId: 'sys-1',
    });
    const [document] = repo.create.mock.calls[0];
    expect(typeof document.callbackSigningSecret).toBe('string');
    expect(result.callbackSigningSecret).toMatch(/^whsec_/);
  });
});

describe('createUserApiKey — embed keys (epic #41)', () => {
  let repo: ReturnType<typeof makeRepo>;
  const adapters = () => ({
    db: {
      userApiKeys: repo as any,
      agents: { findById: vi.fn().mockResolvedValue({ organizationId: 'org-1', userId: 'user1' }) } as any,
    },
  });
  // A coherent embed key is always org-billed (billingOwnerType Organization +
  // organizationId), mirroring assertEmbedCredential at serve/session time.
  const embedParams = {
    name: 'Embed key',
    scopes: [ApiKeyScope.EMBED_CHAT],
    metadata: { createdFrom: 'dashboard' as const },
    agentId: 'agent-1',
    billingOwnerType: CreditHolderType.Organization,
    organizationId: 'org-1',
  };

  beforeEach(() => {
    repo = makeRepo();
  });

  it('rejects embed:chat paired with any other scope', async () => {
    // An embed key ships in public page HTML, so a second scope would hand every
    // widget visitor whatever else the minter attached.
    await expect(
      createUserApiKey('user1', { ...embedParams, scopes: [ApiKeyScope.EMBED_CHAT, ApiKeyScope.AI_CHAT] }, adapters())
    ).rejects.toThrow(/must be the only scope/i);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects an agentId owned by neither the billing org nor the minter', async () => {
    const foreign = {
      db: {
        userApiKeys: repo as any,
        agents: { findById: vi.fn().mockResolvedValue({ organizationId: 'other-org', userId: 'someone' }) } as any,
      },
    };
    await expect(createUserApiKey('user1', embedParams, foreign)).rejects.toThrow(/owned by the billing organization/i);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects a system/global agent, which is owned by nobody', async () => {
    const systemAgent = {
      db: { userApiKeys: repo as any, agents: { findById: vi.fn().mockResolvedValue({}) } as any },
    };
    await expect(createUserApiKey('user1', embedParams, systemAgent)).rejects.toThrow(
      /owned by the billing organization/i
    );
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects an agentId that does not resolve', async () => {
    const missing = {
      db: { userApiKeys: repo as any, agents: { findById: vi.fn().mockResolvedValue(null) } as any },
    };
    await expect(createUserApiKey('user1', embedParams, missing)).rejects.toThrow(/owned by the billing organization/i);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('fails closed when the agents adapter is absent, even though the type now requires it', async () => {
    // The type requires `agents`; this pins the runtime guard for a caller that bypasses the
    // type (as-cast). An embed key ships in public HTML, so the ownership check must never be
    // skippable - a missing adapter throws rather than minting a key with an unverified agent.
    const noAgents = { db: { userApiKeys: repo as any } } as any;
    await expect(createUserApiKey('user1', embedParams, noAgents)).rejects.toThrow(/agents adapter is required/i);
    expect(repo.create).not.toHaveBeenCalled();
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

  it('mints a coherent org-billed embed key', async () => {
    const result = await createUserApiKey('user1', embedParams, adapters());
    expect(result.billingOwnerType).toBe(CreditHolderType.Organization);
    expect(result.organizationId).toBe('org-1');
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        billingOwnerType: CreditHolderType.Organization,
        organizationId: 'org-1',
      })
    );
  });

  it('rejects an embed:chat key without organization billing (default User)', async () => {
    const { billingOwnerType: _bt, organizationId: _oid, ...noOrg } = embedParams;
    await expect(createUserApiKey('user1', noOrg, adapters())).rejects.toThrow(/organization billing/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects an embed:chat key with Organization billing but no organizationId', async () => {
    const { organizationId: _oid, ...noOrgId } = embedParams;
    await expect(createUserApiKey('user1', noOrgId, adapters())).rejects.toThrow(/organization billing/);
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

describe('createUserApiKey - per-user cap pools', () => {
  const exchangeParams = {
    name: 'AI (federated: VibesWire)',
    scopes: [ApiKeyScope.AI_GENERATE],
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    metadata: { createdFrom: 'oauth-exchange' as const, oauthClientId: 'client-a' },
  };
  const dashboardParams = {
    name: 'my key',
    scopes: [ApiKeyScope.AI_GENERATE],
    metadata: { createdFrom: 'dashboard' as const },
  };

  // Only the userApiKeys members createUserApiKey touches are stubbed.
  const adapters = (repo: ReturnType<typeof makeRepo>) =>
    ({ db: { userApiKeys: repo }, systemUserId: 'sys-1' }) as unknown as Parameters<typeof createUserApiKey>[2];

  async function mintError(params: Parameters<typeof createUserApiKey>[1], repo: ReturnType<typeof makeRepo>) {
    return createUserApiKey('user-1', params, adapters(repo)).then(
      () => null,
      (err: unknown) => err as BadRequestError
    );
  }

  it('counts an exchange mint against the oauth-exchange pool only', async () => {
    const repo = makeRepo();
    await createUserApiKey('user-1', exchangeParams, adapters(repo));
    expect(repo.countActiveByUserId).toHaveBeenCalledTimes(1);
    expect(repo.countActiveByUserId).toHaveBeenCalledWith('user-1', 'oauth-exchange');
  });

  it('counts a dashboard mint against the standard pool only', async () => {
    const repo = makeRepo();
    await createUserApiKey('user-1', dashboardParams, adapters(repo));
    expect(repo.countActiveByUserId).toHaveBeenCalledTimes(1);
    expect(repo.countActiveByUserId).toHaveBeenCalledWith('user-1', 'standard');
  });

  it('lets an exchange mint through when the standard pool is full', async () => {
    const repo = makeRepo({
      countActiveByUserId: vi.fn(async (_userId: string, pool: string) =>
        pool === 'standard' ? MAX_ACTIVE_KEYS_PER_USER : 0
      ),
    });
    await expect(createUserApiKey('user-1', exchangeParams, adapters(repo))).resolves.toBeDefined();
  });

  it('lets a dashboard mint through when the exchange pool is full', async () => {
    const repo = makeRepo({
      countActiveByUserId: vi.fn(async (_userId: string, pool: string) =>
        pool === 'oauth-exchange' ? MAX_ACTIVE_EXCHANGE_KEYS_PER_USER : 0
      ),
    });
    await expect(createUserApiKey('user-1', dashboardParams, adapters(repo))).resolves.toBeDefined();
  });

  it('refuses an exchange mint at the exchange cap, tagged with the shared cap code', async () => {
    const repo = makeRepo({ countActiveByUserId: vi.fn().mockResolvedValue(MAX_ACTIVE_EXCHANGE_KEYS_PER_USER) });
    const error = await mintError(exchangeParams, repo);
    expect(error).toBeInstanceOf(BadRequestError);
    expect(error?.message).toBe(
      `Maximum ${MAX_ACTIVE_EXCHANGE_KEYS_PER_USER} concurrently authorized federated apps allowed per user`
    );
    expect(error?.additionalInfo).toEqual({ errorCode: API_KEY_USER_CAP_ERROR_CODE });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('allows an exchange mint one below the exchange cap', async () => {
    const repo = makeRepo({ countActiveByUserId: vi.fn().mockResolvedValue(MAX_ACTIVE_EXCHANGE_KEYS_PER_USER - 1) });
    await expect(createUserApiKey('user-1', exchangeParams, adapters(repo))).resolves.toBeDefined();
  });

  it.each([
    ['no expiresAt', { ...exchangeParams, expiresAt: undefined }],
    ['no oauthClientId', { ...exchangeParams, metadata: { createdFrom: 'oauth-exchange' as const } }],
  ])('refuses an exchange key with %s, so the separate pool stays short-lived and per-client', async (_l, params) => {
    const repo = makeRepo();
    const error = await mintError(params, repo);
    expect(error).toBeInstanceOf(BadRequestError);
    expect(error?.message).toBe('An oauth-exchange key requires expiresAt and metadata.oauthClientId');
    expect(repo.create).not.toHaveBeenCalled();
  });
});
