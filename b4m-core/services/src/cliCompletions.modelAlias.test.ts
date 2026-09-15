import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression cover for issue #2745: `model: "gpt-4.1"` (OpenAI's bare alias) failed with
 * "Failed to create LLM backend for model: gpt-4.1" because our catalog stores the dated
 * snapshot id (ChatModels.GPT4_1 = 'gpt-4.1-2025-04-14'), which a plain `.find()` never
 * matches against the bare name.
 */
vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
  isMemberCreditCapExceeded: vi.fn(() => false),
}));

let capturedModelInfoId: string | undefined;
let capturedCompleteModel: unknown;

const { DATED_GPT_4_1 } = vi.hoisted(() => ({
  DATED_GPT_4_1: {
    id: 'gpt-4.1-2025-04-14',
    backend: 'openai',
    max_tokens: 32_768,
  },
}));

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn().mockResolvedValue([DATED_GPT_4_1]),
  getLlmByModel: vi.fn((_apiKeyTable: unknown, options: { modelInfo?: { id: string } }) => {
    capturedModelInfoId = options.modelInfo?.id;
    if (!options.modelInfo) return null;
    return {
      currentModel: '',
      complete: vi.fn(async (model: unknown, _messages: unknown, _options: unknown, onChunk: any) => {
        capturedCompleteModel = model;
        await onChunk([''], { inputTokens: 1, outputTokens: 1 });
      }),
    };
  }),
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  usdToCredits: vi.fn(() => 10),
  usdToCreditsStochastic: vi.fn(() => 10),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => true),
  getSettingsByNames: vi.fn(),
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  getTextModelCost: vi.fn(() => 0.001),
}));

import { executeCompletion } from './cliCompletions';

function buildDb() {
  const users = {
    incrementCredits: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100_000 }),
    findById: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100_000 }),
  };
  return {
    db: {
      adminSettings: {} as any,
      apiKeys: {} as any,
      creditTransactions: {} as any,
      users: users as any,
      usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as any,
      organizations: {} as any,
    },
  };
}

const baseParams = {
  userId: 'user1',
  messages: [{ role: 'user' as const, content: 'hi' }],
  onChunk: vi.fn().mockResolvedValue(undefined),
};

describe('executeCompletion - OpenAI bare model alias resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedModelInfoId = undefined;
    capturedCompleteModel = undefined;
  });

  it('resolves the bare "gpt-4.1" alias to the catalog\'s dated snapshot id', async () => {
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, model: 'gpt-4.1', db });

    expect(capturedModelInfoId).toBe('gpt-4.1-2025-04-14');
    expect(capturedCompleteModel).toBe('gpt-4.1-2025-04-14');
  });

  it('still resolves the canonical dated id directly', async () => {
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, model: 'gpt-4.1-2025-04-14', db });

    expect(capturedModelInfoId).toBe('gpt-4.1-2025-04-14');
  });

  it('raises the original, unaliased id when the model is genuinely unknown', async () => {
    const { db } = buildDb();

    await expect(executeCompletion({ ...baseParams, model: 'not-a-real-model', db })).rejects.toThrow(
      'Failed to create LLM backend for model: not-a-real-model'
    );
  });

  // A plain-object alias map would return Object.prototype members (the Object
  // constructor, Object.prototype.toString, ...) for these keys instead of undefined.
  it('does not resolve prototype-property names to an inherited value', async () => {
    const { db } = buildDb();

    await expect(executeCompletion({ ...baseParams, model: 'constructor', db })).rejects.toThrow(
      'Failed to create LLM backend for model: constructor'
    );
  });
});
