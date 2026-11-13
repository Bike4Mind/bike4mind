import { describe, expect, it } from 'vitest';
import type { ILoop, ILoopStageStats, ILoopStats, IWorkItem, LoopRunOutcome, ModelInfo } from '@bike4mind/common';
import type { LoopStatsRun } from '@bike4mind/database';
import { COACH, COACH_REFINE_INSTRUCTIONS, coachSuggestions, trialComparison, type CoachInput } from './loopCoach';

const NOW = new Date('2026-11-10T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const loopOf = (overrides: Partial<ILoop> = {}): ILoop =>
  ({
    id: 'loop-1',
    userId: 'u1',
    name: 'Factory',
    goal: 'Ship',
    model: 'big',
    sessionId: 's1',
    intervalMinutes: 30,
    tools: [],
    stages: ['research', 'build', 'review', 'done'],
    status: 'live',
    runCount: 0,
    consecutiveFailures: 0,
    memory: { notes: '', nextAction: '' },
    createdAt: ago(60),
    updatedAt: ago(1),
    ...overrides,
  }) as ILoop;

const outcomes = (counts: Partial<Record<LoopRunOutcome, number>> = {}) => ({
  done: 0,
  blocked: 0,
  unsure: 0,
  failed: 0,
  budget_stopped: 0,
  idle: 0,
  ...counts,
});

const row = (stage: string, overrides: Partial<ILoopStageStats> = {}): ILoopStageStats => ({
  stage,
  runs: 0,
  outcomes: outcomes(),
  retried: 0,
  medianRunMs: null,
  credits: 0,
  medianTimeInStageMs: null,
  entered: 0,
  backMoves: 0,
  bounces: 0,
  toolsUnavailable: [],
  toolsErrored: [],
  ...overrides,
});

const statsOf = (byStage: ILoopStageStats[] = [], daily: ILoopStats['daily'] = []): ILoopStats => ({
  days: 30,
  from: ago(30).toISOString(),
  to: NOW.toISOString(),
  headline: {
    throughputPerDay: { value: null, baseline: null },
    medianCycleMs: { value: null, baseline: null },
    creditsPerClosed: { value: null, baseline: null },
    needsYou: { value: null, baseline: null },
  },
  byStage,
  daily,
  eras: [],
  costByModel: [],
  humanQueue: [],
  ratings: { up: 0, down: 0, unrated: 0 },
  directives: { pushedBack: 0, overruled: 0 },
  truncated: false,
});

const model = (id: string, price: number, overrides: Partial<ModelInfo> = {}): ModelInfo =>
  ({
    id,
    name: id,
    type: 'text',
    backend: 'anthropic',
    supportsTools: true,
    contextWindow: 1000,
    max_tokens: 1000,
    pricing: { 0: { input: price / 2, output: price / 2 } },
    ...overrides,
  }) as ModelInfo;

const ticket = (id: string, overrides: Partial<IWorkItem> = {}): IWorkItem =>
  ({
    id,
    userId: 'u1',
    loopId: 'loop-1',
    title: id,
    status: 'open',
    stage: 'build',
    dependencies: [],
    createdAt: ago(20),
    updatedAt: ago(1),
    ...overrides,
  }) as IWorkItem;

/** `up` + `down` closed tickets rated in the window that went through `stage`. */
const rated = (stage: string, up: number, down: number): IWorkItem[] =>
  [...Array(up).fill('up'), ...Array(down).fill('down')].map((value, i) =>
    ticket(`t-${stage}-${i}`, {
      status: 'closed',
      stage: 'done',
      closedAt: ago(2),
      stageHistory: [
        { stage, at: ago(5), by: 'scheduler' },
        { stage: 'done', at: ago(2), by: 'run' },
      ],
      ownerRating: { value, at: ago(1) },
    } as Partial<IWorkItem>)
  );

const run = (overrides: Partial<LoopStatsRun> = {}): LoopStatsRun =>
  ({ id: `r-${Math.random()}`, createdAt: ago(1), model: 'big', status: 'completed', ...overrides }) as LoopStatsRun;

const input = (overrides: Partial<CoachInput> = {}): CoachInput => ({
  loop: loopOf(),
  stats: statsOf(),
  runs: [],
  tickets: [],
  unsureReasons: {},
  models: [model('big', 10), model('small', 7), model('tiny', 5, { supportsTools: false })],
  canAddTool: () => true,
  now: NOW,
  ...overrides,
});

const keys = (overrides: Partial<CoachInput> = {}) => coachSuggestions(input(overrides)).map(s => s.key);

const days = (credits: number[], budget = 100) =>
  credits.map((value, i) => ({
    day: `2026-11-${String(i + 1).padStart(2, '0')}`,
    closed: 0,
    credits: value,
    budget,
    stages: {},
  }));

describe('coachSuggestions rules', () => {
  it('remove_stage: fires at 95% done over 20 runs with nothing sent back; not below either', () => {
    const at = (runs: number, done: number, backMoves = 0) =>
      keys({ stats: statsOf([row('review', { runs, outcomes: outcomes({ done }) }), row('done', { backMoves })]) });
    expect(at(20, 19)).toContain('remove_stage:review');
    expect(at(20, 18)).not.toContain('remove_stage:review');
    expect(at(19, 19)).not.toContain('remove_stage:review');
    expect(at(20, 20, 1)).not.toContain('remove_stage:review');
    const [suggestion] = coachSuggestions(
      input({ stats: statsOf([row('review', { runs: 20, outcomes: outcomes({ done: 20 }) })]) })
    );
    expect(suggestion.patch).toEqual({ stages: ['research', 'build', 'done'] });
    expect(suggestion.disabledReason).toBeUndefined();
  });

  it('remove_stage is disabled while the stage holds open tickets', () => {
    const [suggestion] = coachSuggestions(
      input({
        stats: statsOf([row('review', { runs: 20, outcomes: outcomes({ done: 20 }) })]),
        tickets: [ticket('a', { stage: 'review' }), ticket('b', { stage: 'review' })],
      })
    );
    expect(suggestion).toMatchObject({ key: 'remove_stage:review', disabledReason: 'Move its 2 tickets first' });
  });

  it('add_stage_before: fires at 30% unsure over 10 runs, with the top reasons and a free name', () => {
    const at = (runs: number, unsure: number, loop = loopOf()) =>
      coachSuggestions(
        input({
          loop,
          stats: statsOf([row('build', { runs, outcomes: outcomes({ unsure }) })]),
          unsureReasons: { build: ['no spec', 'which repo?', 'missing key', 'fourth'] },
        })
      ).find(s => s.key === 'add_stage_before:build');
    expect(at(9, 9)).toBeUndefined();
    expect(at(10, 2)).toBeUndefined();
    const fired = at(10, 3)!;
    expect(fired.evidence).toBe(
      '3 of 10 build runs parked unsure (30%). Top reasons: no spec; which repo?; missing key'
    );
    expect(fired.patch).toEqual({
      stages: ['research', 'refine', 'build', 'review', 'done'],
      stageConfig: [{ stage: 'refine', instructions: COACH_REFINE_INSTRUCTIONS }],
    });
    const taken = at(10, 3, loopOf({ stages: ['refine', 'build', 'done'] }))!;
    expect(taken.patch!.stages).toEqual(['refine', 'refine-2', 'build', 'done']);
  });

  it('cheaper_model: fires at 90% up of 10 rated and 80% done, picking the cheapest tool-capable same-backend model', () => {
    const at = (up: number, down: number, done = 8, models?: ModelInfo[]) =>
      coachSuggestions(
        input({
          stats: statsOf([row('build', { runs: 10, outcomes: outcomes({ done }) })]),
          tickets: rated('build', up, down),
          ...(models && { models }),
        })
      ).find(s => s.key === 'cheaper_model:build');
    const fired = at(9, 1)!;
    expect(fired).toMatchObject({ trialable: true, patch: { stageConfig: [{ stage: 'build', model: 'small' }] } });
    expect(fired.evidence).toBe('build: 9 of 10 rated up; small costs ~30% less per token than big');
    expect(at(8, 2)).toBeUndefined();
    expect(at(9, 0)).toBeUndefined();
    expect(at(9, 1, 7)).toBeUndefined();
    // Not 25% cheaper, another backend, or no tools: no candidate.
    expect(at(9, 1, 8, [model('big', 10), model('small', 8)])).toBeUndefined();
    expect(
      at(9, 1, 8, [model('big', 10), model('small', 5, { backend: 'openai' } as Partial<ModelInfo>)])
    ).toBeUndefined();
  });

  it('stronger_model: fires on 30% rated down or 30% failed over 10 runs; advice only without an escalation model', () => {
    const at = (runs: number, failed: number, up = 0, down = 0, loop = loopOf({ escalationModel: 'huge' })) =>
      coachSuggestions(
        input({
          loop,
          stats: statsOf([row('build', { runs, outcomes: outcomes({ failed }) })]),
          tickets: rated('build', up, down),
        })
      ).find(s => s.key === 'stronger_model:build');
    expect(at(10, 3)).toMatchObject({
      trialable: true,
      patch: { stageConfig: [{ stage: 'build', model: 'huge' }] },
      evidence: 'build: 3 of 10 runs failed or blocked',
    });
    expect(at(10, 2)).toBeUndefined();
    expect(at(9, 9)).toBeUndefined();
    expect(at(10, 0, 7, 3)?.evidence).toBe('build: 3 of 10 rated down');
    expect(at(10, 0, 8, 2)).toBeUndefined();
    const advice = at(10, 3, 0, 0, loopOf())!;
    expect(advice.patch).toBeUndefined();
    expect(advice.title).toBe('Set an escalation model for build');
  });

  it('add_tool: fires at 3 unavailable runs for an addable tool, onto the stage tools when it has its own', () => {
    const at = (count: number, loop = loopOf(), canAddTool = () => true) =>
      coachSuggestions(
        input({
          loop,
          canAddTool,
          stats: statsOf([row('research', { toolsUnavailable: [{ tool: 'web_search', count }] })]),
        })
      ).find(s => s.key === 'add_tool:research:web_search');
    expect(at(3)?.patch).toEqual({ tools: ['web_search'] });
    expect(at(2)).toBeUndefined();
    expect(at(3, loopOf(), () => false)).toBeUndefined();
    expect(at(3, loopOf({ tools: ['web_search'] }))).toBeUndefined();
    expect(at(3, loopOf({ stageConfig: [{ stage: 'research', tools: ['fetch'] }] }))?.patch).toEqual({
      stageConfig: [{ stage: 'research', tools: ['fetch', 'web_search'] }],
    });
  });

  it('failing_tool: advice at 30% errored over 10 runs', () => {
    const at = (runs: number, count: number) =>
      coachSuggestions(
        input({ stats: statsOf([row('build', { runs, toolsErrored: [{ tool: 'github', count }] })]) })
      ).find(s => s.key === 'failing_tool:build:github');
    expect(at(10, 3)).toMatchObject({ evidence: 'github errored in 3 of 10 build runs' });
    expect(at(10, 3)?.patch).toBeUndefined();
    expect(at(10, 2)).toBeUndefined();
    expect(at(9, 9)).toBeUndefined();
  });

  it('slower_schedule: fires at 50% idle over 20 runs, doubling the interval up to the max', () => {
    const at = (total: number, idle: number, loop = loopOf()) =>
      coachSuggestions(
        input({
          loop,
          runs: Array.from({ length: total }, (_, i) => run({ loopOutcome: i < idle ? 'idle' : 'done' })),
        })
      ).find(s => s.key === 'slower_schedule');
    expect(at(20, 10)?.patch).toEqual({ intervalMinutes: 60 });
    expect(at(20, 9)).toBeUndefined();
    expect(at(19, 19)).toBeUndefined();
    expect(at(20, 10, loopOf({ intervalMinutes: 8000 }))?.patch).toEqual({ intervalMinutes: 10_080 });
    expect(at(20, 20, loopOf({ wakeMode: 'tickets' }))).toBeUndefined();
    // Old runs are outside the window.
    expect(
      coachSuggestions(
        input({ runs: Array.from({ length: 20 }, () => run({ loopOutcome: 'idle', createdAt: ago(31) })) })
      )
    ).toEqual([]);
  });

  it('raise_budget: fires when the budget ran out on 4 of the last 7 days', () => {
    const loop = loopOf({ budgetCreditsPerDay: 100 });
    const at = (credits: number[]) => coachSuggestions(input({ loop, stats: statsOf([], days(credits)) }));
    expect(at([100, 100, 100, 100, 10, 10, 10]).find(s => s.key === 'raise_budget')).toMatchObject({
      patch: { budgetCreditsPerDay: 125 },
      evidence: 'Budget ran out on 4 of the last 7 days',
    });
    expect(at([100, 100, 100, 99, 10, 10, 10]).map(s => s.key)).not.toContain('raise_budget');
    expect(keys({ stats: statsOf([], days([100, 100, 100, 100])) })).not.toContain('raise_budget');
  });

  it('raise_budget: a day with a budget-stopped run counts as run out even under the budget', () => {
    const loop = loopOf({ budgetCreditsPerDay: 100 });
    const stopped = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        run({ loopOutcome: 'budget_stopped', createdAt: new Date(`2026-11-0${i + 1}T12:00:00Z`) })
      );
    const at = (n: number) => keys({ loop, stats: statsOf([], days([10, 10, 10, 10, 10, 10, 10])), runs: stopped(n) });
    expect(at(4)).toContain('raise_budget');
    expect(at(3)).not.toContain('raise_budget');
  });

  it('lower_budget: fires when the peak day stayed at or under half the budget over 14 days with runs', () => {
    const loop = loopOf({ budgetCreditsPerDay: 200 });
    const at = (credits: number[]) =>
      coachSuggestions(input({ loop, stats: statsOf([], days(credits, 200)) })).find(s => s.key === 'lower_budget');
    expect(at([...Array(13).fill(10), 100])).toMatchObject({ patch: { budgetCreditsPerDay: 150 } });
    expect(at([...Array(13).fill(10), 101])).toBeUndefined();
    expect(at([...Array(12).fill(10), 0, 100])).toBeUndefined();
  });
});

describe('coachSuggestions suppression', () => {
  const firing = { stats: statsOf([row('review', { runs: 20, outcomes: outcomes({ done: 20 }) })]) };

  it('drops a key dismissed in the last 30 days, and fires it again after', () => {
    const dismissed = (at: Date) =>
      keys({ ...firing, loop: loopOf({ coachDismissed: [{ key: 'remove_stage:review', reason: 'no', at }] }) });
    expect(dismissed(ago(29))).not.toContain('remove_stage:review');
    expect(dismissed(ago(31))).toContain('remove_stage:review');
  });

  it('drops suggestions for the stage on trial', () => {
    const coachTrial = { stage: 'review', model: 'small', baselineModel: 'big', tickets: 10, startedAt: ago(1) };
    expect(keys({ ...firing, loop: loopOf({ coachTrial }) })).toEqual([]);
  });

  it('drops a suggestion whose patch equals the current config, or that PATCH would reject', () => {
    // Already at the longest interval: doubling it changes nothing.
    const idleRuns = Array.from({ length: 20 }, () => run({ loopOutcome: 'idle' }));
    expect(keys({ runs: idleRuns, loop: loopOf({ intervalMinutes: 10_080 }) })).toEqual([]);
    expect(keys({ runs: idleRuns })).toEqual(['slower_schedule']);
    // The stage already runs the escalation model: advice only, with no patch to apply.
    const failing = statsOf([row('build', { runs: 10, outcomes: outcomes({ failed: 3 }) })]);
    const onTarget = loopOf({ escalationModel: 'huge', stageConfig: [{ stage: 'build', model: 'huge' }] });
    expect(coachSuggestions(input({ stats: failing, loop: onTarget }))[0].patch).toBeUndefined();
    // Two stages left: removing one would fail validation.
    expect(
      keys({
        loop: loopOf({ stages: ['review', 'done'] }),
        stats: statsOf([row('review', { runs: 20, outcomes: outcomes({ done: 20 }) })]),
      })
    ).toEqual([]);
  });

  it('sorts budget, schedule, model, tool, stage and shows at most 10', () => {
    const loop = loopOf({ budgetCreditsPerDay: 100, escalationModel: 'huge' });
    const tools = Array.from({ length: 5 }, (_, i) => ({ tool: `tool_${i}`, count: 5 }));
    const result = coachSuggestions(
      input({
        loop,
        stats: statsOf(
          [
            row('research', { toolsUnavailable: tools }),
            row('build', { runs: 10, outcomes: outcomes({ failed: 3 }), toolsUnavailable: tools }),
            row('review', { runs: 20, outcomes: outcomes({ done: 20 }) }),
          ],
          days([100, 100, 100, 100, 100, 100, 100])
        ),
      })
    );
    expect(result).toHaveLength(COACH.maxShown);
    expect(result.map(s => s.kind).slice(0, 3)).toEqual(['budget', 'model', 'tool']);
  });
});

describe('trialComparison', () => {
  const trial = { stage: 'build', model: 'small', baselineModel: 'big', tickets: 2, startedAt: ago(5) };

  it('counts only finished runs on the trial stage and model since the start, against the baseline before it', () => {
    const runs = [
      run({
        loopStage: 'build',
        model: 'small',
        workItemId: 'a',
        loopOutcome: 'done',
        totalCreditsUsed: 4,
        createdAt: ago(4),
      }),
      run({
        loopStage: 'build',
        model: 'small',
        workItemId: 'a',
        loopOutcome: 'done',
        totalCreditsUsed: 2,
        createdAt: ago(3),
      }),
      run({ loopStage: 'build', model: 'small', workItemId: 'b', totalCreditsUsed: 0, createdAt: ago(2) }),
      run({ loopStage: 'review', model: 'small', workItemId: 'c', loopOutcome: 'done', createdAt: ago(2) }),
      run({ loopStage: 'build', model: 'big', workItemId: 'd', loopOutcome: 'failed', createdAt: ago(3) }),
      run({
        loopStage: 'build',
        model: 'big',
        workItemId: 'e',
        loopOutcome: 'done',
        totalCreditsUsed: 10,
        createdAt: ago(10),
      }),
      run({ loopStage: 'build', model: 'big', workItemId: 'f', loopOutcome: 'done', createdAt: ago(40) }),
    ];
    const tickets = [ticket('a', { ownerRating: { value: 'up', at: ago(1) } } as Partial<IWorkItem>), ticket('e')];
    const result = trialComparison(trial, runs, tickets);
    expect(result).toMatchObject({
      done: 1,
      complete: false,
      trial: { model: 'small', runs: 3, tickets: 1, up: 1, down: 0, creditsPerRun: 2, doneRate: 1 },
      baseline: { model: 'big', runs: 1, tickets: 1, creditsPerRun: 10, doneRate: 1 },
    });
    runs.push(run({ loopStage: 'build', model: 'small', workItemId: 'b', loopOutcome: 'blocked', createdAt: ago(1) }));
    expect(trialComparison(trial, runs, tickets)).toMatchObject({ done: 2, complete: true });
  });
});
