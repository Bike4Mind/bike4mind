import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelBackend, getTextModelCost, usdToCredits, type ModelInfo } from '@bike4mind/common';
import {
  PREFLIGHT_RESERVATION_OUTPUT_TOKENS,
  PREFLIGHT_RESERVATION_REASONING_OUTPUT_TOKENS,
  reservationOutputTokens,
} from '@bike4mind/common';

// Real pricing math here (unlike cliCompletions.orgBilling.test.ts, which stubs it flat):
// the point of this file is the reservation *figure*, so nothing that computes it is mocked.
const MODEL_ID = 'reservation-test-model';
const MAX_TOKENS = 100_000;
const INPUT_TOKENS = 4; // estimateInputTokens over the single short message below

const MODEL_INFO = {
  id: MODEL_ID,
  type: 'text',
  name: 'Reservation Test',
  backend: ModelBackend.Anthropic,
  contextWindow: 200_000,
  max_tokens: 128_000,
  pricing: { 200_000: { input: 5 / 1_000_000, output: 25 / 1_000_000 } },
  supportsImageVariation: false,
} as unknown as ModelInfo;

const OPENAI_MODEL_ID = 'reservation-test-openai';
const OPENAI_MODEL_INFO = {
  ...MODEL_INFO,
  id: OPENAI_MODEL_ID,
  backend: ModelBackend.OpenAI,
} as unknown as ModelInfo;

// Publishes an explicit cache_read, so the auto-caching arm applies without any client flag.
const OPENAI_CACHED_MODEL_ID = 'reservation-test-openai-cached';
const OPENAI_CACHED_MODEL_INFO = {
  ...OPENAI_MODEL_INFO,
  id: OPENAI_CACHED_MODEL_ID,
  pricing: { 200_000: { input: 2 / 1_000_000, output: 8 / 1_000_000, cache_read: 0.5 / 1_000_000 } },
} as unknown as ModelInfo;

const KIMI_CACHED_MODEL_ID = 'reservation-test-kimi-cached';
const KIMI_CACHED_MODEL_INFO = {
  ...OPENAI_CACHED_MODEL_INFO,
  id: KIMI_CACHED_MODEL_ID,
  backend: ModelBackend.Kimi,
} as unknown as ModelInfo;

const DEEPSEEK_CACHED_MODEL_ID = 'reservation-test-deepseek-cached';
const DEEPSEEK_CACHED_MODEL_INFO = {
  ...OPENAI_CACHED_MODEL_INFO,
  id: DEEPSEEK_CACHED_MODEL_ID,
  backend: ModelBackend.DeepSeek,
} as unknown as ModelInfo;

const BEDROCK_MODEL_ID = 'reservation-test-bedrock';
// Explicit cache_read: the exclusion under test must come from the backend, not a missing rate.
const CACHE_READ_PRICING = { 200_000: { input: 5 / 1_000_000, output: 25 / 1_000_000, cache_read: 0.5 / 1_000_000 } };
const BEDROCK_MODEL_INFO = {
  ...MODEL_INFO,
  id: BEDROCK_MODEL_ID,
  backend: ModelBackend.Bedrock,
  pricing: CACHE_READ_PRICING,
} as unknown as ModelInfo;

const GEMINI_MODEL_ID = 'reservation-test-gemini';
const GEMINI_MODEL_INFO = {
  ...MODEL_INFO,
  id: GEMINI_MODEL_ID,
  backend: ModelBackend.Gemini,
  pricing: CACHE_READ_PRICING,
} as unknown as ModelInfo;

const XAI_MODEL_ID = 'reservation-test-xai';
const XAI_MODEL_INFO = {
  ...MODEL_INFO,
  id: XAI_MODEL_ID,
  backend: ModelBackend.XAI,
  pricing: CACHE_READ_PRICING,
} as unknown as ModelInfo;

// Literal rates (per token) so the tier test asserts a figure not derived from getTextModelCost.
const TIERED_MODEL_ID = 'reservation-test-tiered';
const TIERED_MODEL_INFO = {
  ...MODEL_INFO,
  id: TIERED_MODEL_ID,
  pricing: {
    50_000: { input: 1 / 1_000_000, output: 2 / 1_000_000 },
    200_000: { input: 10 / 1_000_000, output: 20 / 1_000_000 },
  },
} as unknown as ModelInfo;

// Same pricing, but reasoning tokens bill inside the output budget, so this one must
// hold the larger reasoning figure. 'adaptive' is what real reasonsWithinOutputBudget
// keys off - it is deliberately NOT mocked here.
const REASONING_MODEL_ID = 'reservation-test-reasoning-model';
const REASONING_MODEL_INFO = {
  ...MODEL_INFO,
  id: REASONING_MODEL_ID,
  name: 'Reservation Test Reasoning',
  thinkingStyle: 'adaptive',
} as unknown as ModelInfo;

vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn(async () => [
    MODEL_INFO,
    REASONING_MODEL_INFO,
    OPENAI_MODEL_INFO,
    OPENAI_CACHED_MODEL_INFO,
    KIMI_CACHED_MODEL_INFO,
    DEEPSEEK_CACHED_MODEL_INFO,
    BEDROCK_MODEL_INFO,
    GEMINI_MODEL_INFO,
    XAI_MODEL_INFO,
    TIERED_MODEL_INFO,
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
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => true), // enforceCredits = true
  getSettingsByNames: vi.fn(),
}));

import { executeCompletion } from './cliCompletions';

const expectedHold = usdToCredits(getTextModelCost(MODEL_INFO, INPUT_TOKENS, reservationOutputTokens(MAX_TOKENS)));
const expectedReasoningHold = usdToCredits(
  getTextModelCost(REASONING_MODEL_INFO, INPUT_TOKENS, reservationOutputTokens(MAX_TOKENS, true))
);
const ceilingCredits = usdToCredits(getTextModelCost(MODEL_INFO, INPUT_TOKENS, MAX_TOKENS));

function buildDb(org?: Record<string, unknown>) {
  const users = {
    incrementCredits: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100_000 }),
    findById: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100_000 }),
  };
  const organizations = {
    findById: vi.fn().mockResolvedValue(org ?? null),
    incrementCredits: vi.fn().mockResolvedValue({ ...(org ?? {}), currentCredits: 100_000 }),
    ensureUserDetails: vi.fn().mockResolvedValue(undefined),
    updateUserDetails: vi.fn().mockResolvedValue(undefined),
  };
  return {
    db: {
      adminSettings: {} as any,
      apiKeys: {} as any,
      creditTransactions: {} as any,
      users: users as any,
      usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as any,
      organizations: organizations as any,
    },
    users,
    organizations,
  };
}

const baseParams = {
  userId: 'user1',
  model: MODEL_ID,
  messages: [{ role: 'user' as const, content: 'hi' }],
  apiKeyInfo: { keyId: 'k1', keyName: 'CI key' },
  onChunk: vi.fn().mockResolvedValue(undefined),
  options: { maxTokens: MAX_TOKENS },
};

describe('executeCompletion - pre-flight reservation size', () => {
  beforeEach(() => vi.clearAllMocks());

  it('holds the reservation ceiling, not the full max_tokens window', async () => {
    const { db, users } = buildDb();

    await executeCompletion({ ...baseParams, db });

    expect(MAX_TOKENS).toBeGreaterThan(PREFLIGHT_RESERVATION_OUTPUT_TOKENS);
    expect(expectedHold).toBeLessThan(ceilingCredits);
    expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expectedHold);
  });

  it('checks the org per-member cap against the raw ceiling, not the shrunk hold', async () => {
    // Cap sits between the two figures: the hold clears it, the worst case does not.
    const capBetween = Math.floor((expectedHold + ceilingCredits) / 2);
    const org = {
      id: 'org1',
      name: 'Org',
      currentCredits: 100_000,
      maxCreditsPerMember: capBetween,
      userDetails: [],
      users: [{ userId: 'user1' }],
    };
    const { db, organizations } = buildDb(org);

    await expect(executeCompletion({ ...baseParams, db, billingOrganizationId: 'org1' })).rejects.toThrow(
      // Pinned to the cap message: a bare /credit/i also matches the CLI_CREDITS membership
      // refusal, so this would pass without ever reaching the cap check.
      /member credit limit/i
    );

    // Blocked before the pool was touched.
    expect(organizations.incrementCredits).not.toHaveBeenCalled();
  });

  it('holds the larger reasoning ceiling for a model that reasons inside its output budget', async () => {
    const { db, users } = buildDb();

    await executeCompletion({ ...baseParams, model: REASONING_MODEL_ID, db });

    expect(MAX_TOKENS).toBeGreaterThan(PREFLIGHT_RESERVATION_REASONING_OUTPUT_TOKENS);
    expect(expectedReasoningHold).toBeGreaterThan(expectedHold);
    expect(expectedReasoningHold).toBeLessThan(ceilingCredits);
    expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expectedReasoningHold);
  });

  describe('cached conversation context', () => {
    // A small explicit budget keeps the output hold from drowning the input side under test.
    const ROUND_MAX_TOKENS = 1_024;
    const OUTPUT = ROUND_MAX_TOKENS;
    const roundParams = { ...baseParams, options: { maxTokens: ROUND_MAX_TOKENS } };
    // 2.5 chars per estimated token
    const text = (tokens: number) => 'x'.repeat(tokens * 2.5);
    const toolLoop = (cache: boolean) => [
      { role: 'system' as const, content: text(10_000), cache },
      { role: 'user' as const, content: text(20_000) },
      { role: 'assistant' as const, content: text(30_000), cache },
      { role: 'user' as const, content: text(8_000) },
    ];

    it('prices a conversation flagged at the last assistant message at read before it, write for it, plain for the tail', async () => {
      const { db, users } = buildDb();
      await executeCompletion({ ...roundParams, db, messages: toolLoop(true) });

      const expected = usdToCredits(getTextModelCost(MODEL_INFO, 8_000, OUTPUT, 30_000, 30_000));
      const uncached = usdToCredits(getTextModelCost(MODEL_INFO, 68_000, OUTPUT));
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expected);
      expect(expected).toBeLessThan(uncached);
    });

    it('prices the flagged tail at cache_write when the rolling breakpoint rides the newest message', async () => {
      const { db, users } = buildDb();
      const messages = toolLoop(true);
      messages[3] = { ...messages[3], cache: true } as (typeof messages)[number];
      await executeCompletion({ ...roundParams, db, messages });

      const expected = usdToCredits(getTextModelCost(MODEL_INFO, 0, OUTPUT, 30_000, 38_000));
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expected);
    });

    it('prices the history at plain input when only the system message is flagged', async () => {
      const { db, users } = buildDb();
      const messages = toolLoop(false);
      messages[0] = { ...messages[0], cache: true } as (typeof messages)[number];
      await executeCompletion({ ...roundParams, db, messages });

      const expected = usdToCredits(getTextModelCost(MODEL_INFO, 58_000, OUTPUT, 10_000, 0));
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expected);
    });

    it('does not count a system message after the last assistant message as cached prefix', async () => {
      const { db, users } = buildDb();
      const messages = [
        { role: 'user' as const, content: text(20_000), cache: true },
        { role: 'assistant' as const, content: text(30_000) },
        { role: 'system' as const, content: text(8_000), cache: true },
      ];
      await executeCompletion({ ...roundParams, db, messages });

      const expected = usdToCredits(getTextModelCost(MODEL_INFO, 30_000, OUTPUT, 28_000, 0));
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expected);
    });

    it('does not move the conversation breakpoint when a system message mid-array is flagged', async () => {
      const { db, users } = buildDb();
      const messages = [
        { role: 'user' as const, content: text(20_000) },
        { role: 'assistant' as const, content: text(30_000) },
        { role: 'user' as const, content: text(10_000) },
        { role: 'assistant' as const, content: text(20_000) },
        { role: 'system' as const, content: text(5_000), cache: true },
        { role: 'user' as const, content: text(5_000) },
      ];
      await executeCompletion({ ...roundParams, db, messages });

      const expected = usdToCredits(getTextModelCost(MODEL_INFO, 85_000, OUTPUT, 5_000, 0));
      const historyAsRead = usdToCredits(getTextModelCost(MODEL_INFO, 5_000, OUTPUT, 80_000, 0));
      expect(expected).not.toBe(historyAsRead);
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expected);
    });

    it('selects the pricing tier from the total input, not the uncached remainder', async () => {
      const { db, users } = buildDb();
      await executeCompletion({ ...roundParams, model: TIERED_MODEL_ID, db, messages: toolLoop(true) });

      // 68k total is in the 200k tier ($10/M in, $20/M out); read 0.1x, write 1.25x. The 8k plain tail alone would pick the 50k tier.
      const usd = 10e-6 * 8_000 + 20e-6 * OUTPUT + 10e-6 * 0.1 * 30_000 + 10e-6 * 1.25 * 30_000;
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -usdToCredits(usd));
    });

    it('prices the first round (no assistant message) fully uncached', async () => {
      const { db, users } = buildDb();
      const messages = [
        { role: 'system' as const, content: text(10_000), cache: true },
        { role: 'user' as const, content: text(20_000) },
      ];
      await executeCompletion({ ...roundParams, db, messages });

      const expected = usdToCredits(getTextModelCost(MODEL_INFO, 30_000, OUTPUT));
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expected);
    });

    it('leaves a conversation the client did not flag for caching unchanged', async () => {
      const { db, users } = buildDb();
      await executeCompletion({ ...roundParams, db, messages: toolLoop(false) });

      const expected = usdToCredits(getTextModelCost(MODEL_INFO, 68_000, OUTPUT));
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expected);
    });

    it.each([
      ['Bedrock (this path never enables its caching)', BEDROCK_MODEL_ID, BEDROCK_MODEL_INFO],
      ['Gemini (not an auto-caching backend)', GEMINI_MODEL_ID, GEMINI_MODEL_INFO],
      ['xAI (its adapter reports no cache reads)', XAI_MODEL_ID, XAI_MODEL_INFO],
    ])('leaves a %s conversation uncached despite a published cache_read', async (_name, id, info) => {
      const { db, users } = buildDb();
      await executeCompletion({ ...roundParams, model: id, db, messages: toolLoop(true) });

      const expected = usdToCredits(getTextModelCost(info, 68_000, OUTPUT));
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expected);
    });

    it('leaves a backend without a published cache_read rate unchanged', async () => {
      const { db, users } = buildDb();
      await executeCompletion({ ...roundParams, model: OPENAI_MODEL_ID, db, messages: toolLoop(true) });

      const expected = usdToCredits(getTextModelCost(OPENAI_MODEL_INFO, 68_000, OUTPUT));
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expected);
    });

    it.each([
      ['OpenAI', OPENAI_CACHED_MODEL_ID, OPENAI_CACHED_MODEL_INFO],
      ['Kimi', KIMI_CACHED_MODEL_ID, KIMI_CACHED_MODEL_INFO],
      ['DeepSeek', DEEPSEEK_CACHED_MODEL_ID, DEEPSEEK_CACHED_MODEL_INFO],
    ])('prices %s (auto-caching, published cache_read) up to the last assistant message', async (_name, id, info) => {
      const { db, users } = buildDb();
      await executeCompletion({ ...roundParams, model: id, db, messages: toolLoop(false) });

      const expected = usdToCredits(getTextModelCost(info, 38_000, OUTPUT, 30_000, 0));
      const uncached = usdToCredits(getTextModelCost(info, 68_000, OUTPUT));
      expect(expected).toBeLessThan(uncached);
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expected);
    });

    it('bills an auto-caching backend system message after the last assistant message as plain input', async () => {
      const { db, users } = buildDb();
      const messages = [
        { role: 'user' as const, content: text(20_000) },
        { role: 'assistant' as const, content: text(30_000) },
        { role: 'system' as const, content: text(8_000) },
        { role: 'user' as const, content: text(5_000) },
      ];
      await executeCompletion({ ...roundParams, model: OPENAI_CACHED_MODEL_ID, db, messages });

      const expected = usdToCredits(getTextModelCost(OPENAI_CACHED_MODEL_INFO, 43_000, OUTPUT, 20_000, 0));
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expected);
    });

    it('reads a system message that precedes the last assistant message on an auto-caching backend', async () => {
      const { db, users } = buildDb();
      const messages = [
        { role: 'user' as const, content: text(20_000) },
        { role: 'system' as const, content: text(8_000) },
        { role: 'assistant' as const, content: text(30_000) },
        { role: 'user' as const, content: text(5_000) },
      ];
      await executeCompletion({ ...roundParams, model: OPENAI_CACHED_MODEL_ID, db, messages });

      const expected = usdToCredits(getTextModelCost(OPENAI_CACHED_MODEL_INFO, 35_000, OUTPUT, 28_000, 0));
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expected);
    });

    it('prices a multi-round tool loop: read through the round before last, write for the last assistant and result', async () => {
      const { db, users } = buildDb();
      const messages = [
        { role: 'system' as const, content: text(10_000), cache: true },
        { role: 'user' as const, content: text(2_000) },
        { role: 'assistant' as const, content: text(500) },
        { role: 'user' as const, content: text(3_000) },
        { role: 'assistant' as const, content: text(500) },
        { role: 'user' as const, content: text(8_000), cache: true },
      ];
      await executeCompletion({ ...roundParams, db, messages });

      const expected = usdToCredits(getTextModelCost(MODEL_INFO, 0, OUTPUT, 15_500, 8_500));
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expected);
    });

    it('caches a conversation-flagged loop without any flagged system message', async () => {
      const { db, users } = buildDb();
      const messages = toolLoop(true);
      messages[0] = { ...messages[0], cache: false };
      await executeCompletion({ ...roundParams, db, messages });

      const expected = usdToCredits(getTextModelCost(MODEL_INFO, 8_000, OUTPUT, 30_000, 30_000));
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expected);
    });

    it('holds half the uncached input when a flagged cache has nothing behind it (cold-cache probe)', async () => {
      const { db, users } = buildDb();
      const messages = [
        { role: 'user' as const, content: text(180_000) },
        { role: 'assistant' as const, content: 'x' },
        { role: 'user' as const, content: 'go', cache: true },
      ];
      await executeCompletion({ ...baseParams, options: { maxTokens: 1 }, db, messages });

      const output = reservationOutputTokens(1);
      const segmented = usdToCredits(getTextModelCost(MODEL_INFO, 0, output, 180_000, 2));
      const expected = usdToCredits(0.5 * 5e-6 * 180_002 + 25e-6 * output);
      const uncached = usdToCredits(getTextModelCost(MODEL_INFO, 180_002, output));
      expect(segmented).toBeLessThan(expected);
      expect(expected).toBeGreaterThan(uncached / 2 - 1);
      expect(expected).toBeLessThanOrEqual(Math.ceil(uncached / 2));
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expected);
    });

    it('prices the 68k desktop shape (system + rolling breakpoint, reasoning model) far below the old uncached hold', async () => {
      const { db, users } = buildDb();
      const messages = [
        { role: 'system' as const, content: text(8_000), cache: true },
        { role: 'user' as const, content: text(10_000) },
        { role: 'assistant' as const, content: text(40_000) },
        { role: 'user' as const, content: text(10_000), cache: true },
      ];
      await executeCompletion({ ...baseParams, model: REASONING_MODEL_ID, db, messages });

      const output = reservationOutputTokens(MAX_TOKENS, true);
      const expected = usdToCredits(getTextModelCost(REASONING_MODEL_INFO, 0, output, 18_000, 50_000));
      const uncached = usdToCredits(getTextModelCost(REASONING_MODEL_INFO, 68_000, output));
      expect(expected).toBeLessThan(uncached);
      expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -expected);
    });
  });
});
