import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures the messages executeCompletion hands the backend: the public completions
// endpoint accepts a content array in whichever multimodal dialect the caller's SDK
// speaks, and every backend translator downstream expects one canonical shape.
let capturedMessages: Array<Record<string, any>> | undefined;

vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/llm-adapters', () => ({
  reasonsWithinOutputBudget: vi.fn(() => false),
  resolveOutputMaxTokens: vi.fn(
    ({ requested, fallback }: { requested?: number; fallback: number }) => requested ?? fallback
  ),
  getAvailableModels: vi.fn().mockResolvedValue([{ id: 'test-model', backend: 'anthropic' }]),
  getLlmByModel: vi.fn(() => ({
    currentModel: '',
    complete: vi.fn(async (_model: unknown, messages: Array<Record<string, any>>, _options: unknown, onChunk: any) => {
      capturedMessages = messages;
      await onChunk([''], { inputTokens: 100, outputTokens: 50 });
    }),
  })),
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  usdToCredits: vi.fn(() => 10),
  usdToCreditsStochastic: vi.fn(() => 10),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(() => false), // enforceCredits off - this suite is about message shape
  getSettingsByNames: vi.fn(),
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  getTextModelCost: vi.fn(() => 0.001),
}));

import { executeCompletion } from './cliCompletions';

const db = {
  adminSettings: {} as any,
  apiKeys: {} as any,
  creditTransactions: {} as any,
  users: {
    incrementCredits: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100 }),
    findById: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100 }),
  } as any,
};

const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

beforeEach(() => {
  vi.clearAllMocks();
  capturedMessages = undefined;
});

async function completeWith(content: unknown) {
  await executeCompletion({
    userId: 'user1',
    model: 'test-model',
    messages: [{ role: 'user', content: content as any }],
    onChunk: vi.fn().mockResolvedValue(undefined),
    db,
  });
  return capturedMessages![0].content;
}

describe('executeCompletion - multimodal content normalization', () => {
  it('canonicalizes OpenAI Responses parts', async () => {
    expect(
      await completeWith([
        { type: 'input_text', text: 'what is this?' },
        { type: 'input_image', image_url: DATA_URL },
      ])
    ).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: DATA_URL } },
    ]);
  });

  it('canonicalizes an Anthropic url image source', async () => {
    expect(await completeWith([{ type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } }])).toEqual([
      { type: 'image_url', image_url: { url: 'https://x.test/a.png' } },
    ]);
  });

  it('leaves string content and OpenAI Chat parts as they arrived', async () => {
    expect(await completeWith('hello')).toBe('hello');
    expect(await completeWith([{ type: 'image_url', image_url: { url: DATA_URL } }])).toEqual([
      { type: 'image_url', image_url: { url: DATA_URL } },
    ]);
  });
});
