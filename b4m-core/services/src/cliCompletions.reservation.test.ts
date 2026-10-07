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

// Same pricing, but reasoning tokens bill inside the output budget, so this one must
// hold the larger reasoning figure. 'adaptive' is what real reasonsWithinOutputBudget
// keys off - it is deliberately NOT mocked here.
const OPUS_MODEL_ID = 'reservation-test-opus';
const OPUS_MODEL_INFO = { ...MODEL_INFO, id: OPUS_MODEL_ID, name: 'Reservation Test Opus' } as unknown as ModelInfo;

const OPENAI_MODEL_ID = 'reservation-test-openai';
const OPENAI_MODEL_INFO = {
  ...MODEL_INFO,
  id: OPENAI_MODEL_ID,
  backend: ModelBackend.OpenAI,
  pricing: { 200_000: { input: 5 / 1_000_000, output: 25 / 1_000_000 } },
} as unknown as ModelInfo;

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
  getAvailableModels: vi.fn(async () => [MODEL_INFO, REASONING_MODEL_INFO, OPUS_MODEL_INFO, OPENAI_MODEL_INFO]),
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
    const reserved = (users: { incrementCredits: ReturnType<typeof vi.fn> }) =>
      -(users.incrementCredits.mock.calls[0][1] as number);
    const toolLoop = (cache: boolean) => [
      { role: 'system' as const, content: text(10_000), cache },
      { role: 'user' as const, content: text(20_000) },
      { role: 'assistant' as const, content: text(30_000), cache },
      { role: 'user' as const, content: text(8_000) },
    ];

    it('prices a flagged multi-round Anthropic conversation at the cache rates', async () => {
      const { db, users } = buildDb();
      await executeCompletion({ ...roundParams, db, messages: toolLoop(true) });

      const expected = usdToCredits(getTextModelCost(MODEL_INFO, 0, OUTPUT, 60_000, 8_000));
      const uncached = usdToCredits(getTextModelCost(MODEL_INFO, 68_000, OUTPUT));
      expect(reserved(users)).toBe(expected);
      expect(expected).toBeLessThan(uncached * 0.6);
    });

    it('prices the first round (no assistant message) fully uncached', async () => {
      const { db, users } = buildDb();
      const messages = [
        { role: 'system' as const, content: text(10_000), cache: true },
        { role: 'user' as const, content: text(20_000) },
      ];
      await executeCompletion({ ...roundParams, db, messages });

      expect(reserved(users)).toBe(usdToCredits(getTextModelCost(MODEL_INFO, 30_000, OUTPUT)));
    });

    it('leaves a conversation the client did not flag for caching unchanged', async () => {
      const { db, users } = buildDb();
      await executeCompletion({ ...roundParams, db, messages: toolLoop(false) });

      expect(reserved(users)).toBe(usdToCredits(getTextModelCost(MODEL_INFO, 68_000, OUTPUT)));
    });

    it('leaves a non-caching model unchanged', async () => {
      const { db, users } = buildDb();
      await executeCompletion({ ...roundParams, model: OPENAI_MODEL_ID, db, messages: toolLoop(true) });

      expect(reserved(users)).toBe(usdToCredits(getTextModelCost(OPENAI_MODEL_INFO, 68_000, OUTPUT)));
    });

    it('no longer over-reserves the 68k-token opus tool-loop round that was refused at ~2518 credits', async () => {
      const { db, users } = buildDb();
      const messages = [
        { role: 'system' as const, content: text(8_000), cache: true },
        { role: 'user' as const, content: text(10_000) },
        { role: 'assistant' as const, content: text(40_000), cache: true },
        { role: 'user' as const, content: text(10_000) },
      ];
      await executeCompletion({ ...roundParams, model: OPUS_MODEL_ID, db, messages });

      expect(usdToCredits(getTextModelCost(OPUS_MODEL_INFO, 68_000, OUTPUT))).toBeGreaterThan(600);
      expect(reserved(users)).toBeLessThan(400);
    });
  });
});
