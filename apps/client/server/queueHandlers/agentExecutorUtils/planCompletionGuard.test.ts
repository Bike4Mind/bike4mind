import { describe, it, expect, vi } from 'vitest';
import type { ToolDefinition } from '@bike4mind/services';
import {
  guardPlanCompletion,
  planIsComplete,
  capturePlan,
  familyForSolveCall,
  PLAN_COMPLETE_MSG,
  type PlanProgressState,
} from './planCompletionGuard';

const planResult = (families: string[]) =>
  JSON.stringify({
    type: 'populateDecomposition',
    payload: { decomposition: { steps: families.map((familyId, i) => ({ familyId, order: i + 1 })) } },
    displayMessage: 'Loaded step 1',
  });

// Fake tool whose toolFn returns a canned result and records the params it saw.
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
  const schedule = fakeTool('optihashi_schedule', '## Scheduling Results for "X" ### Winner: SA');
  const solve = fakeTool('optihashi_solve', '## Results for "X" (selection) ### Winner: Tabu');
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

describe('pure helpers', () => {
  it('capturePlan counts plan steps per family; null for non-plan results', () => {
    expect(capturePlan(planResult(['scheduling', 'selection', 'routing']))).toEqual({
      scheduling: 1,
      selection: 1,
      routing: 1,
    });
    expect(capturePlan(planResult(['scheduling', 'scheduling']))).toEqual({ scheduling: 2 });
    expect(capturePlan('Error: something broke')).toBeNull();
    expect(capturePlan(JSON.stringify({ type: 'somethingElse' }))).toBeNull();
  });

  it('familyForSolveCall maps schedule->scheduling and reads solve problem.family', () => {
    expect(familyForSolveCall('optihashi_schedule', undefined)).toBe('scheduling');
    expect(familyForSolveCall('optihashi_solve', { problem: { family: 'routing' } })).toBe('routing');
    expect(familyForSolveCall('optihashi_solve', {})).toBeNull();
  });

  it('planIsComplete needs every planned family covered; min-caps re-solves', () => {
    expect(planIsComplete({ needed: null, solved: {} })).toBe(false);
    expect(planIsComplete({ needed: { scheduling: 1, routing: 1 }, solved: { scheduling: 1 } })).toBe(false);
    // over-solving one family doesn't mask an unsolved one
    expect(planIsComplete({ needed: { scheduling: 1, routing: 1 }, solved: { scheduling: 5 } })).toBe(false);
    expect(planIsComplete({ needed: { scheduling: 1, routing: 1 }, solved: { scheduling: 1, routing: 1 } })).toBe(true);
  });
});

describe('guardPlanCompletion', () => {
  it('lets each planned step solve once, then blocks re-doing and steers to the summary', async () => {
    const { map, calls } = makeOptiTools();
    const state: PlanProgressState = { needed: null, solved: {} };
    const onComplete = vi.fn();
    const g = guardPlanCompletion(map, state, onComplete);

    await run(g.optihashi_decompose); // captures plan
    expect(state.needed).toEqual({ scheduling: 1, selection: 1, routing: 1 });

    expect(await run(g.optihashi_schedule)).toMatch(/Scheduling Results/); // scheduling solved
    expect(await run(g.optihashi_solve, { problem: { family: 'selection' } })).toMatch(/Results for/);
    expect(onComplete).not.toHaveBeenCalled(); // 2 of 3 so far
    expect(await run(g.optihashi_solve, { problem: { family: 'routing' } })).toMatch(/Results for/);
    expect(onComplete).toHaveBeenCalledTimes(1); // all 3 covered

    // Now every further loop-driver is redirected to the summary and does NOT run the real tool.
    expect(await run(g.optihashi_schedule)).toBe(PLAN_COMPLETE_MSG);
    expect(await run(g.optihashi_solve, { problem: { family: 'scheduling' } })).toBe(PLAN_COMPLETE_MSG);
    expect(await run(g.optihashi_formulate)).toBe(PLAN_COMPLETE_MSG);
    expect(calls.schedule).toHaveLength(1); // real schedule ran only the once
    expect(calls.formulate).toHaveLength(0); // formulate never ran post-completion
  });

  it('does not count failed solves toward completion', async () => {
    const solve = fakeTool('optihashi_solve', 'Error: invalid selection problem -- missing budget');
    const map = {
      optihashi_decompose: fakeTool('optihashi_decompose', planResult(['selection'])).tool,
      optihashi_solve: solve.tool,
    };
    const state: PlanProgressState = { needed: null, solved: {} };
    const g = guardPlanCompletion(map, state);
    await run(g.optihashi_decompose);
    await run(g.optihashi_solve, { problem: { family: 'selection' } }); // errors -> not counted
    expect(planIsComplete(state)).toBe(false);
    // a real subsequent solve is still allowed (not blocked)
    expect(await run(g.optihashi_solve, { problem: { family: 'selection' } })).toMatch(/Error/);
  });

  it('stays inert until a plan is captured (single-problem formulate+solve runs freely)', async () => {
    const { map } = makeOptiTools();
    const state: PlanProgressState = { needed: null, solved: {} };
    const g = guardPlanCompletion(map, state);
    // No decompose called -> needed stays null -> nothing is ever blocked.
    expect(await run(g.optihashi_formulate)).toMatch(/Formulated/);
    expect(await run(g.optihashi_solve, { problem: { family: 'selection' } })).toMatch(/Results for/);
  });

  it('returns the map unchanged for a non-opti run (no decompose tool)', () => {
    const other = fakeTool('web_search', 'ok').tool;
    const map = { web_search: other };
    const g = guardPlanCompletion(map, { needed: null, solved: {} });
    expect(g).toBe(map);
  });
});
