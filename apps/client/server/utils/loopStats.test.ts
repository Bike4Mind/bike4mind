import { describe, expect, it } from 'vitest';
import type { ILoopDirective, ILoopEvent, IWorkItem, IWorkItemStageEntry } from '@bike4mind/common';
import type { LoopStatsRun } from '@bike4mind/database';
import { computeLoopStats, ticketSegment, type LoopStatsInput } from './loopStats';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = new Date('2026-11-10T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const stages = ['todo', 'doing', 'review', 'done'];

const ticket = (overrides: Partial<IWorkItem>): IWorkItem => ({
  id: 't',
  userId: 'u1',
  loopId: 'l1',
  title: 'T',
  status: 'open',
  dependencies: [],
  createdAt: ago(20 * DAY),
  updatedAt: ago(DAY),
  ...overrides,
});
const entry = (stage: string, at: Date, by: IWorkItemStageEntry['by'] = 'scheduler'): IWorkItemStageEntry => ({
  stage,
  at,
  by,
});
const run = (overrides: Partial<LoopStatsRun>): LoopStatsRun => ({
  id: 'r',
  createdAt: ago(DAY),
  completedAt: new Date(ago(DAY).getTime() + 10 * 60_000),
  status: 'completed',
  model: 'model-a',
  totalCreditsUsed: 10,
  ...overrides,
});

const stats = (overrides: Partial<LoopStatsInput> = {}) =>
  computeLoopStats({
    loop: { stages, budgetCreditsPerDay: 100 },
    days: 7,
    now,
    runs: [],
    tickets: [],
    eras: [],
    unresolved: [],
    directives: [],
    truncated: false,
    ...overrides,
  });

describe('ticketSegment', () => {
  it('starts at the last hand-off, drops unknown stages and collapses repeats', () => {
    const segment = ticketSegment(
      ticket({
        stage: 'doing',
        stageHistory: [
          entry('elsewhere', ago(9 * DAY), 'owner'),
          entry('todo', ago(8 * DAY), 'handoff'),
          entry('todo', ago(7 * DAY), 'owner'),
          entry('gone', ago(6 * DAY), 'owner'),
          entry('doing', ago(5 * DAY)),
        ],
      }),
      stages
    );
    expect(segment.map(e => e.stage)).toEqual(['todo', 'doing']);
    expect(segment[0].by).toBe('handoff');
  });

  it('counts a ticket older than the history from its createdAt in its stage', () => {
    const created = ago(3 * DAY);
    expect(ticketSegment(ticket({ stage: 'review', createdAt: created }), stages)).toEqual([
      { stage: 'review', at: created, by: 'owner' },
    ]);
  });
});

describe('computeLoopStats', () => {
  it('measures throughput, cycle time and credits per closed ticket against the baseline', () => {
    const closedTicket = (id: string, created: number, closed: number): IWorkItem =>
      ticket({
        id,
        status: 'closed',
        stage: 'done',
        closedAt: ago(closed),
        stageHistory: [entry('todo', ago(created), 'owner'), entry('done', ago(closed))],
      });
    const result = stats({
      tickets: [
        closedTicket('a', 3 * DAY, 2 * DAY), // cycle 1 day
        closedTicket('b', 4 * DAY, DAY), // cycle 3 days
        closedTicket('c', 10 * DAY, 9 * DAY), // baseline, cycle 1 day
      ],
      runs: [run({ totalCreditsUsed: 30 }), run({ totalCreditsUsed: 10 }), run({ createdAt: ago(9 * DAY) })],
    });
    expect(result.headline.throughputPerDay).toEqual({ value: 2 / 7, baseline: 1 / 7 });
    expect(result.headline.medianCycleMs).toEqual({ value: 2 * DAY, baseline: DAY });
    expect(result.headline.creditsPerClosed).toEqual({ value: 20, baseline: 10 });
    expect(result.ratings).toEqual({ up: 0, down: 0, unrated: 2 });
  });

  it('starts the cycle at createdAt once a full history may have dropped the first entries', () => {
    const moves = Array.from({ length: 50 }, (_, i) => entry(i % 2 ? 'doing' : 'todo', ago(5 * DAY - i * HOUR)));
    const closedAt = ago(DAY);
    const full = ticket({ status: 'closed', stage: 'done', createdAt: ago(10 * DAY), closedAt, stageHistory: moves });
    expect(stats({ tickets: [full] }).headline.medianCycleMs.value).toBe(9 * DAY);
    // A full history that still holds its hand-off starts the cycle there.
    const handedOff = { ...full, stageHistory: [entry('todo', ago(5 * DAY), 'handoff'), ...moves.slice(1)] };
    expect(stats({ tickets: [handedOff] }).headline.medianCycleMs.value).toBe(4 * DAY);
  });

  it('counts runs, outcomes, retries and tools per stamped stage', () => {
    const result = stats({
      runs: [
        run({ loopStage: 'doing', loopOutcome: 'done', loopAttempt: 1, toolsErrored: ['fetch'] }),
        run({ loopStage: 'doing', loopOutcome: 'blocked', loopAttempt: 2, toolsErrored: ['fetch', 'search'] }),
        run({ loopStage: 'doing', loopOutcome: 'failed', loopAttempt: 3, toolsUnavailable: ['gone'] }),
        // Unstamped (older or triage) runs count only in the totals.
        run({ loopRunKind: 'triage', model: 'model-b', totalCreditsUsed: 5 }),
      ],
    });
    const doing = result.byStage.find(row => row.stage === 'doing')!;
    expect(doing).toMatchObject({ runs: 3, retried: 2, credits: 30, medianRunMs: 10 * 60_000 });
    expect(doing.outcomes).toMatchObject({ done: 1, blocked: 1, failed: 1, unsure: 0 });
    expect(doing.toolsErrored).toEqual([
      { tool: 'fetch', count: 2 },
      { tool: 'search', count: 1 },
    ]);
    expect(doing.toolsUnavailable).toEqual([{ tool: 'gone', count: 1 }]);
    expect(result.byStage.find(row => row.stage === 'todo')!.runs).toBe(0);
    expect(result.costByModel).toEqual([
      { model: 'model-a', runs: 3, credits: 30 },
      { model: 'model-b', runs: 1, credits: 5 },
    ]);
  });

  it('attributes back-moves to the stage left, and counts only run or scheduler ones as bounces', () => {
    const result = stats({
      tickets: [
        ticket({
          id: 'a',
          stage: 'doing',
          stageHistory: [
            entry('todo', ago(6 * DAY), 'owner'),
            entry('doing', ago(5 * DAY)),
            entry('review', ago(4 * DAY)),
            entry('doing', ago(3 * DAY), 'run'), // bounce out of review
            entry('review', ago(2 * DAY)),
            entry('todo', ago(DAY), 'owner'), // owner back-move, not a bounce
            entry('doing', ago(HOUR)),
          ],
        }),
      ],
    });
    const row = (stage: string) => result.byStage.find(r => r.stage === stage)!;
    expect(row('review')).toMatchObject({ backMoves: 2, bounces: 1, entered: 2 });
    expect(row('doing')).toMatchObject({ backMoves: 0, entered: 3 });
    // Stays in review: 1 day and 1 day.
    expect(row('review').medianTimeInStageMs).toBe(DAY);
    // Stays in doing: 1, 1 day, and the open one of an hour.
    expect(row('doing').medianTimeInStageMs).toBe(DAY);
  });

  it('builds one day per window day with the cumulative flow, spend and budget', () => {
    const result = stats({
      tickets: [
        ticket({ id: 'a', stage: 'doing', stageHistory: [entry('todo', ago(3 * DAY)), entry('doing', ago(DAY))] }),
        ticket({ id: 'pre-history' }),
      ],
      runs: [run({ createdAt: ago(DAY), totalCreditsUsed: 7 })],
    });
    expect(result.daily).toHaveLength(7);
    expect(result.daily.at(-1)).toMatchObject({ day: '2026-11-10', budget: 100, stages: { doing: 1, todo: 0 } });
    expect(result.daily.at(-2)).toMatchObject({ day: '2026-11-09', credits: 7, stages: { doing: 1 } });
    expect(result.daily.at(-3)).toMatchObject({ stages: { todo: 1, doing: 0 } });
    expect(result.daily[0].stages).toMatchObject({ todo: 0, doing: 0 });
    expect(result.historyBegins).toBe(ago(3 * DAY).toISOString());
  });

  it('lists the human queue oldest first, deduped by ticket, with eras, ratings and directives', () => {
    const asked = {
      id: 'e1',
      kind: 'unsure',
      source: 'asked',
      executionId: 'run-1',
      workItemId: 'q',
      reason: 'Which API?',
      requestedAt: ago(2 * DAY),
    } as ILoopEvent;
    const result = stats({
      tickets: [
        ticket({ id: 'q', title: 'Question', stage: 'doing', status: 'blocked', statusReason: 'Unsure: which' }),
        ticket({ id: 'b', title: 'Blocked', stage: 'todo', status: 'blocked', statusReason: 'x', updatedAt: ago(DAY) }),
        ticket({ id: 'p', status: 'blocked', blockedOn: 'dependencies', statusReason: 'deps' }),
        ticket({ id: 'up', status: 'closed', closedAt: ago(DAY), ownerRating: { value: 'up', at: now } }),
      ],
      unresolved: [asked],
      eras: [{ requestedAt: ago(DAY), reason: 'budget 1 -> 2' } as ILoopEvent],
      directives: [
        {
          replies: [
            { by: 'worker', outcome: 'pushed_back', executionId: 'x', at: ago(DAY) },
            { by: 'owner', outcome: 'overruled', userId: 'u1', at: ago(DAY) },
            { by: 'worker', outcome: 'pushed_back', executionId: 'x', at: ago(30 * DAY) },
          ],
        } as unknown as ILoopDirective,
      ],
    });
    expect(result.humanQueue.map(row => [row.workItemId, row.reason])).toEqual([
      ['q', 'unsure'],
      ['b', 'blocked'],
    ]);
    expect(result.humanQueue[0]).toMatchObject({ title: 'Question', stage: 'doing', executionId: 'run-1' });
    expect(result.headline.needsYou).toEqual({ value: 2, baseline: null });
    expect(result.eras).toEqual([{ at: ago(DAY).toISOString(), reason: 'budget 1 -> 2' }]);
    expect(result.ratings).toEqual({ up: 1, down: 0, unrated: 0 });
    expect(result.directives).toEqual({ pushedBack: 1, overruled: 1 });
  });

  it('shows when history began only while some ticket predates it', () => {
    const withHistory = ticket({ id: 'a', stage: 'todo', stageHistory: [entry('todo', ago(DAY))] });
    expect(stats({ tickets: [withHistory] }).historyBegins).toBeUndefined();
  });

  it('folds the window head before its first midnight into the first bar, so the bars add up', () => {
    // now is 12:00 UTC, so the 7-day window opens at 12:00 seven days ago and the first bar at the next midnight.
    const head = run({ createdAt: ago(7 * DAY - 6 * HOUR), totalCreditsUsed: 5 });
    const result = stats({ runs: [head, run({ totalCreditsUsed: 3 })] });
    expect(result.daily[0].credits).toBe(5);
    expect(result.daily.reduce((sum, day) => sum + day.credits, 0)).toBe(8);
  });

  it('has no run baseline for the 90-day window, whose baseline runs have expired', () => {
    const closed = (id: string, at: Date) =>
      ticket({ id, status: 'closed', stage: 'done', closedAt: at, stageHistory: [entry('done', at)] });
    const result = stats({
      days: 90,
      tickets: [closed('a', ago(DAY)), closed('b', ago(100 * DAY))],
      runs: [run({ totalCreditsUsed: 30 })],
    });
    expect(result.headline.creditsPerClosed).toEqual({ value: 30, baseline: null });
    expect(result.headline.throughputPerDay.baseline).toBe(1 / 90);
  });

  it('reports nothing to measure as null, not zero', () => {
    const result = stats();
    expect(result.headline.medianCycleMs).toEqual({ value: null, baseline: null });
    expect(result.headline.creditsPerClosed).toEqual({ value: null, baseline: null });
    expect(result.historyBegins).toBeUndefined();
  });
});
