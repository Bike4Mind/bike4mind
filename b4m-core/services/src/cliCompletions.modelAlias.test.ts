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

vi.mock('@bike4mind/llm-adapters', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/llm-adapters')>();
  return {
    ...actual,
    isModelProviderConfigured: vi.fn(actual.isModelProviderConfigured),
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
  };
});
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

import { BadRequestError, ChatModels } from '@bike4mind/common';
import { executeCompletion } from './cliCompletions';
import { getEffectiveLLMApiKeys } from './apiKeyService';
import { getAvailableModels, isModelProviderConfigured } from '@bike4mind/llm-adapters';

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
    vi.unstubAllEnvs();
    vi.stubEnv('B4M_SELF_HOST', '');
    vi.stubEnv('BEDROCK_AWS_ACCESS_KEY_ID', '');
    vi.stubEnv('BEDROCK_AWS_SECRET_ACCESS_KEY', '');
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

    const rejection = executeCompletion({ ...baseParams, model: 'not-a-real-model', db });
    await expect(rejection).rejects.toThrow(
      "Unknown model 'not-a-real-model'. List the models this key can call with GET /api/v1/models."
    );
    await expect(rejection).rejects.toBeInstanceOf(BadRequestError);
    await expect(rejection).rejects.toMatchObject({ additionalInfo: { errorCode: 'unknown_model' } });
    expect(isModelProviderConfigured).not.toHaveBeenCalled();
  });

  it("names the caller's id, not the alias-resolved id, in the unknown_model message", async () => {
    vi.mocked(getEffectiveLLMApiKeys).mockResolvedValueOnce({ openai: 'openai-key' } as never);
    vi.mocked(getAvailableModels).mockResolvedValueOnce([]);
    const { db } = buildDb();

    const rejection = executeCompletion({ ...baseParams, model: 'gpt-4.1', db });
    await expect(rejection).rejects.toThrow(
      "Unknown model 'gpt-4.1'. List the models this key can call with GET /api/v1/models."
    );
    await expect(rejection).rejects.not.toThrow('gpt-4.1-2025-04-14');
    await expect(rejection).rejects.toMatchObject({ additionalInfo: { errorCode: 'unknown_model' } });
  });

  it("raises a retryable 503 provider_not_configured when the catalogued model's provider has no key", async () => {
    const { db } = buildDb();

    const rejection = executeCompletion({ ...baseParams, model: ChatModels.GEMINI_2_5_FLASH, db });
    await expect(rejection).rejects.toThrow(`Failed to create LLM backend for model: ${ChatModels.GEMINI_2_5_FLASH}`);
    await expect(rejection).rejects.not.toBeInstanceOf(BadRequestError);
    await expect(rejection).rejects.toMatchObject({
      statusCode: 503,
      additionalInfo: { errorCode: 'provider_not_configured' },
    });
  });

  it('raises a 400 unknown_model when the provider key is present but the model is not available to the caller', async () => {
    vi.mocked(getEffectiveLLMApiKeys).mockResolvedValueOnce({ gemini: 'gemini-key' } as never);
    const { db } = buildDb();

    const rejection = executeCompletion({ ...baseParams, model: ChatModels.GEMINI_2_5_FLASH, db });
    await expect(rejection).rejects.toBeInstanceOf(BadRequestError);
    await expect(rejection).rejects.toThrow(
      `Unknown model '${ChatModels.GEMINI_2_5_FLASH}'. List the models this key can call with GET /api/v1/models.`
    );
    await expect(rejection).rejects.toMatchObject({ additionalInfo: { errorCode: 'unknown_model' } });
  });

  it('raises a retryable 503 for a Bedrock model on self-host without BEDROCK_AWS_* credentials', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    const { db } = buildDb();

    const rejection = executeCompletion({ ...baseParams, model: ChatModels.CLAUDE_4_SONNET_BEDROCK, db });
    await expect(rejection).rejects.toMatchObject({
      statusCode: 503,
      additionalInfo: { errorCode: 'provider_not_configured' },
    });
  });

  it('raises a plain 400 for an unlisted Bedrock model on hosted, where Bedrock is always reachable', async () => {
    const { db } = buildDb();

    const rejection = executeCompletion({ ...baseParams, model: ChatModels.CLAUDE_4_SONNET_BEDROCK, db });
    await expect(rejection).rejects.toBeInstanceOf(BadRequestError);
  });

  // Ollama is the one listing that does network I/O and can time out; its ids are in no static table.
  it('raises a retryable 503 for a catalogued Ollama model even with Ollama configured', async () => {
    vi.mocked(getEffectiveLLMApiKeys).mockResolvedValueOnce({ ollama: 'http://ollama.local:11434' } as never);
    const { db } = buildDb();

    const rejection = executeCompletion({ ...baseParams, model: ChatModels.DEEPSEEK_R1, db });
    await expect(rejection).rejects.toMatchObject({
      statusCode: 503,
      additionalInfo: { errorCode: 'provider_not_configured' },
    });
  });

  it('falls back to a retryable 503 and logs when the provider check throws', async () => {
    vi.mocked(getEffectiveLLMApiKeys).mockResolvedValueOnce({ gemini: 'gemini-key' } as never);
    vi.mocked(isModelProviderConfigured).mockRejectedValueOnce(new Error('boom'));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const { db } = buildDb();

    const rejection = executeCompletion({
      ...baseParams,
      model: ChatModels.GEMINI_2_5_FLASH,
      db,
      logger: logger as never,
    });
    await expect(rejection).rejects.toMatchObject({
      statusCode: 503,
      additionalInfo: { errorCode: 'provider_not_configured' },
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('provider check failed'),
      expect.objectContaining({ model: ChatModels.GEMINI_2_5_FLASH })
    );
  });

  // A plain-object alias map would return Object.prototype members (the Object
  // constructor, Object.prototype.toString, ...) for these keys instead of undefined.
  it('does not resolve prototype-property names to an inherited value', async () => {
    const { db } = buildDb();

    await expect(executeCompletion({ ...baseParams, model: 'constructor', db })).rejects.toThrow(
      "Unknown model 'constructor'. List the models this key can call with GET /api/v1/models."
    );
  });
});
