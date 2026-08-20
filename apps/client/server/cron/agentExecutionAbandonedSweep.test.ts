import { describe, it, expect, beforeEach, vi } from 'vitest';

interface FakeQuest {
  id: string;
  agentExecutionId: string;
  status: string;
  reply?: string;
  replies?: string[];
  images?: string[];
  videos?: string[];
}

const { fakeQuests, updates, failIds, staleIds } = vi.hoisted(() => ({
  fakeQuests: [] as FakeQuest[],
  updates: [] as Array<Record<string, unknown>>,
  failIds: new Set<string>(),
  staleIds: [] as string[],
}));

const TERMINAL = ['done', 'stopped'];

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  agentExecutionRepository: {
    findStaleActiveIds: vi.fn(async () => staleIds),
    markAbandoned: vi.fn(async (ids: string[]) => ids.map(id => ({ id, userId: 'u1' }))),
  },
  questRepository: {
    // Mirrors the real query: matches on agentExecutionId and excludes terminal
    // statuses, returning only the content fields the decision reads.
    findUnfinishedByAgentExecutionIds: vi.fn(async (ids: string[]) =>
      fakeQuests
        .filter(q => ids.includes(q.agentExecutionId) && !TERMINAL.includes(q.status))
        .map(q => ({ id: q.id, reply: q.reply, replies: q.replies, images: q.images, videos: q.videos }))
    ),
    update: vi.fn(async (patch: { id: string }) => {
      if (failIds.has(patch.id)) throw new Error('write failed');
      updates.push(patch);
      return patch;
    }),
  },
}));

vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://test/%STAGE%' } }));
vi.mock('@server/utils/cloudwatch', () => ({ emitMetric: vi.fn() }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));

// Imports after mocks
import { handler, settleStrandedQuests } from './agentExecutionAbandonedSweep';
import { ABANDONED_REPLY } from '@server/chatCompletion/questTimeoutRecovery';

function addQuest(overrides: Partial<FakeQuest>): FakeQuest {
  const quest: FakeQuest = {
    id: `q${fakeQuests.length + 1}`,
    agentExecutionId: 'exec1',
    status: 'pending',
    ...overrides,
  };
  fakeQuests.push(quest);
  return quest;
}

describe('agentExecutionAbandonedSweep - settleStrandedQuests', () => {
  beforeEach(() => {
    fakeQuests.length = 0;
    updates.length = 0;
    failIds.clear();
    staleIds.length = 0;
    vi.clearAllMocks();
  });

  it('settles a quest stranded at pending by a swept execution', async () => {
    // The production case: the run died before it ever streamed, so the quest
    // never reached `running` and the liveness recovery cannot see it.
    addQuest({ status: 'pending' });

    const settled = await settleStrandedQuests(['exec1']);

    expect(settled).toBe(1);
    expect(updates).toEqual([{ id: 'q1', status: 'done', type: 'error', reply: ABANDONED_REPLY }]);
  });

  it('preserves partial content instead of replacing it with an error', async () => {
    addQuest({ status: 'running', reply: 'here is half an answer' });

    await settleStrandedQuests(['exec1']);

    // Status flips, but the surviving reply is left alone and no error is set.
    expect(updates).toEqual([{ id: 'q1', status: 'done' }]);
  });

  it('treats images alone as content worth preserving', async () => {
    addQuest({ status: 'pending', images: ['rendered.png'] });

    await settleStrandedQuests(['exec1']);

    expect(updates).toEqual([{ id: 'q1', status: 'done' }]);
  });

  it('leaves already-terminal quests untouched so a natural finish wins the race', async () => {
    addQuest({ status: 'done', reply: 'complete answer' });
    addQuest({ status: 'stopped' });

    const settled = await settleStrandedQuests(['exec1']);

    expect(settled).toBe(0);
    expect(updates).toEqual([]);
  });

  it('keeps settling after one quest fails to write', async () => {
    addQuest({ id: 'q1', status: 'pending' });
    addQuest({ id: 'q2', status: 'pending' });
    failIds.add('q1');

    const settled = await settleStrandedQuests(['exec1']);

    // The sweep's primary job already succeeded, so one bad write must not
    // strand the rest of the batch.
    expect(settled).toBe(1);
    expect(updates.map(u => u.id)).toEqual(['q2']);
  });

  it('is a no-op when nothing was swept', async () => {
    addQuest({ status: 'pending' });

    expect(await settleStrandedQuests([])).toBe(0);
    expect(updates).toEqual([]);
  });

  it('ignores quests belonging to executions that were not swept', async () => {
    addQuest({ agentExecutionId: 'other-exec', status: 'pending' });

    expect(await settleStrandedQuests(['exec1'])).toBe(0);
    expect(updates).toEqual([]);
  });
});

describe('agentExecutionAbandonedSweep - handler', () => {
  beforeEach(() => {
    fakeQuests.length = 0;
    updates.length = 0;
    failIds.clear();
    staleIds.length = 0;
    vi.clearAllMocks();
  });

  it('settles the quests of the executions it sweeps', async () => {
    // Guards the wiring, not just the helper: before this, markAbandoned ran and
    // the bubble was left spinning because nothing propagated to the quest.
    staleIds.push('exec1');
    addQuest({ agentExecutionId: 'exec1', status: 'pending' });

    const result = await handler();

    expect(result).toMatchObject({ status: 'OK', marked: 1, questsSettled: 1 });
    expect(updates).toEqual([{ id: 'q1', status: 'done', type: 'error', reply: ABANDONED_REPLY }]);
  });

  it('reports zero settled when the sweep found nothing', async () => {
    const result = await handler();

    expect(result).toMatchObject({ status: 'OK', marked: 0 });
    expect(updates).toEqual([]);
  });
});
