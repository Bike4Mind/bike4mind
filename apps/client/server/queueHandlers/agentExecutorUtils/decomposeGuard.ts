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
 * the dataset. This wraps the tool so the FIRST successful call runs normally and any repeat -- once
 * a plan has actually loaded -- is a no-op redirect that steers the agent back to advancing it.
 *
 * Returns a NEW map (never mutates the input). If the map has no optihashi_decompose (e.g. a
 * non-opti run where the overlay tool isn't present), it's returned unchanged.
 *
 * State is carried on the durable opti plan ledger (`AgentExecution.optiPlanState`, #680) so it is
 * rehydrated on a continuation Lambda -- a re-plan is blocked even across a self-dispatch/resume.
 * The block requires BOTH `decomposeUsed` AND `steps.length > 0`: a first decompose that fails or
 * returns an unparseable success latches `decomposeUsed` with no captured plan, and gating on that
 * alone would durably poison the run (every retry redirected to a plan that never loaded). Requiring
 * a loaded plan lets those cases re-decompose while still blocking a genuine re-plan.
 */
export function guardDecomposeOnce(
  tools: Record<string, ToolDefinition>,
  state: { decomposeUsed: boolean; steps: readonly unknown[] },
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
            // Block a repeat decompose ONLY once a plan actually loaded (steps captured by
            // planCompletionGuard from a parseable result). Gating on `decomposeUsed` alone would,
            // with the durable ledger (#680), permanently poison a run whose first decompose failed
            // OR succeeded-but-unparseable: the flag would latch with steps=[] and every retry would
            // get redirected to advance a plan that never loaded. Requiring steps>0 lets those cases
            // re-decompose while still blocking a genuine re-plan.
            if (state.decomposeUsed && state.steps.length > 0) {
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
