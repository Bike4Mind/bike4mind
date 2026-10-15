import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompletionInfo } from '@bike4mind/common';

const perM = (usd: number) => usd / 1_000_000;

const flatModel = {
  id: 'flat-model',
  type: 'text',
  backend: 'gemini',
  contextWindow: 1_000_000,
  max_tokens: 8192,
  pricing: { 1_000_000: { input: perM(1), output: perM(10) } },
};

// What the mocked adapter streams: one text frame, then the frame carrying usage.
const emitted: { text: string; info: CompletionInfo; abortMidStream?: AbortController } = { text: '', info: {} };

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
  getAvailableModels: vi.fn(async () => [flatModel]),
  getLlmByModel: vi.fn(() => ({
    currentModel: '',
    complete: vi.fn(async (_model, _messages, _options, onChunk) => {
      await onChunk([emitted.text], {});
      emitted.abortMidStream?.abort();
      await onChunk([], emitted.info);
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

// any: partial repository doubles - only the methods executeCompletion calls are stubbed.
function buildDb() {
  const user = { id: 'user1', currentCredits: 1_000_000 };
  return {
    adminSettings: {} as any,
    apiKeys: {} as any,
    creditTransactions: {} as any,
    users: {
      incrementCredits: vi.fn().mockResolvedValue(user),
      findById: vi.fn().mockResolvedValue(user),
    } as any,
    usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as any,
  };
}

async function settle(abortSignal?: AbortSignal): Promise<CompletionInfo | undefined> {
  const onChunk = vi.fn().mockResolvedValue(undefined);
  await executeCompletion({
    userId: 'user1',
    model: 'flat-model',
    messages: [{ role: 'user', content: 'hi' }],
    db: buildDb(),
    onChunk,
    ...(abortSignal ? { abortSignal } : {}),
  });
  return onChunk.mock.calls.at(-1)?.[1];
}

// 600 streamed chars / 6 chars per token, x1 for an unmeasured model id.
const PARTIAL = 'p'.repeat(600);
const ESTIMATED_OUTPUT = 100;
const promptOnly: CompletionInfo = {
  inputTokens: 1_000,
  outputTokens: 0,
  turnUsage: [{ inputTokens: 1_000, outputTokens: 0 }],
};

describe('executeCompletion - output of a first call cut short before the provider reported it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emitted.text = PARTIAL;
    emitted.abortMidStream = undefined;
  });

  it('bills an estimate of the streamed output when the user stopped the call', async () => {
    const controller = new AbortController();
    emitted.abortMidStream = controller;
    emitted.info = { ...promptOnly, stopReason: 'aborted' };

    const final = await settle(controller.signal);

    expect(final?.outputTokens).toBe(ESTIMATED_OUTPUT);
    expect(final?.usdCost).toBeCloseTo(1_000 * perM(1) + ESTIMATED_OUTPUT * perM(10), 12);
  });

  it('bills an estimate of the streamed output when the stream was aborted as degenerate', async () => {
    emitted.info = { ...promptOnly, stopReason: 'degenerate_repetition' };

    const final = await settle();

    expect(final?.outputTokens).toBe(ESTIMATED_OUTPUT);
    expect(final?.usdCost).toBeCloseTo(1_000 * perM(1) + ESTIMATED_OUTPUT * perM(10), 12);
  });

  it('keeps the provider count when the adapter already reported output', async () => {
    const controller = new AbortController();
    emitted.abortMidStream = controller;
    emitted.info = {
      inputTokens: 1_000,
      outputTokens: 40,
      turnUsage: [{ inputTokens: 1_000, outputTokens: 40 }],
      stopReason: 'aborted',
    };

    const final = await settle(controller.signal);

    expect(final?.outputTokens).toBe(40);
    expect(final?.usdCost).toBeCloseTo(1_000 * perM(1) + 40 * perM(10), 12);
  });

  it('does not estimate output when the adapter reported no usage at all', async () => {
    const controller = new AbortController();
    emitted.abortMidStream = controller;
    emitted.info = { stopReason: 'aborted' };

    const final = await settle(controller.signal);

    expect(final?.outputTokens).toBe(0);
  });

  it('does not estimate output for a call that was neither stopped nor aborted', async () => {
    emitted.info = { ...promptOnly, stopReason: 'end_turn' };

    const final = await settle();

    expect(final?.outputTokens).toBe(0);
    expect(final?.usdCost).toBeCloseTo(1_000 * perM(1), 12);
  });
});
