import { describe, expect, it } from 'vitest';
import type { AgentState, AgentView } from '../roster';
import { EMPTY_LEDGER, QUEST_DONE_LINGER_MS, questNotes, questTitle, takeDown, trackQuests } from './quests';

describe('quests', () => {
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

  const LATER = '2026-10-01T00:05:00.000Z';
  /** An agent whose run ended and whose outcome has been stored, which updates its record. */
  const ended = (id: string, state: AgentState, outcome: AgentView['outcome']) =>
    agent(id, state, { outcome, updatedAt: LATER });

  /** A worker task in the given state: only `state.status` and `accepted` matter to the board. */
  const withTask = (status: string, accepted?: boolean) =>
    ({
      workerTask: { state: { status, ...(accepted === undefined ? {} : { accepted }) } },
    }) as unknown as Partial<AgentView>;
  /** A needs-you waiting on the user in the Task panel: the task already holds its own run's outcome. */
  const waiting = (id: string, outcome: AgentView['outcome'], status = 'completed') =>
    agent(id, 'needs-you', {
      outcome,
      updatedAt: LATER,
      ...withTask(status, status === 'completed' ? false : undefined),
    });
  const accepted = (id: string) =>
    agent(id, 'done', { outcome: 'finished', updatedAt: LATER, ...withTask('completed', true) });

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

    it("keeps a re-run open while it still reads as the previous run's outcome", () => {
      for (const [state, outcome] of [
        ['failed', 'failed'],
        ['stopped', 'aborted'],
      ] as const) {
        const ledger = track([
          [agent('a', 'working', { outcome })],
          [agent('a', state, { outcome })],
          [ended('a', 'done', 'finished')],
        ]);
        expect(ledger.finished).toEqual(new Map([['a', 200]]));
      }
    });

    it("holds a re-run open while `done` is still the previous run's finished outcome, then drops it on failure", () => {
      const ledger = track([
        [agent('a', 'working', { outcome: 'finished' })],
        [agent('a', 'done', { outcome: 'finished' })],
      ]);
      expect(ledger.finished.size).toBe(0);
      expect(ledger.open.has('a')).toBe(true);
      const failed = trackQuests(ledger, [ended('a', 'failed', 'failed')], 200);
      expect(failed.open.size).toBe(0);
      expect(failed.finished.size).toBe(0);
    });

    it('checks off a re-run once its done record is a new update', () => {
      const ledger = track([
        [agent('a', 'working', { outcome: 'finished' })],
        [agent('a', 'done', { outcome: 'finished' })],
        [ended('a', 'done', 'finished')],
      ]);
      expect(ledger.finished).toEqual(new Map([['a', 200]]));
      expect(ledger.open.size).toBe(0);
    });

    it('checks off a run the user accepts while it waits on them, even with its record unchanged', () => {
      const ledger = track([
        [agent('a', 'working', { outcome: 'finished' })],
        [waiting('a', 'finished')],
        [accepted('a')],
      ]);
      expect(ledger.finished).toEqual(new Map([['a', 200]]));
      expect(ledger.open.size).toBe(0);
    });

    it('checks off a held re-run that reaches needs-you and is then accepted', () => {
      const ledger = track([
        [agent('a', 'working', { outcome: 'finished' })],
        [agent('a', 'done', { outcome: 'finished' })],
        [waiting('a', 'finished')],
        [accepted('a')],
      ]);
      expect(ledger.finished).toEqual(new Map([['a', 300]]));
      expect(ledger.open.size).toBe(0);
    });

    it("still holds a done straight after working that reads as the previous run's outcome", () => {
      const ledger = track([
        [agent('a', 'needs-you', { outcome: 'finished' })],
        [agent('a', 'working', { outcome: 'finished' })],
        [agent('a', 'done', { outcome: 'finished' })],
        [agent('a', 'done', { outcome: 'finished' })],
      ]);
      expect(ledger.finished.size).toBe(0);
      expect(ledger.open.has('a')).toBe(true);
    });

    it('ends a run the user stops while it waits on them, even with its record unchanged', () => {
      const ledger = track([[waiting('a', 'aborted', 'blocked')], [ended('a', 'stopped', 'aborted')]]);
      expect(ledger.open.size).toBe(0);
      expect(ledger.finished.size).toBe(0);
    });

    it('holds a re-run open at every step through a live approval and a stale done', () => {
      for (const live of [{}, withTask('running')]) {
        let ledger = EMPTY_LEDGER;
        const steps = [
          agent('a', 'working', { outcome: 'finished' }),
          agent('a', 'needs-you', { outcome: 'finished', ...live }),
          agent('a', 'done', { outcome: 'finished' }),
          agent('a', 'working', { outcome: 'finished' }),
        ];
        steps.forEach((step, index) => {
          ledger = trackQuests(ledger, [step], index * 100);
          expect(ledger.finished.size).toBe(0);
          expect(ledger.open.has('a')).toBe(true);
        });
      }
    });

    it('keeps a first run open when a live approval clears to idle with the record unchanged', () => {
      const ledger = track([[agent('a', 'working')], [agent('a', 'needs-you')], [agent('a', 'idle')]]);
      expect(ledger.open.has('a')).toBe(true);
      expect(ledger.finished.size).toBe(0);
    });

    it('ends a re-run that fails again with the same outcome once the record updates', () => {
      const ledger = track([[agent('a', 'working', { outcome: 'failed' })], [ended('a', 'failed', 'failed')]]);
      expect(ledger.open.size).toBe(0);
    });

    it('never adds an agent already done, or one whose quest failed or stopped', () => {
      const ledger = track([
        [agent('a', 'done'), agent('b', 'working'), agent('c', 'idle'), agent('d', 'working')],
        [agent('a', 'done'), ended('b', 'failed', 'failed'), agent('c', 'done'), ended('d', 'stopped', 'aborted')],
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
      expect([...ledger.open.keys()]).toEqual(['b']);
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
      expect(questNotes(after, ledger).find(note => note.done)?.finishedAt).toBe(10);
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
});
