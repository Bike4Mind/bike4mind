import type { ToolDefinition } from '@bike4mind/services';

/**
 * Message returned once every planned step has a solver result, when the agent tries to
 * formulate/solve yet again. It tells the agent the walk is done and to write the summary.
 */
export const PLAN_COMPLETE_MSG =
  'All planned steps for this run have been solved -- each step already has a solver result in ' +
  'your history above. Do NOT formulate, schedule, or solve anything else, and do NOT re-do a ' +
  'step. Write your FINAL SUMMARY now: for each step name the winning solver and its objective ' +
  'value, then stop.';

/**
 * Per-execution plan progress. `needed` is captured from the decompose result (familyId -> number
 * of plan steps of that family); it stays null until a decomposition loads, so single-problem runs
 * (formulate+solve, no decompose) are never gated. `solved` counts SUCCESSFUL schedule/solve calls
 * per family. Keep this in the caller's execution closure so it survives tool-map rebuilds.
 */
export type PlanProgressState = {
  needed: Record<string, number> | null;
  solved: Record<string, number>;
};

type ToolFn = (parameters?: unknown, apiKey?: string) => Promise<string>;

/** Parse the decompose tool result and count plan steps per family. Null if it isn't a plan. */
export function capturePlan(result: string): Record<string, number> | null {
  try {
    const parsed = JSON.parse(result) as {
      type?: string;
      payload?: { decomposition?: { steps?: Array<{ familyId?: unknown }> } };
    };
    if (parsed?.type !== 'populateDecomposition') return null;
    const steps = parsed.payload?.decomposition?.steps;
    if (!Array.isArray(steps) || steps.length === 0) return null;
    const needed: Record<string, number> = {};
    for (const step of steps) {
      const fam = step?.familyId;
      if (typeof fam === 'string') needed[fam] = (needed[fam] ?? 0) + 1;
    }
    return Object.keys(needed).length > 0 ? needed : null;
  } catch {
    return null;
  }
}

/** The family a schedule/solve call targets: scheduling for schedule, `problem.family` for solve. */
export function familyForSolveCall(toolName: string, parameters: unknown): string | null {
  if (toolName === 'optihashi_schedule') return 'scheduling';
  if (toolName === 'optihashi_solve') {
    const fam = (parameters as { problem?: { family?: unknown } } | undefined)?.problem?.family;
    return typeof fam === 'string' ? fam : null;
  }
  return null;
}

/** A tool result is a success unless it is one of the tools' `Error: ...` returns. */
function isToolSuccess(result: string): boolean {
  return !result.trimStart().toLowerCase().startsWith('error');
}

/**
 * Complete when every planned family has at least as many successful solves as the plan calls for.
 * `min(solved, needed)` per family caps re-solves so over-solving one step can't mask an unsolved
 * one; the run is done only when the covered-step count reaches the plan length.
 */
export function planIsComplete(state: PlanProgressState): boolean {
  if (!state.needed) return false;
  let planSteps = 0;
  let covered = 0;
  for (const [fam, n] of Object.entries(state.needed)) {
    planSteps += n;
    covered += Math.min(state.solved[fam] ?? 0, n);
  }
  return planSteps > 0 && covered >= planSteps;
}

function wrap(tool: ToolDefinition, makeFn: (run: ToolFn) => ToolFn): ToolDefinition {
  return {
    ...tool,
    implementation: (context, config) => {
      const inner = tool.implementation(context, config);
      return { ...inner, toolFn: makeFn(inner.toolFn as ToolFn) };
    },
  };
}

/**
 * Stop the opti loop from re-doing already-solved steps (the dominant iteration-budget drain).
 *
 * A decompose plan is an ordered set of single-family sub-problems. The agent has no reliable
 * memory of which steps it already solved -- it re-derives from a long transcript each turn -- so
 * it repeatedly re-formulates and re-solves families it already covered, running to the iteration
 * ceiling. This guard captures the plan from the decompose result, counts successful solves per
 * family, and once every planned step has a result it turns any further formulate/schedule/solve
 * into a no-op redirect telling the agent to write its final summary. The #666 decompose guard is
 * complementary (it blocks re-PLANNING; this blocks re-SOLVING).
 *
 * Returns a NEW map (never mutates the input). Only wraps opti tools that are present, and stays
 * inert until a decomposition loads, so non-opti and single-problem runs are unaffected.
 */
export function guardPlanCompletion(
  tools: Record<string, ToolDefinition>,
  state: PlanProgressState,
  onComplete?: () => void
): Record<string, ToolDefinition> {
  // Only the decompose-driven multi-step loop has a "plan" to complete.
  if (!tools['optihashi_decompose']) return tools;

  const guarded = { ...tools };

  // Capture the plan when decompose runs. Does not block repeats -- that's the #666 guard's job.
  const decompose = tools['optihashi_decompose'];
  guarded.optihashi_decompose = wrap(decompose, run => async (parameters, apiKey) => {
    const out = await run(parameters, apiKey);
    if (!state.needed) {
      const captured = capturePlan(out);
      if (captured) state.needed = captured;
    }
    return out;
  });

  // Formulate: once the plan is complete, don't build another instance -- redirect to summary.
  const formulate = tools['optihashi_formulate'];
  if (formulate) {
    guarded.optihashi_formulate = wrap(formulate, run => async (parameters, apiKey) => {
      if (planIsComplete(state)) return PLAN_COMPLETE_MSG;
      return run(parameters, apiKey);
    });
  }

  // Schedule / solve: block once complete; otherwise run and count a successful solve. The call
  // that finishes the last step still runs (not yet complete when it starts); the NEXT one blocks.
  for (const name of ['optihashi_schedule', 'optihashi_solve'] as const) {
    const tool = tools[name];
    if (!tool) continue;
    guarded[name] = wrap(tool, run => async (parameters, apiKey) => {
      if (planIsComplete(state)) return PLAN_COMPLETE_MSG;
      const out = await run(parameters, apiKey);
      if (isToolSuccess(out)) {
        const fam = familyForSolveCall(name, parameters);
        if (fam) {
          const wasComplete = planIsComplete(state);
          state.solved[fam] = (state.solved[fam] ?? 0) + 1;
          if (!wasComplete && planIsComplete(state)) onComplete?.();
        }
      }
      return out;
    });
  }

  return guarded;
}
