import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { CATALOGUED_MODEL, order, mockComplete } = vi.hoisted(() => {
  const order: string[] = [];
  return {
    CATALOGUED_MODEL: {
      id: 'gpt-4.1-2025-04-14',
      type: 'text',
      backend: 'openai',
      contextWindow: 200_000,
      max_tokens: 32_768,
      pricing: { 200_000: { input: 1 / 1_000_000, output: 1 / 1_000_000 } },
    },
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

import { BadRequestError, ChatModels, ModelBackend, type IMessage } from '@bike4mind/common';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { getSettingsValue } from '@bike4mind/utils';
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
    vi.mocked(getSettingsValue).mockReturnValue(true);
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

  it.each([
    ['system-only', [{ role: 'system', content: 'system prompt' }]],
    ['blank user text', [{ role: 'user', content: '  \n\t ' }]],
    ['blank assistant text block', [{ role: 'assistant', content: [{ type: 'text', text: '\t ' }] }]],
  ])('refuses a %s conversation before the credit hold, onReady, or provider call', async (_label, messages) => {
    const { db, users } = buildDb();
    const onReady = vi.fn();

    await expect(executeCompletion({ ...baseParams, messages: messages as never, db, onReady })).rejects.toMatchObject({
      statusCode: 400,
      message: 'request must contain at least one non-empty user or assistant message',
    });
    expect(users.incrementCredits).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it.each([
    [
      'image-only',
      [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }],
    ],
    [
      'tool call',
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: {} }],
        },
      ],
    ],
  ])('keeps a %s conversation eligible for dispatch', async (_label, messages) => {
    const { db } = buildDb();
    const onReady = vi.fn();

    await executeCompletion({ ...baseParams, messages: messages as never, db, onReady });

    expect(onReady).toHaveBeenCalledOnce();
    expect(mockComplete).toHaveBeenCalledOnce();
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

  it('refuses unsupported assistant prefill without a hold, provider call, or error log', async () => {
    vi.mocked(getAvailableModels).mockResolvedValueOnce([
      {
        ...CATALOGUED_MODEL,
        id: ChatModels.CLAUDE_5_5_HAIKU,
        backend: ModelBackend.Anthropic,
      } as never,
    ]);
    const { db, users } = buildDb();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const onReady = vi.fn();

    await expect(
      executeCompletion({
        ...baseParams,
        model: ChatModels.CLAUDE_5_5_HAIKU,
        messages: [
          { role: 'user', content: 'Answer in JSON.' },
          { role: 'assistant', content: '{' },
          { role: 'system', content: 'Keep the answer short.' },
        ],
        db,
        logger: logger as never,
        onReady,
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      additionalInfo: { errorCode: 'assistant_prefill_unsupported' },
    });
    expect(users.incrementCredits).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(getLlmByModel).not.toHaveBeenCalled();
  });

  it.each<{ label: string; messages: IMessage[] }>([
    {
      label: 'normal multi-turn user-last conversation',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'continue' },
      ],
    },
    {
      label: 'blank assistant placeholder',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: ' ' },
      ],
    },
    {
      label: 'pause_turn server-tool continuation',
      messages: [
        { role: 'user', content: 'find a tool' },
        {
          role: 'assistant',
          content: [
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex', input: { pattern: 'lookup' } },
            { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { tool_references: [] } },
          ],
        },
      ],
    },
    ...(['tool_addition', 'tool_removal'] as const).map(type => ({
      label: `trailing ${type}`,
      messages: [
        { role: 'user', content: 'find a tool' },
        {
          role: 'assistant',
          content: [
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex', input: { pattern: 'lookup' } },
            { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { tool_references: [] } },
          ],
        },
        { role: 'system', content: [{ type, tool: { type: 'tool_reference', name: 'lookup' } }] },
      ] satisfies IMessage[],
    })),
  ])('dispatches $label on a model without prefill support', async ({ messages }) => {
    vi.mocked(getAvailableModels).mockResolvedValueOnce([
      { ...CATALOGUED_MODEL, id: ChatModels.CLAUDE_5_5_HAIKU, backend: ModelBackend.Anthropic } as never,
    ]);
    const { db } = buildDb();
    const onReady = vi.fn();

    await executeCompletion({
      ...baseParams,
      model: ChatModels.CLAUDE_5_5_HAIKU,
      messages,
      options: {
        tools: [
          { toolSchema: { name: 'lookup', description: 'Look up a value', parameters: { type: 'object' } } },
          { serverTool: { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' } },
        ],
      },
      db,
      onReady,
    });

    expect(onReady).toHaveBeenCalledOnce();
    expect(mockComplete).toHaveBeenCalledWith(
      ChatModels.CLAUDE_5_5_HAIKU,
      messages,
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('preserves assistant prefill for a model that supports it', async () => {
    const { db } = buildDb();
    const messages = [
      { role: 'user' as const, content: 'Answer in JSON.' },
      { role: 'assistant' as const, content: '{' },
    ];

    await executeCompletion({ ...baseParams, messages, db });

    expect(mockComplete).toHaveBeenCalledWith(baseParams.model, messages, expect.any(Object), expect.any(Function));
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

  it.each([true, false])('refuses an image model before dispatch with enforceCredits=%s', async enforceCredits => {
    vi.mocked(getSettingsValue).mockReturnValue(enforceCredits);
    vi.mocked(getAvailableModels).mockResolvedValueOnce([
      { ...CATALOGUED_MODEL, id: 'gpt-image-2', type: 'image' } as never,
    ]);
    const { db, users } = buildDb();
    const onReady = vi.fn();

    const error = await executeCompletion({ ...baseParams, model: 'gpt-image-2', db, onReady }).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(BadRequestError);
    expect(error).toMatchObject({ statusCode: 400, additionalInfo: { errorCode: 'unknown_model' } });
    expect((error as Error).message).toBe("Model 'gpt-image-2' (type: image) cannot be used for text completions.");
    expect(users.incrementCredits).not.toHaveBeenCalled();
    // Proves the guard runs before backend construction, not merely before the provider call.
    expect(getLlmByModel).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it.each(['image', 'video', 'speech-to-text'] as const)(
    'refuses a non-text model (type %s) with a 400 unknown_model and no side effects',
    async type => {
      vi.mocked(getAvailableModels).mockResolvedValueOnce([
        { ...CATALOGUED_MODEL, id: 'non-text-model', type } as never,
      ]);
      const { db, users } = buildDb();
      const onReady = vi.fn();

      const error = await executeCompletion({ ...baseParams, model: 'non-text-model', db, onReady }).catch(
        (e: unknown) => e
      );

      expect(error).toBeInstanceOf(BadRequestError);
      expect(error).toMatchObject({ statusCode: 400, additionalInfo: { errorCode: 'unknown_model' } });
      expect((error as Error).message).toBe(
        `Model 'non-text-model' (type: ${type}) cannot be used for text completions.`
      );
      expect(users.incrementCredits).not.toHaveBeenCalled();
      expect(getLlmByModel).not.toHaveBeenCalled();
      expect(onReady).not.toHaveBeenCalled();
      expect(mockComplete).not.toHaveBeenCalled();
    }
  );

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
