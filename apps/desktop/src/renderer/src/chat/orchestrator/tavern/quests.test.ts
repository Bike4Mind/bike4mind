import { describe, expect, it } from 'vitest';
import type { AgentState, AgentView } from '../roster';
import { EMPTY_LEDGER, QUEST_DONE_LINGER_MS, questNotes, questTitle, takeDown, trackQuests } from './quests';

// testUtils needs a DOM; these helpers only read id, title, state and workerTask.
const agent = (id: string, state: AgentState, extra: Partial<AgentView> = {}): AgentView => ({
  id,
  title: `Agent ${id}`,
  parentId: 'root',
  depth: 1,
  seedPrompt: '',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  model: 'm',
  state,
  ...extra,
});

const withOutcome = (outcome: string) => ({ workerTask: { contract: { outcome } } }) as unknown as Partial<AgentView>;

describe('questTitle', () => {
  it("takes the first line of the task contract's outcome", () => {
    expect(questTitle(agent('a', 'working', withOutcome('  Fix the login flow\nThen add tests')))).toBe(
      'Fix the login flow'
    );
  });

  it('falls back to the session title without a contract, or with a blank outcome', () => {
    expect(questTitle(agent('a', 'working'))).toBe('Agent a');
    expect(questTitle(agent('a', 'working', withOutcome('   ')))).toBe('Agent a');
  });
});

describe('trackQuests', () => {
  const track = (steps: AgentView[][]) =>
    steps.reduce((ledger, agents, index) => trackQuests(ledger, agents, index * 100), EMPTY_LEDGER);

  it('checks off an open quest the moment its agent turns done', () => {
    const ledger = track([
      [agent('a', 'working'), agent('b', 'needs-you')],
      [agent('a', 'done'), agent('b', 'done')],
    ]);
    expect(ledger.finished).toEqual(
      new Map([
        ['a', 100],
        ['b', 100],
      ])
    );
    expect(ledger.open.size).toBe(0);
  });

  it('still checks it off when the agent reads idle between working and done', () => {
    const ledger = track([[agent('a', 'working')], [agent('a', 'idle')], [agent('a', 'done')]]);
    expect(ledger.finished).toEqual(new Map([['a', 200]]));
  });

  it('never adds an agent already done, or one whose quest failed or stopped', () => {
    const ledger = track([
      [agent('a', 'done'), agent('b', 'working'), agent('c', 'idle'), agent('d', 'working')],
      [agent('a', 'done'), agent('b', 'failed'), agent('c', 'done'), agent('d', 'stopped')],
      [agent('a', 'done'), agent('b', 'done'), agent('c', 'done'), agent('d', 'done')],
    ]);
    expect(ledger.finished.size).toBe(0);
  });

  it('keeps the first finish time, and forgets an agent that takes up a quest again or leaves', () => {
    const ledger = track([
      [agent('a', 'working'), agent('b', 'working'), agent('c', 'working')],
      [agent('a', 'done'), agent('b', 'done'), agent('c', 'done')],
      [agent('a', 'done'), agent('b', 'working')],
    ]);
    expect(ledger.finished).toEqual(new Map([['a', 100]]));
    expect([...ledger.open]).toEqual(['b']);
  });
});

describe('takeDown', () => {
  it('drops a finished quest once it has lingered long enough', () => {
    const finished = new Map([
      ['old', 0],
      ['new', 10],
    ]);
    expect(takeDown(finished, QUEST_DONE_LINGER_MS)).toEqual(new Map([['new', 10]]));
  });
});

describe('questNotes', () => {
  it('pins open quests, one on its way to done, and lingering finished ones, in roster order', () => {
    const before = [agent('b', 'working'), agent('c', 'working'), agent('d', 'needs-you'), agent('f', 'working')];
    const after = [
      agent('a', 'done'),
      agent('b', 'working'),
      agent('c', 'idle'),
      agent('d', 'needs-you'),
      agent('e', 'idle', { outcome: 'no-reply' }),
      agent('f', 'done'),
    ];
    const ledger = trackQuests(trackQuests(EMPTY_LEDGER, before, 0), after, 10);
    expect(questNotes(after, ledger).map(note => [note.agent.id, note.done])).toEqual([
      ['b', false],
      ['c', false],
      ['d', false],
      ['f', true],
    ]);
  });

  it('drops a quest whose run ended with no reply', () => {
    const ledger = trackQuests(
      trackQuests(EMPTY_LEDGER, [agent('a', 'working')], 0),
      [agent('a', 'idle', { outcome: 'no-reply' })],
      10
    );
    expect(ledger.open.size).toBe(0);
  });
});
