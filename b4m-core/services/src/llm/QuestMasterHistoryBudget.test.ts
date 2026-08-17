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
});
