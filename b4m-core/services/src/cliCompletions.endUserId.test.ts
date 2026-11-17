import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same stubs as cliCompletions.creditEvents.test.ts; only the getLlmByModel options matter here.
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
      await onChunk(['ok'], { inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' });
    }),
  })),
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  usdToCredits: vi.fn(() => 1),
  usdToCreditsStochastic: vi.fn(() => 0),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => true),
  getSettingsByNames: vi.fn(),
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  getTextModelCost: vi.fn(() => 0.0002),
}));

import { getLlmByModel } from '@bike4mind/llm-adapters';
import { executeCompletion } from './cliCompletions';

// Partial repository doubles: only the methods executeCompletion calls are stubbed.
function buildDb() {
  const user = { id: 'user1', currentCredits: 100 };
  return {
    adminSettings: {} as never,
    apiKeys: {} as never,
    creditTransactions: {} as never,
    users: {
      incrementCredits: vi.fn().mockResolvedValue(user),
      findById: vi.fn().mockResolvedValue(user),
    } as never,
    usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as never,
  };
}

const run = (endUserId?: string) =>
  executeCompletion({
    userId: 'user1',
    endUserId,
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    db: buildDb(),
    onChunk: vi.fn().mockResolvedValue(undefined),
  });

describe('executeCompletion - provider end-user attribution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('attributes the request to the caller by default', async () => {
    await run();
    expect(vi.mocked(getLlmByModel)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ endUserId: 'user1' })
    );
  });

  it('attributes it to the given end user when one is passed', async () => {
    await run('user1:player-42');
    expect(vi.mocked(getLlmByModel)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ endUserId: 'user1:player-42' })
    );
  });
});
