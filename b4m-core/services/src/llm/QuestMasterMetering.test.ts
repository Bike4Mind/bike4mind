import { describe, it, expect, vi, beforeEach } from 'vitest';
import { insufficientCreditsError } from '@bike4mind/common';

/**
 * The QuestMaster plan runs on the platform key before the turn reserves its own credits, so each
 * plan call must be reserved and settled through the host's meter, billed to the turn's active org.
 */

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
}));

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    fetchAndProcessPreviousMessages: vi.fn().mockResolvedValue([[], 0, {}]),
    // A `function`, not an arrow: the feature calls `new QuestMaster(...)`.
    QuestMaster: vi.fn().mockImplementation(function (llm: { complete: (...a: unknown[]) => Promise<unknown> }) {
      return {
        createQuestPlan: async (model: string) => {
          await llm.complete(model, [{ role: 'user', content: 'plan' }], { maxTokens: 1000 }, async () => {});
        },
      };
    }),
  };
});

import { QuestMasterFeature, type ChatCompletionContext } from './ChatCompletionFeatures';

const modelInfo = { id: 'm', contextWindow: 200_000, max_tokens: 16384, type: 'text' };

function setup(meter: ReturnType<typeof vi.fn>) {
  const createCompletionMeter = vi.fn(() => meter);
  const context = {
    user: { id: 'user1' },
    slackWebhookUrl: '',
    db: {
      quests: {
        update: vi.fn().mockResolvedValue(undefined),
        findById: vi.fn().mockResolvedValue({ id: 'quest1', status: 'running' }),
      },
    },
    logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() },
    sendStatusUpdate: vi.fn().mockResolvedValue(undefined),
    createCompletionMeter,
  } as unknown as ChatCompletionContext;
  const run = () =>
    new QuestMasterFeature(context).beforeDataGathering({
      quest: { id: 'quest1', status: 'running' } as never,
      session: { id: 'session1' } as never,
      startParams: {} as never,
      llm: { complete: mocks.complete } as never,
      model: 'm',
      modelInfo: modelInfo as never,
      message: 'plan my week',
      historyCount: 10,
      fabFileIds: [],
      questId: 'quest1',
      questMaster: undefined,
      organizationId: 'org1',
    });
  return { run, createCompletionMeter };
}

describe('QuestMasterFeature metering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.complete.mockImplementation(async (_m, _msgs, _o, cb) => {
      await cb(['plan'], { inputTokens: 100, outputTokens: 20 });
    });
  });

  it('refuses before the provider call when the turn owner is out of credits', async () => {
    const meter = vi.fn().mockRejectedValue(insufficientCreditsError('no credits'));
    const { run, createCompletionMeter } = setup(meter);

    await expect(run()).resolves.toEqual({ shouldContinue: true });
    expect(createCompletionMeter).toHaveBeenCalledWith({
      organizationId: 'org1',
      featureLabel: 'QuestMaster planning',
    });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('settles each plan call once with its reported usage', async () => {
    const settle = vi.fn().mockResolvedValue(1);
    const refund = vi.fn();
    const meter = vi.fn().mockResolvedValue({ settle, refund });
    const { run } = setup(meter);

    await expect(run()).resolves.toEqual({ shouldContinue: false });
    expect(meter).toHaveBeenCalledWith(modelInfo, [{ role: 'user', content: 'plan' }], 1000, undefined);
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 20 });
    expect(refund).not.toHaveBeenCalled();
  });

  it('refunds a plan call the provider fails, so the fallback turn is the only charge', async () => {
    const settle = vi.fn();
    const refund = vi.fn();
    const { run } = setup(vi.fn().mockResolvedValue({ settle, refund }));
    mocks.complete.mockRejectedValue(new Error('provider down'));

    await expect(run()).resolves.toEqual({ shouldContinue: true });
    expect(refund).toHaveBeenCalledOnce();
    expect(settle).not.toHaveBeenCalled();
  });
});
