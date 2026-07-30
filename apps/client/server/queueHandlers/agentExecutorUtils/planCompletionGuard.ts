import type { ToolDefinition } from '@bike4mind/services';
import type { IOptiPlanState, IOptiPlanStep } from '@bike4mind/database';

/** One planned sub-problem: its family and the short title the decomposition gave it. */
type PlanStep = IOptiPlanStep;

/**
 * The slice of the durable opti plan ledger this guard reads/writes. Derived from the persisted
 * `IOptiPlanState` (single source of truth, #680) rather than re-declared, so a change to those
 * fields' shapes propagates here instead of silently drifting. `steps` is the ordered plan captured
 * from the decompose result (empty until a decomposition loads, so single-problem runs are never
 * gated); `solved` counts SUCCESSFUL schedule/solve calls per family; `results` holds the first
 * winning-result digest per family, so the completion redirect can hand the agent the actual per-step
 * results to summarize (its own transcript memory of earlier steps is unreliable -- the bug we fix).
 */
export type PlanProgressState = Pick<IOptiPlanState, 'steps' | 'solved' | 'results'>;

type ToolFn = (parameters?: unknown, apiKey?: string) => Promise<string>;

/** Parse the decompose tool result into the ordered plan steps. Null if it isn't a plan. */
export function capturePlan(result: string): PlanStep[] | null {
  try {
    const parsed = JSON.parse(result) as {
      type?: string;
      payload?: { decomposition?: { steps?: Array<{ familyId?: unknown; title?: unknown }> } };
    };
    if (parsed?.type !== 'populateDecomposition') return null;
    const rawSteps = parsed.payload?.decomposition?.steps;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) return null;
    const steps: PlanStep[] = [];
    for (const step of rawSteps) {
      if (typeof step?.familyId === 'string') {
        steps.push({ family: step.familyId, title: typeof step.title === 'string' ? step.title : step.familyId });
      }
    }
    return steps.length > 0 ? steps : null;
  } catch {
    return null;
  }
}

/** Planned count per family, derived from the ordered steps. */
function neededByFamily(steps: PlanStep[]): Record<string, number> {
  const needed: Record<string, number> = {};
  for (const s of steps) needed[s.family] = (needed[s.family] ?? 0) + 1;
  return needed;
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
 * The schedule/solve tools return a JSON envelope ({ __uiSideEffect, type, payload, displayMessage })
 * whose `displayMessage` carries the results markdown. Unwrap it so the digest regex matches against
 * real markdown (real newlines, unescaped quotes) rather than the escaped JSON string. Falls back to
 * the raw input when it isn't that envelope (e.g. a plain-markdown or error string).
 */
function resultMarkdown(result: string): string {
  try {
    const parsed = JSON.parse(result) as { displayMessage?: unknown };
    if (typeof parsed?.displayMessage === 'string') return parsed.displayMessage;
  } catch {
    // not JSON -- treat the input as raw markdown
  }
  return result;
}

/**
 * Pull the "<winner + objective>" digest out of a schedule/solve result (both render a
 * `### Winner: <solver> (<objective>: N)` line in their `displayMessage` markdown). Null if no
 * winner line is present (e.g. a single-solver run, which emits no Winner header, or an error).
 * The per-step label is supplied by the plan (see `buildPlanCompleteMsg`), so this stays scoped to
 * the outcome.
 */
export function extractResultDigest(result: string): string | null {
  const winner = resultMarkdown(result)
    .match(/Winner:\s*([^\n#]+?)\s*(?:###|\n|$)/i)?.[1]
    ?.trim();
  return winner || null;
}

/**
 * Complete when every planned family has at least as many successful solves as the plan calls for.
 * `min(solved, needed)` per family caps re-solves so over-solving one step can't mask an unsolved
 * one; the run is done only when the covered-step count reaches the plan length.
 */
export function planIsComplete(state: PlanProgressState): boolean {
  if (state.steps.length === 0) return false;
  const needed = neededByFamily(state.steps);
  let planSteps = 0;
  let covered = 0;
  for (const [fam, n] of Object.entries(needed)) {
    planSteps += n;
    covered += Math.min(state.solved[fam] ?? 0, n);
  }
  return planSteps > 0 && covered >= planSteps;
}

/**
 * The redirect returned once every planned step has a result. It hands the agent the captured
 * per-step results (in plan order) so it writes a COMPLETE, accurate final summary rather than
 * re-deriving from its transcript (where earlier steps are buried and get forgotten/undersold).
 */
export function buildPlanCompleteMsg(state: PlanProgressState): string {
  const lines = state.steps.map((step, i) => {
    const digest = state.results[step.family];
    return `${i + 1}. ${step.title}${digest ? ` -- ${digest}` : ' -- solved (see result in your history above)'}`;
  });
  return [
    'All planned steps for this run have been solved. Do NOT formulate, schedule, or solve anything',
    'else, and do NOT re-do a step. Write your FINAL SUMMARY now, reporting the winning solver and',
    'objective for EACH step below, then stop:',
    ...lines,
  ].join('\n');
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
 * ceiling. This guard captures the plan from the decompose result, counts successful schedule/solve
 * calls per family (and remembers each step's winning result), and once every planned step has a
 * result it turns any further formulate/schedule/solve into a no-op redirect that hands the agent
 * the per-step results and tells it to write its final summary. The #666 decompose guard is
 * complementary (it blocks re-PLANNING; this blocks re-SOLVING).
 *
 * Returns a NEW map (never mutates the input). Only meaningful for the decompose-driven multi-step
 * loop, and stays inert until a decomposition loads, so non-opti and single-problem runs are
 * unaffected.
 */
export function guardPlanCompletion(
  tools: Record<string, ToolDefinition>,
  state: PlanProgressState,
  onComplete?: () => void
): Record<string, ToolDefinition> {
  if (!tools['optihashi_decompose']) return tools;

  const guarded = { ...tools };

  // Capture the plan when decompose runs. Does not block repeats -- that's the #666 guard's job.
  const decompose = tools['optihashi_decompose'];
  guarded.optihashi_decompose = wrap(decompose, run => async (parameters, apiKey) => {
    const out = await run(parameters, apiKey);
    if (state.steps.length === 0) {
      const captured = capturePlan(out);
      if (captured) state.steps = captured;
    }
    return out;
  });

  // Formulate: once the plan is complete, don't build another instance -- redirect to summary.
  const formulate = tools['optihashi_formulate'];
  if (formulate) {
    guarded.optihashi_formulate = wrap(formulate, run => async (parameters, apiKey) => {
      if (planIsComplete(state)) return buildPlanCompleteMsg(state);
      return run(parameters, apiKey);
    });
  }

  // Schedule / solve: block once complete; otherwise run, count a successful solve, and remember
  // the first winning result per family for the summary. The call that finishes the last step still
  // runs (not complete when it starts); the NEXT one blocks. onComplete fires exactly once because
  // after completion the top short-circuits before reaching the increment.
  for (const name of ['optihashi_schedule', 'optihashi_solve'] as const) {
    const tool = tools[name];
    if (!tool) continue;
    guarded[name] = wrap(tool, run => async (parameters, apiKey) => {
      if (planIsComplete(state)) return buildPlanCompleteMsg(state);
      const out = await run(parameters, apiKey);
      if (isToolSuccess(out)) {
        const fam = familyForSolveCall(name, parameters);
        if (fam) {
          if (!(fam in state.results)) {
            const digest = extractResultDigest(out);
            if (digest) state.results[fam] = digest;
          }
          state.solved[fam] = (state.solved[fam] ?? 0) + 1;
          if (planIsComplete(state)) onComplete?.();
        }
      }
      return out;
    });
  }

  return guarded;
}
