import { describe, it, expect, vi, beforeEach } from 'vitest';

// Isolate the billing routing: stub the LLM layer, settings, and credit math so
// the test asserts *which pool* is reserved/settled, not token accounting.
// The free-tier gate reads settings these fixtures do not model; llm/modelAdmission.test.ts covers it.
// Pricing is stubbed flat in this file, so the per-round credit cap cannot be priced here; it is held
// open, and cliCompletions.creditCap.test.ts covers it on real pricing.
const { roundBudget } = vi.hoisted(() => ({ roundBudget: vi.fn() }));
vi.mock('./completionCreditBudget', async importOriginal => ({
  ...(await importOriginal<typeof import('./completionCreditBudget')>()),
  affordableRoundBudget: roundBudget,
}));
vi.mock('./llm/modelAdmission', async importOriginal => ({
  ...(await importOriginal<typeof import('./llm/modelAdmission')>()),
  loadFreeTierAllowedModels: async () => undefined,
}));

vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
// Keep the real pure cap helpers (isMemberCreditCapExceeded etc.); only stub the write.
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/llm-adapters', () => ({
  buildApiKeyTable: (keys: object) => keys,
  reasonsWithinOutputBudget: vi.fn(() => false),
  isAdaptiveThinkingByDefault: vi.fn(() => false),
  // See cliCompletions.maxTokens.test.ts for coverage against the real implementation.
  resolveOutputMaxTokens: vi.fn(
    ({ requested, fallback }: { requested?: number; fallback: number }) => requested ?? fallback
  ),
  getAvailableModels: vi.fn().mockResolvedValue([
    {
      id: 'test-model',
      type: 'text',
      backend: 'anthropic',
      pricing: { 200_000: { input: 1 / 1_000_000, output: 1 / 1_000_000 } },
    },
  ]),
  getLlmByModel: vi.fn(() => ({
    currentModel: '',
    complete: vi.fn(async (_model, _messages, _options, onChunk) => {
      await onChunk([''], { inputTokens: 100, outputTokens: 50 });
    }),
  })),
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  usdToCredits: vi.fn(() => 10),
  usdToCreditsStochastic: vi.fn(() => 10),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => true), // enforceCredits = true
  getSettingsByNames: vi.fn(),
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  getTextModelCost: vi.fn(() => 0.001),
}));

import { executeCompletion } from './cliCompletions';
import { InsufficientCreditsError } from './llm/ChatCompletionProcess';

const orgWithCap = {
  id: 'org1',
  currentCredits: 500,
  maxCreditsPerMember: 5,
  userDetails: [{ id: 'user1', usedCredits: 0 }],
  users: [{ userId: 'user1' }],
};

function buildDb(opts: { org?: object; reservedBalance?: number; recordLimitEvent?: ReturnType<typeof vi.fn> } = {}) {
  const org = opts.org ?? orgWithCap;
  const recordLimitEvent = opts.recordLimitEvent ?? vi.fn().mockResolvedValue(undefined);
  // Minimal repo mocks carrying only the methods executeCompletion calls.
  const db = {
    adminSettings: {},
    apiKeys: {},
    creditTransactions: {},
    users: {
      incrementCredits: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: opts.reservedBalance ?? 100 }),
      findById: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100 }),
    },
    usageEvents: { record: vi.fn().mockResolvedValue(undefined) },
    organizations: {
      findById: vi.fn().mockResolvedValue(org),
      incrementCredits: vi.fn().mockResolvedValue({ ...org, currentCredits: 490 }),
      ensureUserDetails: vi.fn().mockResolvedValue(undefined),
      updateUserDetails: vi.fn().mockResolvedValue(undefined),
    },
    recordLimitEvent,
  } as unknown as Parameters<typeof executeCompletion>[0]['db'];
  return { recordLimitEvent, db };
}

const baseParams = {
  userId: 'user1',
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'hi' }],
  onChunk: vi.fn().mockResolvedValue(undefined),
};

const refusal = (reason: string) => ({
  userId: 'user1',
  kind: 'insufficient_credits',
  model: 'test-model',
  details: expect.objectContaining({ reason }),
});

describe('executeCompletion - credit refusals reach the user timeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    roundBudget.mockReturnValue({ affordable: true, outputTokens: Number.MAX_SAFE_INTEGER });
  });

  it('records member_cap when the org member cap would be exceeded', async () => {
    const { db, recordLimitEvent } = buildDb();

    await expect(executeCompletion({ ...baseParams, db, billingOrganizationId: 'org1' })).rejects.toBeInstanceOf(
      InsufficientCreditsError
    );

    expect(recordLimitEvent).toHaveBeenCalledTimes(1);
    expect(recordLimitEvent).toHaveBeenCalledWith(refusal('member_cap'));
  });

  it('records balance when the reservation drives the balance negative', async () => {
    const { db, recordLimitEvent } = buildDb({ reservedBalance: -5 });

    await expect(executeCompletion({ ...baseParams, db })).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(recordLimitEvent).toHaveBeenCalledTimes(1);
    expect(recordLimitEvent).toHaveBeenCalledWith(refusal('balance'));
  });

  it('records balance when not even a short answer is affordable', async () => {
    roundBudget.mockReturnValue({ affordable: false, minimumCredits: 50 });
    const { db, recordLimitEvent } = buildDb();

    await expect(executeCompletion({ ...baseParams, db })).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(recordLimitEvent).toHaveBeenCalledTimes(1);
    expect(recordLimitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'insufficient_credits',
        details: expect.objectContaining({ reason: 'balance', requiredCredits: 50 }),
      })
    );
  });

  it('still refuses with the credit error when recording the event fails', async () => {
    const { db, recordLimitEvent } = buildDb({
      recordLimitEvent: vi.fn().mockRejectedValue(new Error('timeline write failed')),
    });

    const err = await executeCompletion({ ...baseParams, db, billingOrganizationId: 'org1' }).catch(e => e);

    expect(recordLimitEvent).toHaveBeenCalled();
    expect(err).toBeInstanceOf(InsufficientCreditsError);
  });
});
