import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  evaluate: vi.fn(),
  recordUsage: vi.fn(),
  payerCanFund: vi.fn(),
  availableModels: vi.fn(),
}));

vi.mock('@workers/utils/eventContext', () => ({ withEventContext: (handler: unknown) => handler }));
vi.mock('@server/utils/eventBus', () => ({
  LLMEvents: { CompletionCompleted: { schema: { parse: (properties: unknown) => properties } } },
}));
vi.mock('@bike4mind/database', () => ({
  apiKeyRepository: {},
  adminSettingsRepository: {},
  Memento: { find: vi.fn(() => ({ select: async () => [] })), create: vi.fn(), updateOne: vi.fn() },
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('@bike4mind/fab-pipeline', () => ({
  EmbeddingFactory: vi.fn(),
  getProviderFromModel: vi.fn(),
  resolveEmbeddingConfig: vi.fn(),
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn(async () => ({})) },
  mementoService: { findMostSimilarMemento: vi.fn() },
}));
vi.mock('@bike4mind/llm-adapters', () => ({ getAvailableModels: h.availableModels }));
vi.mock('@bike4mind/services/llm', () => ({
  MementoEvaluationService: class {
    evaluate = h.evaluate;
  },
}));
vi.mock('@bike4mind/server-utils/memory/mementoLedgerMirror', () => ({
  isMementosV2Enabled: vi.fn(async () => false),
  writeFactToLedger: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/mementoEmbedding', () => ({ generateMementoSummaryEmbedding: vi.fn() }));
vi.mock('@workers/events/recordSessionOperationalUsage', () => ({ recordSessionOperationalUsage: h.recordUsage }));
vi.mock('@workers/events/sessionOperationalCreditGate', () => ({ payerCanFundSessionOperation: h.payerCanFund }));

import { apiKeyService } from '@bike4mind/services';
import { handler } from './createMemento';

const logger = { updateMetadata: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
const run = () =>
  (handler as unknown as (event: unknown, logger: unknown) => Promise<void>)(
    {
      properties: {
        userId: 'user-1',
        sessionId: 'session-1',
        questId: 'quest-1',
        prompt: 'I live in Austin',
        model: 'chat-model',
        enableMementos: true,
        enableMementosV2: false,
      },
    },
    logger
  );

describe('createMemento evaluation usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.payerCanFund.mockResolvedValue(true);
  });

  it("records the evaluation call as the session owner's operational usage", async () => {
    const modelInfo = { id: 'chat-model', backend: 'anthropic' };
    const completionInfo = { inputTokens: 900, outputTokens: 60 };
    h.evaluate.mockImplementation(async ({ onUsage }) => {
      await onUsage({ modelInfo, completionInfo, startTime: 123 });
      return null;
    });

    await run();

    expect(h.recordUsage).toHaveBeenCalledExactlyOnceWith({
      userId: 'user-1',
      sessionId: 'session-1',
      modelId: 'chat-model',
      modelInfo,
      completionInfo,
      startTime: 123,
      logger,
    });
  });

  it('runs no evaluation and records no usage when the user cannot fund the operation', async () => {
    h.payerCanFund.mockResolvedValue(false);

    await run();

    expect(h.payerCanFund).toHaveBeenCalledWith(expect.objectContaining({ payerId: 'user-1' }));
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(h.recordUsage).not.toHaveBeenCalled();
  });

  it("gates on the chat turn's model, not the operations model, resolved with the user's keys", async () => {
    const apiKeyTable = { anthropic: 'key' };
    vi.mocked(apiKeyService.getEffectiveLLMApiKeys).mockResolvedValueOnce(apiKeyTable as never);
    const chatModel = { id: 'chat-model', freeToRun: true };
    h.availableModels.mockResolvedValue([{ id: 'other-model' }, chatModel]);
    h.payerCanFund.mockResolvedValue(false);

    await run();

    const [{ resolveModelInfo }] = h.payerCanFund.mock.calls[0];
    await expect(resolveModelInfo()).resolves.toBe(chatModel);
    expect(h.availableModels).toHaveBeenCalledExactlyOnceWith(apiKeyTable);
  });

  it('rejects the model resolution when the chat model is not in the catalog', async () => {
    h.availableModels.mockResolvedValue([{ id: 'other-model' }]);
    h.payerCanFund.mockResolvedValue(false);

    await run();

    const [{ resolveModelInfo }] = h.payerCanFund.mock.calls[0];
    await expect(resolveModelInfo()).rejects.toThrow('chat-model');
  });
});
