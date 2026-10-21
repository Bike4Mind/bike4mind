import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
  isMemberCreditCapExceeded: vi.fn(() => false),
}));

const { CATALOGUED_MODEL, order, mockComplete } = vi.hoisted(() => {
  const order: string[] = [];
  return {
    CATALOGUED_MODEL: { id: 'gpt-4.1-2025-04-14', backend: 'openai', max_tokens: 32_768 },
    order,
    mockComplete: vi.fn(async () => {
      order.push('complete');
    }),
  };
});

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn().mockResolvedValue([CATALOGUED_MODEL]),
  getLlmByModel: vi.fn((_apiKeys: unknown, options: { modelInfo?: unknown }) =>
    options.modelInfo ? { currentModel: '', complete: mockComplete } : null
  ),
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

import { BadRequestError } from '@bike4mind/common';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { InsufficientCreditsError } from './llm/ChatCompletionProcess';
import { executeCompletion } from './cliCompletions';

/** `balanceAfterHold` is what the reservation leaves; negative means the hold is refused. */
function buildDb(balanceAfterHold = 100_000) {
  const users = {
    incrementCredits: vi.fn(async (_id: string, delta: number) => {
      order.push(`credits:${delta}`);
      return { id: 'user1', currentCredits: delta < 0 ? balanceAfterHold : 100_000 };
    }),
    findById: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: 100_000 }),
  };
  return {
    users,
    db: {
      adminSettings: {} as never,
      apiKeys: {} as never,
      creditTransactions: {} as never,
      users: users as never,
      usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as never,
    },
  };
}

const baseParams = {
  userId: 'user1',
  model: 'gpt-4.1-2025-04-14',
  messages: [{ role: 'user' as const, content: 'hi' }],
  onChunk: vi.fn().mockResolvedValue(undefined),
};

describe('executeCompletion onReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
  });

  it('calls onReady exactly once, after the credit hold and immediately before the provider call', async () => {
    const { db } = buildDb();
    const onReady = vi.fn(() => {
      order.push('onReady');
    });

    await executeCompletion({ ...baseParams, db, onReady });

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(order.slice(0, 3)).toEqual(['credits:-10', 'onReady', 'complete']);
  });

  it('does not call onReady for an unknown model', async () => {
    const { db } = buildDb();
    const onReady = vi.fn();

    await expect(executeCompletion({ ...baseParams, model: 'gpt-9000', db, onReady })).rejects.toBeInstanceOf(
      BadRequestError
    );
    expect(onReady).not.toHaveBeenCalled();
  });

  it('refuses a disabled model with a 400 unknown_model before any hold, onReady or provider call', async () => {
    vi.mocked(getAvailableModels).mockResolvedValueOnce([
      { ...CATALOGUED_MODEL, disabled: true, disabledReason: 'gated upstream' } as never,
    ]);
    const { db, users } = buildDb();
    const onReady = vi.fn();

    await expect(executeCompletion({ ...baseParams, db, onReady })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('gated upstream'),
      additionalInfo: { errorCode: 'unknown_model' },
    });
    expect(users.incrementCredits).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('words a disabled model without a reason as plainly unavailable', async () => {
    vi.mocked(getAvailableModels).mockResolvedValueOnce([{ ...CATALOGUED_MODEL, disabled: true } as never]);
    const { db } = buildDb();

    const error = await executeCompletion({ ...baseParams, db, onReady: vi.fn() }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestError);
    expect(error).toMatchObject({ additionalInfo: { errorCode: 'unknown_model' } });
    expect((error as Error).message).toContain('is currently unavailable.');
    expect((error as Error).message).not.toContain('undefined');
  });

  it('does not call onReady when the credit hold is refused', async () => {
    const { db } = buildDb(-5);
    const onReady = vi.fn();

    await expect(executeCompletion({ ...baseParams, db, onReady })).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(onReady).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('refunds the hold when onReady throws, and never calls the provider', async () => {
    const { db, users } = buildDb();
    const flushFailure = new Error('socket closed before flush');

    await expect(
      executeCompletion({
        ...baseParams,
        db,
        onReady: () => {
          throw flushFailure;
        },
      })
    ).rejects.toBe(flushFailure);
    expect(users.incrementCredits).toHaveBeenNthCalledWith(1, 'user1', -10);
    expect(users.incrementCredits).toHaveBeenNthCalledWith(2, 'user1', 10);
    expect(mockComplete).not.toHaveBeenCalled();
  });
});
