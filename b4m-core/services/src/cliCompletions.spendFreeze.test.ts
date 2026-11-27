import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * executeCompletion refuses a frozen subject after model admission and before any hold, backend or
 * credit movement, whether or not credits are enforced.
 */
vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));

const h = vi.hoisted(() => ({
  model: {
    id: 'test-model',
    type: 'text',
    backend: 'openai',
    max_tokens: 1000,
    pricing: { 200_000: { input: 1e-6, output: 2e-6 } },
  },
  complete: vi.fn(),
  getLlmByModel: vi.fn(),
  enforceCredits: true,
}));

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn().mockResolvedValue([h.model]),
  getLlmByModel: h.getLlmByModel,
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn((name: string) => (name === 'enforceCredits' ? h.enforceCredits : undefined)),
  getSettingsByNames: vi.fn(),
}));

import { CreditHolderType, isSpendFrozenError } from '@bike4mind/common';
import { executeCompletion } from './cliCompletions';

const frozen = { scopeType: 'apiKey', frozenAt: new Date('2026-11-16T00:00:00.000Z'), reason: 'secret reason' };

function buildDb() {
  return {
    adminSettings: { findOne: vi.fn().mockResolvedValue(null) } as never,
    apiKeys: {} as never,
    creditTransactions: {} as never,
    users: {
      incrementCredits: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100_000 }),
      findById: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100_000, tags: [] }),
    },
    usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as never,
    organizations: {
      findById: vi
        .fn()
        .mockResolvedValue({ id: 'org1', currentCredits: 100_000, userDetails: [], users: [{ userId: 'user1' }] }),
      incrementCredits: vi.fn().mockResolvedValue({ id: 'org1', currentCredits: 100_000 }),
    },
    spendFreezes: { findActiveForSubject: vi.fn().mockResolvedValue(null) },
    cache: undefined as never,
    recordLimitEvent: vi.fn().mockResolvedValue(undefined),
  };
}

const run = (db: ReturnType<typeof buildDb>, extra: Partial<Parameters<typeof executeCompletion>[0]> = {}) =>
  executeCompletion({
    userId: 'user1',
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    onChunk: vi.fn().mockResolvedValue(undefined),
    db: db as never,
    ...extra,
  });

describe('executeCompletion spend freeze', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.enforceCredits = true;
    h.complete.mockImplementation(async (_m, _msgs, _o, cb) => cb(['ok'], { inputTokens: 1, outputTokens: 1 }));
    h.getLlmByModel.mockReturnValue({ currentModel: '', complete: h.complete });
  });

  it.each([true, false])(
    'refuses a frozen subject before any backend or credit movement (enforceCredits %s)',
    async enforce => {
      h.enforceCredits = enforce;
      const db = buildDb();
      db.spendFreezes.findActiveForSubject.mockResolvedValue(frozen);

      const error = await run(db).catch((e: unknown) => e);

      expect(isSpendFrozenError(error)).toBe(true);
      expect(JSON.stringify(error)).not.toContain('secret reason');
      expect((error as Error).message).not.toContain('secret reason');
      expect(h.getLlmByModel).not.toHaveBeenCalled();
      expect(db.users.incrementCredits).not.toHaveBeenCalled();
      expect(db.organizations.incrementCredits).not.toHaveBeenCalled();
    }
  );

  it('checks the user, org and key of a user-billed key turn', async () => {
    const db = buildDb();
    await run(db, { apiKeyInfo: { keyId: 'key-1', keyName: 'k' }, apiKeyBillingOwnerType: CreditHolderType.User });
    expect(db.spendFreezes.findActiveForSubject).toHaveBeenCalledWith({
      userId: 'user1',
      organizationId: null,
      apiKeyId: 'key-1',
    });
  });

  it('keeps the acting user on an org-billed key turn', async () => {
    const db = buildDb();
    await run(db, {
      apiKeyInfo: { keyId: 'key-1', keyName: 'k' },
      apiKeyBillingOwnerType: CreditHolderType.Organization,
      billingOrganizationId: 'org1',
    });
    expect(db.spendFreezes.findActiveForSubject).toHaveBeenCalledWith({
      userId: 'user1',
      organizationId: 'org1',
      apiKeyId: 'key-1',
    });
  });

  it('checks the user when the key billing type is unknown', async () => {
    const db = buildDb();
    await run(db, { apiKeyInfo: { keyId: 'key-1', keyName: 'k' }, billingOrganizationId: 'org1' });
    expect(db.spendFreezes.findActiveForSubject).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user1' }));
  });

  it('skips its own lookup once the caller already checked', async () => {
    const db = buildDb();
    await run(db, { spendFreezeChecked: true });
    expect(db.spendFreezes.findActiveForSubject).not.toHaveBeenCalled();
  });

  it('propagates a lookup failure', async () => {
    const db = buildDb();
    db.spendFreezes.findActiveForSubject.mockRejectedValue(new Error('mongo down'));
    await expect(run(db)).rejects.toThrow('mongo down');
    expect(h.getLlmByModel).not.toHaveBeenCalled();
  });
});
