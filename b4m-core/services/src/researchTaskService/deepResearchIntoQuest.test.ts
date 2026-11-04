import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEEP_RESEARCH_FAILED_REPLY,
  DEEP_RESEARCH_HEARTBEAT_MS,
  deepResearchIntoQuest,
  type DeepResearchIntoQuestAdapters,
} from './deepResearchIntoQuest';

const state = (completedSteps: number) => ({
  findings: [{ text: 'secret finding', source: 'https://a' }],
  activities: [{ type: 'search', status: 'complete', message: `step ${completedSteps}`, timestamp: '' }],
  sources: [],
  depth: 1,
  completed: false,
  nextSearchQueries: [],
  urlToSearch: '',
  summaries: [],
  completedSteps,
  totalExpectedSteps: 12,
  topic: 't',
  failedAttempts: 0,
  maxFailedAttempts: 3,
});

function setup(over: Partial<DeepResearchIntoQuestAdapters> = {}) {
  const quests = {
    findById: vi.fn().mockResolvedValue({ id: 'q1', sessionId: 's1', status: 'running' }),
    updateIfUnfinished: vi.fn().mockResolvedValue({}),
    settleIfUnfinished: vi.fn().mockResolvedValue(true),
  };
  const push = vi.fn().mockResolvedValue(undefined);
  const complete = vi.fn(async (_m, _msgs, _opts, cb) => {
    await cb(['# Report\n', 'body']);
  });
  const research = vi.fn(async ctx => {
    ctx.statusUpdate({ deepResearchState: state(1) });
    await vi.advanceTimersByTimeAsync(DEEP_RESEARCH_HEARTBEAT_MS * 3);
    ctx.statusUpdate({ deepResearchState: state(2) });
    return {
      success: true,
      data: { findings: [], finalAnalysisPrompt: 'Write it up', completedSteps: 2, totalSteps: 12 },
    };
  });
  const adapters: DeepResearchIntoQuestAdapters = {
    quests,
    push,
    toolContext: {} as never,
    llm: { complete, currentModel: 'ops-model' } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    research: research as never,
    ...over,
  };
  return { adapters, quests, push, complete, research };
}

const writes = (quests: { updateIfUnfinished: ReturnType<typeof vi.fn> }) =>
  quests.updateIfUnfinished.mock.calls.map(c => c[0]);

describe('deepResearchIntoQuest', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes progress without findings and pushes it', async () => {
    const { adapters, quests, push } = setup();
    await deepResearchIntoQuest({ questId: 'q1', topic: 't' }, adapters);
    const progress = writes(quests).filter(w => w.deepResearchState);
    expect(progress.length).toBeGreaterThan(0);
    for (const w of progress) expect(w.deepResearchState.findings).toEqual([]);
    for (const [q] of push.mock.calls) {
      if (q.deepResearchState) expect(q.deepResearchState.findings).toEqual([]);
    }
  });

  it('heartbeats at least every 30s while research runs', async () => {
    const { adapters, quests } = setup();
    await deepResearchIntoQuest({ questId: 'q1', topic: 't' }, adapters);
    const beats = writes(quests).filter(w => w.updatedAt instanceof Date);
    expect(beats.length).toBeGreaterThanOrEqual(3);
  });

  it('heartbeats during the report call too', async () => {
    const { adapters, quests, complete } = setup();
    complete.mockImplementation(async (_m, _msgs, _opts, cb) => {
      const before = writes(quests).length;
      await vi.advanceTimersByTimeAsync(DEEP_RESEARCH_HEARTBEAT_MS + 1);
      expect(writes(quests).length).toBeGreaterThan(before);
      await cb(['done']);
    });
    await deepResearchIntoQuest({ questId: 'q1', topic: 't' }, adapters);
  });

  it('writes the report through the given model and settles done', async () => {
    const { adapters, quests, complete } = setup();
    await deepResearchIntoQuest({ questId: 'q1', topic: 't' }, adapters);
    expect(complete.mock.calls[0][0]).toBe('ops-model');
    expect(complete.mock.calls[0][1]).toEqual([{ role: 'user', content: 'Write it up' }]);
    expect(quests.settleIfUnfinished).toHaveBeenCalledWith('q1', {
      status: 'done',
      reply: '# Report\nbody',
      replies: ['# Report\nbody'],
    });
    expect(writes(quests).some(w => w.deepResearchState?.completed === true)).toBe(true);
  });

  it('settles as an error when research reports failure', async () => {
    const { adapters, quests } = setup({
      research: vi.fn().mockResolvedValue({
        success: false,
        error: 'no search provider',
        data: { findings: [], finalAnalysisPrompt: '', completedSteps: 0, totalSteps: 0 },
      }) as never,
    });
    await deepResearchIntoQuest({ questId: 'q1', topic: 't' }, adapters);
    expect(quests.settleIfUnfinished).toHaveBeenCalledWith('q1', {
      status: 'done',
      type: 'error',
      reply: DEEP_RESEARCH_FAILED_REPLY,
      replies: [DEEP_RESEARCH_FAILED_REPLY],
    });
  });

  it('settles as an error when the report call throws', async () => {
    const { adapters, quests, complete } = setup();
    complete.mockRejectedValue(new Error('provider 503'));
    await deepResearchIntoQuest({ questId: 'q1', topic: 't' }, adapters);
    expect(quests.settleIfUnfinished).toHaveBeenCalledWith('q1', expect.objectContaining({ type: 'error' }));
  });

  it('leaves a settled quest alone', async () => {
    const { adapters, quests, research } = setup();
    quests.findById.mockResolvedValue({ id: 'q1', sessionId: 's1', status: 'done' });
    await deepResearchIntoQuest({ questId: 'q1', topic: 't' }, adapters);
    expect(research).not.toHaveBeenCalled();
    expect(quests.settleIfUnfinished).not.toHaveBeenCalled();
  });

  it('stops the heartbeat once settled', async () => {
    const { adapters, quests } = setup();
    await deepResearchIntoQuest({ questId: 'q1', topic: 't' }, adapters);
    const after = writes(quests).length;
    await vi.advanceTimersByTimeAsync(DEEP_RESEARCH_HEARTBEAT_MS * 4);
    expect(writes(quests).length).toBe(after);
  });
});
