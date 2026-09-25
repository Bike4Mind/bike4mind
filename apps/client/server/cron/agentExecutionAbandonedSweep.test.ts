import { describe, it, expect, beforeEach, vi } from 'vitest';

interface FakeQuest {
  id: string;
  agentExecutionId: string;
  status: string;
}

const { fakeQuests, updates, staleIds, metrics, failQuestIds, settlementMarkers } = vi.hoisted(() => ({
  fakeQuests: [] as FakeQuest[],
  updates: [] as Array<Record<string, unknown>>,
  staleIds: [] as string[],
  metrics: [] as Array<{ name: string; value: number }>,
  failQuestIds: new Set<string>(),
  settlementMarkers: new Map<string, Date>(),
}));

const TERMINAL = ['done', 'stopped'];

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  agentExecutionRepository: {
    findStaleActiveIds: vi.fn(async () => staleIds),
    markAbandoned: vi.fn(async (ids: string[]) => ids.map(id => ({ id, userId: 'u1' }))),
    markQuestSettlementFailed: vi.fn(async (ids: string[]) => {
      for (const id of ids) settlementMarkers.set(id, new Date());
    }),
    clearQuestSettlementFailed: vi.fn(async (ids: string[]) => {
      for (const id of ids) settlementMarkers.delete(id);
    }),
    findFailedQuestSettlementIds: vi.fn(async ({ limit, olderThan }: { limit: number; olderThan: Date }) =>
      [...settlementMarkers.entries()]
        .filter(([, failedAt]) => failedAt.getTime() < olderThan.getTime())
        .sort((a, b) => a[1].getTime() - b[1].getTime())
        .slice(0, limit)
        .map(([id, failedAt]) => ({ id, failedAt }))
    ),
  },
  questRepository: {
    findUnfinishedByAgentExecutionIds: vi.fn(async (ids: string[]) =>
      fakeQuests
        .filter(q => ids.includes(q.agentExecutionId) && !TERMINAL.includes(q.status))
        .map(({ status: _s, ...content }) => content)
    ),
    settleIfUnfinished: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      if (failQuestIds.has(id)) throw new Error('settle write failed');
      updates.push({ id, ...patch });
      return true;
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

import { handler, runAbandonedExecutionSweep } from './agentExecutionAbandonedSweep';
import { ABANDONED_REPLY } from '@server/chatCompletion/questTimeoutRecovery';

describe('agentExecutionAbandonedSweep - handler', () => {
  beforeEach(() => {
    fakeQuests.length = 0;
    updates.length = 0;
    staleIds.length = 0;
    metrics.length = 0;
    failQuestIds.clear();
    settlementMarkers.clear();
    vi.clearAllMocks();
  });

  it('runs the same recovery without CloudWatch metrics for self-host', async () => {
    staleIds.push('exec1');
    fakeQuests.push({ id: 'q1', agentExecutionId: 'exec1', status: 'pending' });
    const result = await runAbandonedExecutionSweep({ emitMetrics: false });
    expect(result).toMatchObject({ marked: 1, questsSettled: 1 });
    expect(metrics).toEqual([]);
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

    expect(result).toMatchObject({ status: 'OK', marked: 0, questsSettled: 0 });
    expect(updates).toEqual([]);
    // A quiet hour still emits both settle metrics: a gap in the data is how a
    // broken cron looks, so it must not also be how a clean run looks.
    expect(metrics).toContainEqual({ name: 'StrandedQuestsSettled', value: 0 });
    expect(metrics).toContainEqual({ name: 'StrandedQuestSettleFailures', value: 0 });
  });

  describe('quest settlement retry', () => {
    it('persists a retry marker when settling a just-abandoned quest fails', async () => {
      // markAbandoned already made exec1 terminal, so a failed settle here has
      // no other path back except the marker this test checks for.
      staleIds.push('exec1');
      fakeQuests.push({ id: 'q1', agentExecutionId: 'exec1', status: 'pending' });
      failQuestIds.add('q1');

      const result = await runAbandonedExecutionSweep({ emitMetrics: true });

      expect(result.questsSettled).toBe(0);
      expect(settlementMarkers.has('exec1')).toBe(true);
      expect(metrics).toContainEqual({ name: 'StrandedQuestSettleFailures', value: 1 });
    });

    it('retries a marked execution on the next tick and clears the marker once it settles', async () => {
      // Fake time, not just wall-clock ordering: the retry pass excludes markers
      // written by its own tick, so two calls back to back with no clock
      // movement between them would leave tick one's marker ineligible on
      // tick two too, and this test would pass for the wrong reason.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        staleIds.push('exec1');
        fakeQuests.push({ id: 'q1', agentExecutionId: 'exec1', status: 'pending' });
        failQuestIds.add('q1');

        const first = await runAbandonedExecutionSweep({ emitMetrics: false });
        expect(first.questsSettled).toBe(0);
        expect(settlementMarkers.has('exec1')).toBe(true);
        expect(updates).toEqual([]);

        // Tick two: nothing newly stale, but the transient failure has cleared.
        vi.advanceTimersByTime(60 * 60_000);
        staleIds.length = 0;
        failQuestIds.delete('q1');

        const second = await runAbandonedExecutionSweep({ emitMetrics: false });

        expect(second.questsSettled).toBe(1);
        expect(settlementMarkers.has('exec1')).toBe(false);
        expect(updates).toEqual([{ id: 'q1', status: 'done', type: 'error', reply: ABANDONED_REPLY }]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports a still-failing retry candidate past 24h as stuck without dropping it', async () => {
      settlementMarkers.set('exec-old', new Date(Date.now() - 25 * 60 * 60 * 1000));
      fakeQuests.push({ id: 'q-old', agentExecutionId: 'exec-old', status: 'pending' });
      failQuestIds.add('q-old');

      const result = await runAbandonedExecutionSweep({ emitMetrics: true });

      expect(result.questsSettled).toBe(0);
      expect(settlementMarkers.has('exec-old')).toBe(true);
      expect(metrics).toContainEqual({ name: 'QuestSettlementRetryStuck', value: 1 });
      expect(metrics).toContainEqual({ name: 'QuestSettlementRetryBacklog', value: 1 });
    });
  });
});
