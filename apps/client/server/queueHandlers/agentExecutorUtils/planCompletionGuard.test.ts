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

const scheduleResult = '## Scheduling Results for "Sequencing" ### Winner: Simulated Annealing (makespan: 130) ###';
const solveResultFor = (p?: unknown) => {
  const fam = (p as { problem?: { family?: string } })?.problem?.family ?? 'selection';
  return `## Results for "${fam} problem" (${fam}) ### Winner: Tabu Search (score: 42) ###`;
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

  it('extractResultDigest pulls the title and winner+objective; null when no winner line', () => {
    expect(extractResultDigest(scheduleResult)).toBe('Sequencing -- Simulated Annealing (makespan: 130)');
    expect(extractResultDigest('### Winner: Greedy (bins: 4)')).toBe('Greedy (bins: 4)');
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

  it('buildPlanCompleteMsg lists every step in order with its captured result', () => {
    const state: PlanProgressState = {
      steps: [
        { family: 'scheduling', title: 'seq' },
        { family: 'routing', title: 'route' },
      ],
      solved: { scheduling: 1, routing: 1 },
      results: { scheduling: 'Seq -- SA (makespan: 130)', routing: 'Route -- Tabu (84 km)' },
    };
    const msg = buildPlanCompleteMsg(state);
    expect(msg).toMatch(/FINAL SUMMARY/i);
    expect(msg).toContain('1. scheduling -- Seq -- SA (makespan: 130)');
    expect(msg).toContain('2. routing -- Route -- Tabu (84 km)');
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

    // results captured per family for the summary
    expect(state.results.scheduling).toContain('Simulated Annealing (makespan: 130)');
    expect(state.results.routing).toContain('routing problem');

    // Further loop-drivers are redirected; the redirect carries every step's result.
    const redirect = await run(g.optihashi_formulate);
    expect(redirect).toMatch(/FINAL SUMMARY/i);
    expect(redirect).toContain('1. scheduling');
    expect(redirect).toContain('3. routing');
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
