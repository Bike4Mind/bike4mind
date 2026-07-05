import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUserApiKey } from '../create';
import { ApiKeyScope, ApiKeyStatus } from '@bike4mind/common';

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
