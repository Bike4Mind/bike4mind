import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The output budget the CLI path sends, and the credit hold it does NOT inflate.
 *
 * Regression cover for a silent truncation bug: this path used to hardcode
 * `options?.maxTokens ?? 4096`, which capped adaptive-reasoning models at 4096 TOTAL.
 * Those models spend extended thinking inside max_tokens, so reasoning consumed the
 * budget and the visible answer was cut off mid-sentence with nothing reported.
 *
 * Unlike the sibling cliCompletions suites, this one keeps the REAL
 * resolveOutputMaxTokens - a stubbed sizing rule could not catch a regression in the
 * rule itself, which is the whole subject here.
 */
vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
}));

let capturedOptions: Record<string, any> | undefined;
let availableModels: Array<Record<string, unknown>> = [];
/** Stop reason the stubbed backend reports on its terminal chunk; undefined = reports none. */
let backendStopReason: string | undefined;

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn(async () => availableModels),
  getLlmByModel: vi.fn(() => ({
    currentModel: '',
    complete: vi.fn(async (_model: unknown, _messages: unknown, options: Record<string, any>, onChunk: any) => {
      capturedOptions = options;
      await onChunk([''], {
        inputTokens: 100,
        outputTokens: 50,
        ...(backendStopReason ? { stopReason: backendStopReason } : {}),
      });
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

import { getTextModelCost } from '@bike4mind/common';
import { ADAPTIVE_THINKING_MAX_TOKENS_FLOOR } from '@bike4mind/llm-adapters';
import { DEFAULT_OUTPUT_MAX_TOKENS } from '@bike4mind/utils';
import { executeCompletion } from './cliCompletions';

const ADAPTIVE_MODEL = {
  id: 'adaptive-model',
  backend: 'anthropic',
  max_tokens: 128_000,
  can_think: true,
  thinkingStyle: 'adaptive' as const,
};

const PLAIN_MODEL = {
  id: 'plain-model',
  backend: 'anthropic',
  max_tokens: 8192,
};

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
    users,
  };
}

const baseParams = {
  userId: 'user1',
  messages: [{ role: 'user' as const, content: 'hi' }],
  onChunk: vi.fn().mockResolvedValue(undefined),
};

describe('executeCompletion - output budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOptions = undefined;
    backendStopReason = undefined;
  });

  it('sizes an absent budget to the adaptive floor for a reasoning model', async () => {
    availableModels = [ADAPTIVE_MODEL];
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, model: 'adaptive-model', db });

    // The bug: this was 4096, leaving reasoning and the answer to fight over one budget.
    expect(capturedOptions?.maxTokens).toBe(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
  });

  it('leaves a non-reasoning model at the historical default', async () => {
    availableModels = [PLAIN_MODEL];
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, model: 'plain-model', db });

    expect(capturedOptions?.maxTokens).toBe(DEFAULT_OUTPUT_MAX_TOKENS);
  });

  it('never raises a budget the caller asked for explicitly', async () => {
    availableModels = [ADAPTIVE_MODEL];
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, model: 'adaptive-model', db, options: { maxTokens: 1000 } });

    expect(capturedOptions?.maxTokens).toBe(1000);
  });

  // The model cap CLAMPS the resolved budget, so an adaptive model whose runtime-discovered
  // catalog row omits max_tokens must not fall back to 4096 - that would re-pin it at
  // exactly the value this whole change exists to stop sending.
  it('does not re-pin an adaptive model whose catalog row omits max_tokens', async () => {
    availableModels = [{ ...ADAPTIVE_MODEL, max_tokens: undefined }];
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, model: 'adaptive-model', db });

    expect(capturedOptions?.maxTokens).toBeGreaterThan(DEFAULT_OUTPUT_MAX_TOKENS);
  });

  it('clamps an over-large explicit budget to the model cap', async () => {
    availableModels = [PLAIN_MODEL];
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, model: 'plain-model', db, options: { maxTokens: 999_999 } });

    expect(capturedOptions?.maxTokens).toBe(PLAIN_MODEL.max_tokens);
  });

  // The reservation is atomically deducted and rejects the turn outright, so sizing it to
  // the (now much larger) ceiling would fail short prompts for users near their balance.
  it('estimates credits from the historical basis, not the raised ceiling', async () => {
    availableModels = [ADAPTIVE_MODEL];
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, model: 'adaptive-model', db });

    expect(capturedOptions?.maxTokens).toBe(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
    // The pre-flight estimate is the FIRST cost call (later ones settle actual usage).
    expect(vi.mocked(getTextModelCost).mock.calls[0]?.[2]).toBe(DEFAULT_OUTPUT_MAX_TOKENS);
  });

  it('estimates from an explicit budget when it is below the historical basis', async () => {
    availableModels = [ADAPTIVE_MODEL];
    const { db } = buildDb();

    await executeCompletion({ ...baseParams, model: 'adaptive-model', db, options: { maxTokens: 500 } });

    expect(vi.mocked(getTextModelCost).mock.calls[0]?.[2]).toBe(500);
  });

  // Without this the CLI cannot tell a cut-off reply from a finished one, which is what
  // let the starved budget go unreported for so long.
  it('re-emits a truncation stop reason on the terminal settlement event', async () => {
    availableModels = [ADAPTIVE_MODEL];
    backendStopReason = 'max_tokens';
    const { db } = buildDb();
    const onChunk = vi.fn().mockResolvedValue(undefined);

    await executeCompletion({ ...baseParams, model: 'adaptive-model', db, onChunk });

    // Latched from the backend's chunk and repeated last, so a client that inspects only
    // the final event still learns the reply was cut off.
    expect(onChunk.mock.calls.at(-1)?.[1]).toMatchObject({ stopReason: 'max_tokens' });
  });

  it('reports no stop reason when the backend gives none', async () => {
    availableModels = [ADAPTIVE_MODEL];
    const { db } = buildDb();
    const onChunk = vi.fn().mockResolvedValue(undefined);

    await executeCompletion({ ...baseParams, model: 'adaptive-model', db, onChunk });

    // Absence must stay absence - a fabricated reason would read as truncation downstream.
    expect(onChunk.mock.calls.at(-1)?.[1]?.stopReason).toBeUndefined();
  });
});
