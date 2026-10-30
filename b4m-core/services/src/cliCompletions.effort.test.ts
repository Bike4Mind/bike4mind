import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The effort the completions endpoint defaults for adaptive-thinking Claude models. */
// The free-tier gate reads settings these fixtures do not model; llm/modelAdmission.test.ts covers it.
vi.mock('./llm/modelAdmission', async importOriginal => ({
  ...(await importOriginal<typeof import('./llm/modelAdmission')>()),
  loadFreeTierAllowedModels: async () => undefined,
}));

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

import { ChatModels } from '@bike4mind/common';
import { executeCompletion } from './cliCompletions';

const claude = (id: string, backend: 'anthropic' | 'bedrock', thinkingStyle?: 'adaptive') => ({
  id,
  type: 'text' as const,
  backend,
  max_tokens: 128_000,
  can_think: true,
  pricing: { 200_000: { input: 1 / 1_000_000, output: 1 / 1_000_000 } },
  ...(thinkingStyle ? { thinkingStyle } : {}),
});

const DIRECT = claude(ChatModels.CLAUDE_5_OPUS, 'anthropic', 'adaptive');
const BEDROCK = claude(ChatModels.CLAUDE_5_5_SONNET_BEDROCK, 'bedrock', 'adaptive');
const FABLE = claude(ChatModels.CLAUDE_FABLE_5, 'anthropic', 'adaptive');
// Adaptive, but it only thinks when asked, so an injected effort would switch thinking on.
const ADAPTIVE_ON_REQUEST = claude(ChatModels.CLAUDE_4_7_OPUS, 'anthropic', 'adaptive');
const LEGACY_THINKER = claude(ChatModels.CLAUDE_4_6_SONNET, 'anthropic');
const OPENAI = {
  id: ChatModels.GPT5_4,
  type: 'text' as const,
  backend: 'openai',
  max_tokens: 128_000,
  can_think: true,
  pricing: { 200_000: { input: 1 / 1_000_000, output: 1 / 1_000_000 } },
};

function buildDb() {
  return {
    adminSettings: {} as any,
    apiKeys: {} as any,
    creditTransactions: {} as any,
    users: {
      incrementCredits: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100_000 }),
      findById: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100_000 }),
    } as any,
    usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as any,
    organizations: {} as any,
  };
}

const run = (model: { id: string }, options?: Parameters<typeof executeCompletion>[0]['options']) =>
  executeCompletion({
    userId: 'user1',
    messages: [{ role: 'user', content: 'hi' }],
    onChunk: vi.fn().mockResolvedValue(undefined),
    model: model.id,
    db: buildDb(),
    options,
  });

describe('executeCompletion - default effort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOptions = undefined;
    availableModels = [DIRECT, BEDROCK, FABLE, ADAPTIVE_ON_REQUEST, LEGACY_THINKER, OPENAI];
  });

  it.each([
    ['direct Opus 5', DIRECT],
    ['Bedrock Sonnet 5.5', BEDROCK],
    ['direct Fable 5', FABLE],
  ])('runs %s at medium when the caller sends no effort or thinking', async (_label, model) => {
    await run(model);
    expect(capturedOptions?.reasoningEffort).toBe('medium');
    expect(capturedOptions).not.toHaveProperty('thinking');
  });

  it('keeps medium alongside tools and streaming', async () => {
    const tool = { toolSchema: { name: 'lookup', description: 'd', parameters: { type: 'object' as const } } };
    await run(DIRECT, { stream: true, tools: [tool] });
    expect(capturedOptions).toMatchObject({ reasoningEffort: 'medium', stream: true });
    expect(capturedOptions?.tools).toHaveLength(1);
  });

  it.each([
    ['direct', DIRECT],
    ['Bedrock', BEDROCK],
  ])('keeps an explicit high on %s', async (_label, model) => {
    await run(model, { reasoningEffort: 'high' });
    expect(capturedOptions?.reasoningEffort).toBe('high');
  });

  it.each([
    ['direct', DIRECT],
    ['Bedrock', BEDROCK],
  ])('keeps an explicit low on %s', async (_label, model) => {
    await run(model, { reasoningEffort: 'low' });
    expect(capturedOptions?.reasoningEffort).toBe('low');
  });

  it('keeps an explicit none, which turns thinking off', async () => {
    await run(DIRECT, { reasoningEffort: 'none' });
    expect(capturedOptions?.reasoningEffort).toBe('none');
  });

  it.each([
    ['direct', DIRECT],
    ['Bedrock', BEDROCK],
  ])('injects no effort when the caller disabled thinking on %s', async (_label, model) => {
    await run(model, { thinking: { enabled: false } });
    expect(capturedOptions).not.toHaveProperty('reasoningEffort');
    expect(capturedOptions).not.toHaveProperty('thinking');
  });

  it('injects no effort when the caller enabled thinking, leaving the effort to the backend', async () => {
    await run(DIRECT, { thinking: { enabled: true } });
    expect(capturedOptions).not.toHaveProperty('reasoningEffort');
    expect(capturedOptions?.thinking).toEqual({ enabled: true, budget_tokens: 16000 });
  });

  it.each([
    ['an adaptive Claude that only thinks when asked', ADAPTIVE_ON_REQUEST],
    ['a legacy-thinking Claude (Sonnet 4.6)', LEGACY_THINKER],
    ['a non-Claude model', OPENAI],
  ])('injects no effort for %s', async (_label, model) => {
    await run(model);
    expect(capturedOptions).not.toHaveProperty('reasoningEffort');
  });
});
