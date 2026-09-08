import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * QuestMaster's history fetch used to omit verbatimTokenBudget entirely, so
 * fetchAndProcessPreviousMessages skipped its trim and createQuestPlan spliced the whole
 * (unbounded) history in. This pins that the QuestMasterFeature call site now passes a
 * positive, finite budget, mirroring ChatCompletionProcess.ts's own call site.
 */

const mocks = vi.hoisted(() => ({
  fetchAndProcessPreviousMessages: vi.fn().mockResolvedValue([[], 0, {}]),
  createQuestPlan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    fetchAndProcessPreviousMessages: mocks.fetchAndProcessPreviousMessages,
    QuestMaster: vi.fn().mockImplementation(() => ({
      createQuestPlan: mocks.createQuestPlan,
    })),
  };
});

import { QuestMasterFeature, ChatCompletionContext } from './ChatCompletionFeatures';

describe('QuestMasterFeature - history fetch token budget', () => {
  let feature: QuestMasterFeature;
  let mockContext: ChatCompletionContext;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}]);
    mocks.createQuestPlan.mockResolvedValue(undefined);

    mockDb = {
      quests: {
        update: vi.fn().mockResolvedValue(undefined),
        findById: vi.fn().mockResolvedValue({ id: 'quest1', status: 'running' }),
      },
    };

    mockContext = {
      user: { id: 'user1' } as any,
      slackWebhookUrl: '',
      db: mockDb,
      logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() },
      sendStatusUpdate: vi.fn().mockResolvedValue(undefined),
    } as any;

    feature = new QuestMasterFeature(mockContext);
  });

  it('passes a positive, finite verbatimTokenBudget to fetchAndProcessPreviousMessages', async () => {
    await feature.beforeDataGathering({
      quest: { id: 'quest1', status: 'running' } as any,
      session: { id: 'session1' } as any,
      startParams: {} as any,
      llm: {} as any,
      model: 'test-model',
      modelInfo: { id: 'test-model', contextWindow: 200_000, max_tokens: 16384, type: 'text' } as any,
      message: 'plan my week',
      historyCount: 10,
      fabFileIds: [],
      questId: 'quest1',
      questMaster: undefined,
    });

    expect(mocks.fetchAndProcessPreviousMessages).toHaveBeenCalledTimes(1);
    const [, , options] = mocks.fetchAndProcessPreviousMessages.mock.calls[0];
    expect(options.verbatimTokenBudget).toEqual(expect.any(Number));
    expect(options.verbatimTokenBudget).toBeGreaterThan(0);
    expect(Number.isFinite(options.verbatimTokenBudget)).toBe(true);
  });

  it('sizes the budget against the REAL model context window, not an unknown-model floor', async () => {
    // A small-context model (e.g. an 8k-window row) must get a budget well under 8192 - the
    // regression this guards is a budget computed against a 200k floor regardless of the actual
    // model, which for a small-window model exceeds the real window entirely and disables trimming.
    const SMALL_CONTEXT_WINDOW = 8192;
    await feature.beforeDataGathering({
      quest: { id: 'quest1', status: 'running' } as any,
      session: { id: 'session1' } as any,
      startParams: {} as any,
      llm: {} as any,
      model: 'small-window-model',
      modelInfo: {
        id: 'small-window-model',
        contextWindow: SMALL_CONTEXT_WINDOW,
        max_tokens: 2048,
        type: 'text',
      } as any,
      message: 'plan my week',
      historyCount: 10,
      fabFileIds: [],
      questId: 'quest1',
      questMaster: undefined,
    });

    const [, , options] = mocks.fetchAndProcessPreviousMessages.mock.calls[0];
    expect(options.verbatimTokenBudget).toBeLessThan(SMALL_CONTEXT_WINDOW);
  });

  it('never collapses to a falsy 0 budget, even for a very long message on a small window', async () => {
    // fetchAndProcessPreviousMessages treats a falsy budget as "no budget given" and skips
    // trimming entirely - the exact unbounded-history bug this fix exists to prevent. A message
    // long enough to exhaust the whole window must still floor at 1, not 0.
    await feature.beforeDataGathering({
      quest: { id: 'quest1', status: 'running' } as any,
      session: { id: 'session1' } as any,
      startParams: {} as any,
      llm: {} as any,
      model: 'small-window-model',
      modelInfo: { id: 'small-window-model', contextWindow: 8192, max_tokens: 2048, type: 'text' } as any,
      message: 'x'.repeat(100_000),
      historyCount: 10,
      fabFileIds: [],
      questId: 'quest1',
      questMaster: undefined,
    });

    const [, , options] = mocks.fetchAndProcessPreviousMessages.mock.calls[0];
    expect(options.verbatimTokenBudget).toBeGreaterThanOrEqual(1);
  });
});
