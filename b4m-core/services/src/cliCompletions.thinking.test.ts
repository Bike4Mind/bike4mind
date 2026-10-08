import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The `thinking` option the completions endpoint accepts, and what it hands the backend. */
vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
  isMemberCreditCapExceeded: vi.fn(() => false),
}));

let capturedOptions: Record<string, any> | undefined;
let availableModels: Array<Record<string, unknown>> = [];

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

import { executeCompletion } from './cliCompletions';

const ADAPTIVE_MODEL = {
  id: 'adaptive-model',
  backend: 'anthropic',
  max_tokens: 128_000,
  can_think: true,
  thinkingStyle: 'adaptive' as const,
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

describe('executeCompletion - thinking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOptions = undefined;
    availableModels = [ADAPTIVE_MODEL];
  });

  it('passes an enabled thinking option through to the backend', async () => {
    const { db } = buildDb();
    await executeCompletion({ ...baseParams, model: 'adaptive-model', db, options: { thinking: { enabled: true } } });
    expect(capturedOptions?.thinking).toEqual({ enabled: true, budget_tokens: 16000 });
  });

  it('keeps an explicit budget', async () => {
    const { db } = buildDb();
    await executeCompletion({
      ...baseParams,
      model: 'adaptive-model',
      db,
      options: { thinking: { enabled: true, budget_tokens: 4000 } },
    });
    expect(capturedOptions?.thinking).toEqual({ enabled: true, budget_tokens: 4000 });
  });

  it('never asks a model that cannot think to think', async () => {
    availableModels = [{ ...ADAPTIVE_MODEL, can_think: false }];
    const { db } = buildDb();
    await executeCompletion({ ...baseParams, model: 'adaptive-model', db, options: { thinking: { enabled: true } } });
    expect(capturedOptions).not.toHaveProperty('thinking');
  });

  it('passes the effort alongside thinking', async () => {
    const { db } = buildDb();
    await executeCompletion({
      ...baseParams,
      model: 'adaptive-model',
      db,
      options: { thinking: { enabled: true }, reasoningEffort: 'low' },
    });
    expect(capturedOptions).toMatchObject({ thinking: { enabled: true }, reasoningEffort: 'low' });
  });

  it('asks for no thinking when the caller did not', async () => {
    const { db } = buildDb();
    await executeCompletion({ ...baseParams, model: 'adaptive-model', db, options: { thinking: { enabled: false } } });
    expect(capturedOptions).not.toHaveProperty('thinking');
  });
});
