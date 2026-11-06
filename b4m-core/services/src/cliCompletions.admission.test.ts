import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * executeCompletion (the /api/ai/v1/completions and CLI door) admits the requested model through the
 * shared modelAdmission rule before any backend is built: an entitlement-gated model is a 403 for a
 * caller without the entitlement, and runs for one who has it.
 */
// The free-tier gate reads settings these fixtures do not model; llm/modelAdmission.test.ts covers it.
const gate = vi.hoisted(() => ({
  loadFreeTierAllowedModels: vi.fn(async (): Promise<ReadonlySet<string> | undefined> => undefined),
}));
vi.mock('./llm/modelAdmission', async importOriginal => ({
  ...(await importOriginal<typeof import('./llm/modelAdmission')>()),
  loadFreeTierAllowedModels: gate.loadFreeTierAllowedModels,
}));

vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
  isMemberCreditCapExceeded: vi.fn(() => false),
}));

const h = vi.hoisted(() => ({
  model: {
    id: 'gated-model',
    type: 'text',
    backend: 'openai',
    max_tokens: 1000,
    pricing: { 200_000: { input: 1e-6, output: 2e-6 } },
  },
  complete: vi.fn(),
  getLlmByModel: vi.fn(),
}));

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn().mockResolvedValue([h.model]),
  getLlmByModel: h.getLlmByModel,
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  usdToCredits: vi.fn(() => 10),
  usdToCreditsStochastic: vi.fn(() => 10),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => true),
  getSettingsByNames: vi.fn(),
}));

import { ForbiddenError, UnauthorizedError } from '@bike4mind/common';
import { executeCompletion } from './cliCompletions';

const entitlementGatedConfigs = [{ id: 'gated-model', enabled: true, allowedEntitlements: ['pro'] }];

function buildDb(configs: unknown[] = entitlementGatedConfigs) {
  return {
    adminSettings: {
      findOne: vi.fn().mockResolvedValue({ settingValue: configs }),
    } as any,
    apiKeys: {} as any,
    creditTransactions: {} as any,
    users: {
      incrementCredits: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100_000 }),
      findById: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100_000, tags: [] }),
    } as any,
    usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as any,
    organizations: {} as any,
  };
}

const run = (getEntitlements: () => Promise<string[]>, configs?: unknown[]) =>
  executeCompletion({
    userId: 'user1',
    model: 'gated-model',
    messages: [{ role: 'user', content: 'hi' }],
    onChunk: vi.fn().mockResolvedValue(undefined),
    db: buildDb(configs),
    getEntitlements,
  });

describe('executeCompletion model admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gate.loadFreeTierAllowedModels.mockResolvedValue(undefined);
    h.complete.mockImplementation(async (_m, _msgs, _o, cb) => cb(['ok'], { inputTokens: 1, outputTokens: 1 }));
    h.getLlmByModel.mockReturnValue({ currentModel: '', complete: h.complete });
  });

  it('refuses an entitlement-gated model with a 403 before building a backend', async () => {
    await expect(run(async () => [])).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.getLlmByModel).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('runs the gated model for an entitled caller', async () => {
    await run(async () => ['pro']);
    expect(h.complete).toHaveBeenCalledOnce();
  });

  it('admits an admin caller, and refuses one whose admin role scopeActor withholds', async () => {
    const adminDb = () => {
      const db = buildDb();
      db.users.findById.mockResolvedValue({ id: 'user1', currentCredits: 100_000, tags: [], isAdmin: true });
      return db;
    };
    const base = {
      userId: 'user1',
      model: 'gated-model',
      messages: [{ role: 'user' as const, content: 'hi' }],
      onChunk: vi.fn().mockResolvedValue(undefined),
      getEntitlements: async () => [],
    };

    await executeCompletion({ ...base, db: adminDb() });
    expect(h.complete).toHaveBeenCalledOnce();

    await expect(
      executeCompletion({ ...base, db: adminDb(), scopeActor: actor => ({ ...actor, isAdmin: false }) })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each([
    ['banned', { isBanned: true }],
    ['dispute-pending', { disputePending: true }],
    ['suspended', { moderation: { status: 'suspended' } }],
  ])('refuses a %s caller before building a backend or moving credits', async (_label, state) => {
    const db = buildDb([]);
    db.users.findById.mockResolvedValue({ id: 'user1', currentCredits: 100_000, tags: [], ...state });

    await expect(
      executeCompletion({
        userId: 'user1',
        model: 'gated-model',
        messages: [{ role: 'user', content: 'hi' }],
        onChunk: vi.fn().mockResolvedValue(undefined),
        db,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.getLlmByModel).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(db.users.incrementCredits).not.toHaveBeenCalled();
  });

  it('fails closed when the caller no longer exists', async () => {
    const db = buildDb([]);
    db.users.findById.mockResolvedValue(null);

    await expect(
      executeCompletion({
        userId: 'user1',
        model: 'gated-model',
        messages: [{ role: 'user', content: 'hi' }],
        onChunk: vi.fn().mockResolvedValue(undefined),
        db,
      })
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(h.complete).not.toHaveBeenCalled();
  });

  describe('free-tier model gate', () => {
    beforeEach(() => {
      gate.loadFreeTierAllowedModels.mockResolvedValue(new Set(['some-free-model']));
    });

    it('refuses a text model outside the free-tier allowlist with model_requires_subscription before building a backend', async () => {
      const error: unknown = await run(async () => ['base'], []).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).additionalInfo).toEqual({ errorCode: 'model_requires_subscription' });
      expect(h.getLlmByModel).not.toHaveBeenCalled();
      expect(h.complete).not.toHaveBeenCalled();
    });

    it('runs the same model for a caller holding the paid-plan entitlement', async () => {
      await run(async () => ['base', 'plan:paid'], []);

      expect(h.complete).toHaveBeenCalledOnce();
    });
  });
});
