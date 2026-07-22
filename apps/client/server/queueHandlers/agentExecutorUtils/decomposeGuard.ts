import type { ToolDefinition } from '@bike4mind/services';

/**
 * Message returned when the opti loop tries to decompose a second time. It tells the
 * agent to advance the plan it already has instead of re-planning.
 */
export const DECOMPOSE_ALREADY_DONE_MSG =
  'You already created the plan for this run, so decomposition is done. Do NOT call ' +
  'optihashi_decompose again -- re-planning restarts the walk and resets your progress. ' +
  'Advance the EXISTING plan instead: call optihashi_formulate on the next un-solved step, ' +
  'then optihashi_schedule (scheduling) or optihashi_solve (any other family) to solve it. ' +
  'When every planned step is solved, write the final summary.';

/**
 * Guard optihashi_decompose so it can run at most ONCE per execution (#666).
 *
 * The opti loop prompt says to decompose exactly once, but the model occasionally re-plans
 * mid-run -- which reloads step 1 (a visible console yank), burns an iteration, and re-sources
 * the dataset. This wraps the tool so the FIRST call runs normally and any repeat is a no-op
 * redirect (no re-plan, no populateDecomposition side-effect) that steers the agent back to
 * advancing its existing plan.
 *
 * Returns a NEW map (never mutates the input). If the map has no optihashi_decompose (e.g. a
 * non-opti run where the overlay tool isn't present), it's returned unchanged.
 *
 * `state.decomposeUsed` is the per-execution flag, carried on the durable opti plan ledger
 * (`AgentExecution.optiPlanState`, #680) so it is rehydrated on a continuation Lambda -- a repeat
 * decompose is blocked even across a self-dispatch/resume boundary, not just within one invocation.
 */
export function guardDecomposeOnce(
  tools: Record<string, ToolDefinition>,
  state: { decomposeUsed: boolean },
  onBlocked?: () => void
): Record<string, ToolDefinition> {
  const raw = tools['optihashi_decompose'];
  if (!raw) return tools;
  return {
    ...tools,
    optihashi_decompose: {
      ...raw,
      implementation: (context, config) => {
        const inner = raw.implementation(context, config);
        const run = inner.toolFn;
        return {
          ...inner,
          toolFn: (parameters?: unknown, apiKey?: string) => {
            if (state.decomposeUsed) {
              onBlocked?.();
              return Promise.resolve(DECOMPOSE_ALREADY_DONE_MSG);
            }
            state.decomposeUsed = true;
            return run(parameters, apiKey);
          },
        };
      },
    },
  };
}
