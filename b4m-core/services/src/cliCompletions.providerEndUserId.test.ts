import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fixtures mirror cliCompletions.runAttribution.test.ts.
vi.mock('./llm/modelAdmission', async importOriginal => ({
  ...(await importOriginal<typeof import('./llm/modelAdmission')>()),
  loadFreeTierAllowedModels: async () => undefined,
}));

vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
}));
const complete = vi.hoisted(() => vi.fn());
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
  getLlmByModel: vi.fn(() => ({ currentModel: '', complete })),
}));
const enforceCredits = vi.hoisted(() => ({ value: true }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  usdToCredits: vi.fn(() => 1),
  usdToCreditsStochastic: vi.fn(() => 1),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => enforceCredits.value),
  getSettingsByNames: vi.fn(),
}));

import { getLlmByModel } from '@bike4mind/llm-adapters';
import { executeCompletion, type CompletionParams } from './cliCompletions';

const user = { id: 'user1', currentCredits: 100 };
const db = {
  adminSettings: {} as never,
  apiKeys: {} as never,
  creditTransactions: {} as never,
  users: {
    incrementCredits: vi.fn().mockResolvedValue(user),
    findById: vi.fn().mockResolvedValue(user),
  } as never,
  usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as never,
  spendFreezes: { findActiveForSubject: vi.fn().mockResolvedValue(null) },
};

const run = (overrides: Partial<CompletionParams> = {}) =>
  executeCompletion({
    userId: 'user1',
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    db,
    requestId: 'req-1',
    source: 'desktop',
    onChunk: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

describe('executeCompletion - provider end-user id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceCredits.value = true;
    complete.mockImplementation(async (_model, _messages, _options, onChunk) => {
      await onChunk(['hi'], { inputTokens: 12, outputTokens: 3 });
    });
  });

  it('hands the derived provider id to the backend beside the owner id', async () => {
    const providerEndUserId = 'a'.repeat(64);
    await run({ providerEndUserId });

    expect(vi.mocked(getLlmByModel)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ endUserId: 'user1', providerEndUserId })
    );
  });

  it('passes no provider id when the request carries none', async () => {
    await run();

    const options = vi.mocked(getLlmByModel).mock.calls[0][1];
    expect(options.endUserId).toBe('user1');
    expect(options.providerEndUserId).toBeUndefined();
  });
});
