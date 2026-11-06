import { describe, it, expect, vi, beforeEach } from 'vitest';

// A cheap call: the deterministic round-up says 1 credit, the stochastic settlement draws 0.
// The two disagreeing on purpose is what exposes a provisional credit frame.
// The free-tier gate reads settings these fixtures do not model; llm/modelAdmission.test.ts covers it.
// Pricing is stubbed flat in this file, so the per-round credit cap cannot be priced here; it is held
// open, and cliCompletions.creditCap.test.ts covers it on real pricing.
vi.mock('./completionCreditBudget', async importOriginal => ({
  ...(await importOriginal<typeof import('./completionCreditBudget')>()),
  affordableRoundBudget: () => ({ affordable: true, outputTokens: Number.MAX_SAFE_INTEGER }),
}));
vi.mock('./llm/modelAdmission', async importOriginal => ({
  ...(await importOriginal<typeof import('./llm/modelAdmission')>()),
  loadFreeTierAllowedModels: async () => undefined,
}));

vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/llm-adapters', () => ({
  buildApiKeyTable: (keys: object) => keys,
  reasonsWithinOutputBudget: vi.fn(() => false),
  isAdaptiveThinkingByDefault: vi.fn(() => false),
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
      await onChunk(['Hel'], {});
      await onChunk(['lo'], { inputTokens: 12, outputTokens: 3, stopReason: 'end_turn' });
    }),
  })),
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  usdToCredits: vi.fn(() => 1),
  usdToCreditsStochastic: vi.fn(() => 0),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => true), // enforceCredits = true
  getSettingsByNames: vi.fn(),
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  getTextModelCost: vi.fn(() => 0.0002),
}));

import { executeCompletion } from './cliCompletions';
import { subtractCredits } from './creditService';

// any: partial repository doubles - only the methods executeCompletion calls are stubbed.
function buildDb() {
  const user = { id: 'user1', currentCredits: 100 };
  return {
    adminSettings: {} as any,
    apiKeys: {} as any,
    creditTransactions: {} as any,
    users: {
      incrementCredits: vi.fn().mockResolvedValue(user),
      findById: vi.fn().mockResolvedValue(user),
    } as any,
    usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as any,
  };
}

describe('executeCompletion - credit events', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits exactly one credits frame, last, carrying the amount the ledger charged', async () => {
    const onChunk = vi.fn().mockResolvedValue(undefined);

    await executeCompletion({
      userId: 'user1',
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      db: buildDb(),
      onChunk,
    });

    const creditFrames = onChunk.mock.calls.filter(([, info]) => info?.creditsUsed !== undefined);
    expect(creditFrames).toHaveLength(1);
    expect(onChunk.mock.calls.at(-1)).toBe(creditFrames[0]);
    expect(creditFrames[0][1]).toMatchObject({ creditsUsed: 0, inputTokens: 12, outputTokens: 3 });

    expect(vi.mocked(subtractCredits)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'completion_api_usage', credits: 0 }),
      expect.anything()
    );
  });

  it('still streams token usage on the provider frames', async () => {
    const onChunk = vi.fn().mockResolvedValue(undefined);

    await executeCompletion({
      userId: 'user1',
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      db: buildDb(),
      onChunk,
    });

    expect(onChunk).toHaveBeenCalledWith(['lo'], { inputTokens: 12, outputTokens: 3, stopReason: 'end_turn' });
  });
});
