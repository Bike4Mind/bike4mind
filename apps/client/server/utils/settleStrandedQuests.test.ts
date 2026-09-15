import { describe, it, expect, beforeEach, vi } from 'vitest';

interface FakeQuest {
  id: string;
  agentExecutionId: string;
  status: string;
  reply?: string;
  replies?: string[];
  images?: string[];
  videos?: string[];
  structuredReplies?: unknown[];
  toolResults?: unknown[];
}

const { fakeQuests, updates, failIds, findThrows, terminalOnWrite } = vi.hoisted(() => ({
  fakeQuests: [] as FakeQuest[],
  updates: [] as Array<Record<string, unknown>>,
  failIds: new Set<string>(),
  findThrows: { value: false },
  terminalOnWrite: new Set<string>(),
}));

const TERMINAL = ['done', 'stopped'];

vi.mock('@bike4mind/database', () => ({
  questRepository: {
    // Mirrors the real query: matches on agentExecutionId, excludes terminal
    // statuses, returns only the projected content fields. The real filter and
    // projection are covered against Mongo in
    // packages/database/.../QuestModel.findUnfinishedByAgentExecutionIds.test.ts
    findUnfinishedByAgentExecutionIds: vi.fn(async (ids: string[]) => {
      if (findThrows.value) throw new Error('mongo exploded');
      return fakeQuests
        .filter(q => ids.includes(q.agentExecutionId) && !TERMINAL.includes(q.status))
        .map(({ agentExecutionId: _a, status: _s, ...content }) => content);
    }),
    // Mirrors the real conditional write: a quest that reached a terminal
    // status after the read above is not patched, and the caller is told so.
    // The predicate itself is covered against Mongo in
    // packages/database/.../QuestModel.settleIfUnfinished.test.ts
    settleIfUnfinished: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      if (failIds.has(id)) throw new Error('write failed');
      if (terminalOnWrite.has(id)) return false;
      updates.push({ id, ...patch });
      return true;
    }),
  },
}));

import { settleStrandedQuests } from './settleStrandedQuests';
import { ABANDONED_REPLY } from '@server/chatCompletion/questTimeoutRecovery';

const logger = { warn: vi.fn(), error: vi.fn() };

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

const settle = (ids: string[]) => settleStrandedQuests(ids, logger, '[test]');

describe('settleStrandedQuests', () => {
  beforeEach(() => {
    fakeQuests.length = 0;
    updates.length = 0;
    failIds.clear();
    terminalOnWrite.clear();
    findThrows.value = false;
    vi.clearAllMocks();
  });

  it('settles a quest stranded at pending', async () => {
    // The production case: the run died before it ever streamed, so the quest
    // never reached `running` and the liveness recovery cannot see it.
    addQuest({ status: 'pending' });

    expect(await settle(['exec1'])).toEqual({ settled: 1, failed: false });
    expect(updates).toEqual([{ id: 'q1', status: 'done', type: 'error', reply: ABANDONED_REPLY }]);
  });

  it('preserves partial text instead of replacing it with an error', async () => {
    addQuest({ status: 'running', reply: 'here is half an answer' });

    await settle(['exec1']);

    expect(updates).toEqual([{ id: 'q1', status: 'done' }]);
  });

  it('treats images alone as content worth preserving', async () => {
    addQuest({ status: 'pending', images: ['rendered.png'] });

    await settle(['exec1']);

    expect(updates).toEqual([{ id: 'q1', status: 'done' }]);
  });

  it('treats tool output alone as content worth preserving', async () => {
    // A tool-heavy run (notebook cells, tool results) can render a real answer
    // with reply/replies/images/videos all empty. Stamping "please try again"
    // next to visible output misreports it as a total failure.
    addQuest({ status: 'pending', toolResults: [{ type: 'tool_result', content: 'out' }] });

    await settle(['exec1']);

    expect(updates).toEqual([{ id: 'q1', status: 'done' }]);
  });

  it('treats structured replies alone as content worth preserving', async () => {
    addQuest({ status: 'pending', structuredReplies: [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }] });

    await settle(['exec1']);

    expect(updates).toEqual([{ id: 'q1', status: 'done' }]);
  });

  it('does not mistake an empty structure for content', async () => {
    // An assistant turn with no content blocks, and a tool result with an empty
    // body, both render nothing. Counting them as content suppresses the
    // abandoned-run message and leaves a terminal bubble with neither an answer
    // nor an error - the silent blank this path exists to prevent.
    addQuest({ status: 'pending', structuredReplies: [{ role: 'assistant', content: [] }] });
    addQuest({ status: 'pending', agentExecutionId: 'exec2', toolResults: [{ tool_use_id: 't1', content: '' }] });

    await settle(['exec1', 'exec2']);

    expect(updates).toEqual([
      { id: 'q1', status: 'done', type: 'error', reply: ABANDONED_REPLY },
      { id: 'q2', status: 'done', type: 'error', reply: ABANDONED_REPLY },
    ]);
  });

  it('leaves already-terminal quests untouched so a natural finish wins the race', async () => {
    addQuest({ status: 'done', reply: 'complete answer' });
    addQuest({ status: 'stopped' });

    expect(await settle(['exec1'])).toEqual({ settled: 0, failed: false });
    expect(updates).toEqual([]);
  });

  it('keeps settling after one quest fails to write, and reports the failure', async () => {
    addQuest({ id: 'q1', status: 'pending' });
    addQuest({ id: 'q2', status: 'pending' });
    failIds.add('q1');

    // The caller's primary job already succeeded, so one bad write must not
    // strand the rest of the batch - but the execution behind q1 is already
    // terminal, so nothing revisits it. Reporting a clean pass would hide a
    // permanently stranded bubble from the metric watching for exactly that.
    expect(await settle(['exec1'])).toEqual({ settled: 1, failed: true });
    expect(updates.map(u => u.id)).toEqual(['q2']);
  });

  it('does not count a quest that finished between the read and the write', async () => {
    // `persistRunAsQuest` can land the real answer in that gap. The conditional
    // write refuses it, and the pass has to report a bubble it never touched as
    // not settled rather than claiming it.
    addQuest({ status: 'pending' });
    terminalOnWrite.add('q1');

    expect(await settle(['exec1'])).toEqual({ settled: 0, failed: false });
    expect(updates).toEqual([]);
  });

  it('reports failed when the whole pass crashes, distinct from a clean no-op', async () => {
    addQuest({ status: 'pending' });
    findThrows.value = true;

    // Both settle 0; only `failed` tells a crashed pass from "nothing stranded",
    // which is what the separate CloudWatch metric is emitted from.
    expect(await settle(['exec1'])).toEqual({ settled: 0, failed: true });
    expect(logger.error).toHaveBeenCalled();
  });

  it('is a no-op when nothing was swept', async () => {
    addQuest({ status: 'pending' });

    expect(await settle([])).toEqual({ settled: 0, failed: false });
    expect(updates).toEqual([]);
  });

  it('ignores quests belonging to executions that were not swept', async () => {
    addQuest({ agentExecutionId: 'other-exec', status: 'pending' });

    expect(await settle(['exec1'])).toEqual({ settled: 0, failed: false });
    expect(updates).toEqual([]);
  });
});
