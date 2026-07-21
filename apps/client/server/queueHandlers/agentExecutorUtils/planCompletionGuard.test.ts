import { describe, it, expect, vi } from 'vitest';
import type { ToolDefinition } from '@bike4mind/services';
import {
  guardPlanCompletion,
  planIsComplete,
  capturePlan,
  familyForSolveCall,
  extractResultDigest,
  buildPlanCompleteMsg,
  type PlanProgressState,
} from './planCompletionGuard';

const planResult = (families: string[]) =>
  JSON.stringify({
    type: 'populateDecomposition',
    payload: {
      decomposition: { steps: families.map((familyId, i) => ({ familyId, order: i + 1, title: `${familyId} step` })) },
    },
    displayMessage: 'Loaded step 1',
  });

// The schedule/solve tools return a JSON envelope carrying the results markdown in `displayMessage`
// (see quantumSchedule/quantumSolve). Mirror that exact shape so the guard + digest extractor are
// exercised against what they actually receive in production -- escaped quotes, escaped newlines --
// rather than a raw-markdown string the tools never emit.
const envelope = (displayMessage: string, familyId?: string) =>
  JSON.stringify({
    __uiSideEffect: true,
    type: familyId ? 'populateFamilyProblem' : 'populateProblem',
    payload: familyId ? { familyId, problem: {} } : {},
    displayMessage,
  });

const scheduleResult = envelope(
  ['## Scheduling Results for "Sequencing"', 'Problem: 4 jobs, 4 machines', '', '### Winner: Simulated Annealing (makespan: 130)', '', '### Simulated Annealing'].join(
    '\n'
  )
);
const solveResultFor = (p?: unknown) => {
  const fam = (p as { problem?: { family?: string } })?.problem?.family ?? 'selection';
  return envelope(
    [`## Results for "${fam} problem" (${fam})`, '', '### Winner: Tabu Search (score: 42)', '', '### Tabu Search'].join('\n'),
    fam
  );
};

function fakeTool(
  name: string,
  result: string | ((p?: unknown) => string)
): { tool: ToolDefinition; calls: unknown[] } {
  const calls: unknown[] = [];
  const tool = {
    name,
    implementation: () => ({
      toolFn: async (params?: unknown) => {
        calls.push(params);
        return typeof result === 'function' ? result(params) : result;
      },
      toolSchema: { name, description: '', parameters: { type: 'object', properties: {} } },
    }),
  } as unknown as ToolDefinition;
  return { tool, calls };
}

const run = (t: ToolDefinition, params?: unknown) => t.implementation({} as never, undefined).toolFn(params);

function makeOptiTools() {
  const decompose = fakeTool('optihashi_decompose', planResult(['scheduling', 'selection', 'routing']));
  const formulate = fakeTool('optihashi_formulate', '## Formulated: "X" **selection problem**');
  const schedule = fakeTool('optihashi_schedule', scheduleResult);
  const solve = fakeTool('optihashi_solve', solveResultFor);
  return {
    map: {
      optihashi_decompose: decompose.tool,
      optihashi_formulate: formulate.tool,
      optihashi_schedule: schedule.tool,
      optihashi_solve: solve.tool,
    },
    calls: { decompose: decompose.calls, formulate: formulate.calls, schedule: schedule.calls, solve: solve.calls },
  };
}

const emptyState = (): PlanProgressState => ({ steps: null, solved: {}, results: {} });

describe('pure helpers', () => {
  it('capturePlan returns ordered steps with family + title; null for non-plan results', () => {
    expect(capturePlan(planResult(['scheduling', 'selection']))).toEqual([
      { family: 'scheduling', title: 'scheduling step' },
      { family: 'selection', title: 'selection step' },
    ]);
    expect(capturePlan('Error: something broke')).toBeNull();
    expect(capturePlan(JSON.stringify({ type: 'somethingElse' }))).toBeNull();
  });

  it('familyForSolveCall maps schedule->scheduling and reads solve problem.family', () => {
    expect(familyForSolveCall('optihashi_schedule', undefined)).toBe('scheduling');
    expect(familyForSolveCall('optihashi_solve', { problem: { family: 'routing' } })).toBe('routing');
    expect(familyForSolveCall('optihashi_solve', {})).toBeNull();
  });

  it('extractResultDigest unwraps the JSON envelope and pulls the winner+objective cleanly', () => {
    // Real production shape: markdown lives in displayMessage. No trailing whitespace/newline artifact.
    expect(extractResultDigest(scheduleResult)).toBe('Simulated Annealing (makespan: 130)');
    expect(extractResultDigest(solveResultFor({ problem: { family: 'routing' } }))).toBe('Tabu Search (score: 42)');
    // Falls back to raw markdown for callers/strings that aren't the envelope.
    expect(extractResultDigest('### Winner: Greedy (bins: 4)')).toBe('Greedy (bins: 4)');
    // No winner line (single-solver run emits no Winner header) or an error -> null.
    expect(extractResultDigest(envelope(['## Results for "X" (routing)', '', '### Concorde', 'tour: 88'].join('\n'), 'routing'))).toBeNull();
    expect(extractResultDigest('Error: invalid problem')).toBeNull();
  });

  it('planIsComplete needs every planned family covered; min-caps re-solves', () => {
    const steps = [
      { family: 'scheduling', title: 's' },
      { family: 'routing', title: 'r' },
    ];
    expect(planIsComplete(emptyState())).toBe(false);
    expect(planIsComplete({ steps, solved: { scheduling: 1 }, results: {} })).toBe(false);
    // over-solving one family doesn't mask an unsolved one
    expect(planIsComplete({ steps, solved: { scheduling: 5 }, results: {} })).toBe(false);
    expect(planIsComplete({ steps, solved: { scheduling: 1, routing: 1 }, results: {} })).toBe(true);
  });

  it('buildPlanCompleteMsg labels each step by its plan title, in order, with its captured result', () => {
    const state: PlanProgressState = {
      steps: [
        { family: 'scheduling', title: 'Sequence packing stations' },
        { family: 'routing', title: 'Route delivery vans' },
      ],
      solved: { scheduling: 1, routing: 1 },
      results: { scheduling: 'SA (makespan: 130)', routing: 'Tabu (84 km)' },
    };
    const msg = buildPlanCompleteMsg(state);
    expect(msg).toMatch(/FINAL SUMMARY/i);
    expect(msg).toContain('1. Sequence packing stations -- SA (makespan: 130)');
    expect(msg).toContain('2. Route delivery vans -- Tabu (84 km)');
  });

  it('buildPlanCompleteMsg falls back for a step with no captured digest', () => {
    const state: PlanProgressState = {
      steps: [{ family: 'routing', title: 'Route vans' }],
      solved: { routing: 1 },
      results: {},
    };
    expect(buildPlanCompleteMsg(state)).toContain('1. Route vans -- solved (see result in your history above)');
  });
});

describe('guardPlanCompletion', () => {
  it('solves each step once, captures results, then blocks with a result-laden summary redirect', async () => {
    const { map, calls } = makeOptiTools();
    const state = emptyState();
    const onComplete = vi.fn();
    const g = guardPlanCompletion(map, state, onComplete);

    await run(g.optihashi_decompose); // captures plan
    expect(state.steps?.map(s => s.family)).toEqual(['scheduling', 'selection', 'routing']);

    expect(await run(g.optihashi_schedule)).toMatch(/Scheduling Results/);
    expect(await run(g.optihashi_solve, { problem: { family: 'selection' } })).toMatch(/Results for/);
    expect(onComplete).not.toHaveBeenCalled(); // 2 of 3
    expect(await run(g.optihashi_solve, { problem: { family: 'routing' } })).toMatch(/Results for/);
    expect(onComplete).toHaveBeenCalledTimes(1); // all 3 covered

    // results captured per family (winner + objective, unwrapped from the envelope -- no artifact)
    expect(state.results.scheduling).toBe('Simulated Annealing (makespan: 130)');
    expect(state.results.routing).toBe('Tabu Search (score: 42)');

    // Further loop-drivers are redirected; the redirect labels each step by its plan title and
    // carries its captured result, in plan order.
    const redirect = await run(g.optihashi_formulate);
    expect(redirect).toMatch(/FINAL SUMMARY/i);
    expect(redirect).toContain('1. scheduling step -- Simulated Annealing (makespan: 130)');
    expect(redirect).toContain('3. routing step -- Tabu Search (score: 42)');
    expect(await run(g.optihashi_schedule)).toMatch(/FINAL SUMMARY/i);
    expect(calls.schedule).toHaveLength(1); // real schedule ran only once
    expect(calls.formulate).toHaveLength(0); // formulate never ran post-completion
  });

  it('does not count or capture results from failed solves', async () => {
    const solve = fakeTool('optihashi_solve', 'Error: invalid selection problem -- missing budget');
    const map = {
      optihashi_decompose: fakeTool('optihashi_decompose', planResult(['selection'])).tool,
      optihashi_solve: solve.tool,
    };
    const state = emptyState();
    const g = guardPlanCompletion(map, state);
    await run(g.optihashi_decompose);
    await run(g.optihashi_solve, { problem: { family: 'selection' } }); // errors
    expect(planIsComplete(state)).toBe(false);
    expect(state.results.selection).toBeUndefined();
    expect(await run(g.optihashi_solve, { problem: { family: 'selection' } })).toMatch(/Error/); // still allowed
  });

  it('stays inert until a plan is captured (single-problem formulate+solve runs freely)', async () => {
    const { map } = makeOptiTools();
    const g = guardPlanCompletion(map, emptyState());
    expect(await run(g.optihashi_formulate)).toMatch(/Formulated/);
    expect(await run(g.optihashi_solve, { problem: { family: 'selection' } })).toMatch(/Results for/);
  });

  it('returns the map unchanged for a non-opti run (no decompose tool)', () => {
    const other = fakeTool('web_search', 'ok').tool;
    const map = { web_search: other };
    const g = guardPlanCompletion(map, emptyState());
    expect(g).toBe(map);
  });
});
