import { describe, it, expect, beforeEach, vi } from 'vitest';

interface FakeQuest {
  id: string;
  agentExecutionId: string;
  status: string;
}

const { fakeQuests, updates, staleIds, metrics } = vi.hoisted(() => ({
  fakeQuests: [] as FakeQuest[],
  updates: [] as Array<Record<string, unknown>>,
  staleIds: [] as string[],
  metrics: [] as Array<{ name: string; value: number }>,
}));

const TERMINAL = ['done', 'stopped'];

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  agentExecutionRepository: {
    findStaleActiveIds: vi.fn(async () => staleIds),
    markAbandoned: vi.fn(async (ids: string[]) => ids.map(id => ({ id, userId: 'u1' }))),
  },
  questRepository: {
    findUnfinishedByAgentExecutionIds: vi.fn(async (ids: string[]) =>
      fakeQuests
        .filter(q => ids.includes(q.agentExecutionId) && !TERMINAL.includes(q.status))
        .map(({ agentExecutionId: _a, status: _s, ...content }) => content)
    ),
    update: vi.fn(async (patch: { id: string }) => {
      updates.push(patch);
      return patch;
    }),
  },
}));

vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://test/%STAGE%' } }));
vi.mock('@server/utils/cloudwatch', () => ({
  emitMetric: vi.fn(async (_ns: string, name: string, value: number) => {
    metrics.push({ name, value });
  }),
}));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));

import { handler } from './agentExecutionAbandonedSweep';
import { ABANDONED_REPLY } from '@server/chatCompletion/questTimeoutRecovery';

describe('agentExecutionAbandonedSweep - handler', () => {
  beforeEach(() => {
    fakeQuests.length = 0;
    updates.length = 0;
    staleIds.length = 0;
    metrics.length = 0;
    vi.clearAllMocks();
  });

  it('settles the quests of the executions it sweeps', async () => {
    // Guards the wiring, not the helper: before this, markAbandoned ran and the
    // bubble was left spinning because nothing propagated to the quest.
    staleIds.push('exec1');
    fakeQuests.push({ id: 'q1', agentExecutionId: 'exec1', status: 'pending' });

    const result = await handler();

    expect(result).toMatchObject({ status: 'OK', marked: 1, questsSettled: 1 });
    expect(updates).toEqual([{ id: 'q1', status: 'done', type: 'error', reply: ABANDONED_REPLY }]);
  });

  it('emits both the settled count and the failure signal', async () => {
    staleIds.push('exec1');
    fakeQuests.push({ id: 'q1', agentExecutionId: 'exec1', status: 'pending' });

    await handler();

    // A crashed pass and a clean no-op both settle 0, so the failure metric is
    // the only thing that distinguishes them on a dashboard.
    expect(metrics).toContainEqual({ name: 'StrandedQuestsSettled', value: 1 });
    expect(metrics).toContainEqual({ name: 'StrandedQuestSettleFailures', value: 0 });
  });

  it('reports zero settled when the sweep found nothing', async () => {
    const result = await handler();

    expect(result).toMatchObject({ status: 'OK', marked: 0 });
    expect(updates).toEqual([]);
  });
});
