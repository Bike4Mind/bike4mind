/**
 * Opti-scoped orchestration profile for the agent_executor path.
 *
 * When an agent run originates on the Optimizer surface (`session.surface === OPTI_SURFACE`)
 * and the caller hasn't pinned an explicit `@agent`, the executor uses THIS profile instead
 * of the generic synthetic default. It offers only the optimizer tools plus a couple of safe
 * generics, denies image generation and multi-agent delegation (keep the loop single-agent and
 * on-task), raises the iteration ceiling to fit a multi-step decomposition walk, and carries a
 * ReAct-shaped loop prompt.
 *
 * Selection lives in `agentExecutor.ts` (surface branch before `resolveTopLevelProfile`); this
 * file is a pure builder so it can be unit-tested without Mongo/AWS/ReActAgent, matching the
 * pattern of `agentExecutor.orchestrationProfile.ts`.
 */

import type { ResolvedOrchestrationProfile } from './agentExecutor.orchestrationProfile';

/**
 * Tools offered to the optimizer agent. The four `optihashi_*` tools resolve from the premium
 * tool map already merged into `externalTools`; `web_search` / `current_datetime` are core
 * generics (verified registered in `b4m-core/services/src/llm/tools/index.ts`). Kept deliberately
 * small so the loop stays on the model->formulate->solve->advance task.
 */
export const OPTI_AGENT_TOOLS: string[] = [
  'optihashi_decompose',
  'optihashi_formulate',
  'optihashi_edit_problem',
  'optihashi_schedule',
  'web_search',
  'current_datetime',
];

/**
 * Explicitly denied even if a payload override tries to re-add them: image generation has a
 * history of hijacking optimizer runs, and delegation/DAG would fan the single-agent loop out
 * into subagents. `pickEffectiveEnabledTools` subtracts `deniedTools` last, so this can't be
 * bypassed by shipping `enabledTools` in the start payload.
 */
const OPTI_DENIED_TOOLS: string[] = ['image_generation', 'edit_image', 'delegate_to_agent', 'coordinate_task'];

/**
 * A decomposition walk is decompose(1) + per-step formulate/solve/read (~2-3 iterations each),
 * so a 3-4 step ladder easily runs 10-15 iterations. `very_thorough` (30) clears that; the
 * executor's hard Zod ceiling of 100 still applies.
 */
const OPTI_MAX_ITERATIONS = { quick: 6, medium: 16, very_thorough: 30 } as const;

/**
 * ReAct-shaped system prompt for the autonomous optimizer loop. Generic optimization guidance
 * only -- no provider names, no "quantum advantage" claims. Prepended to the ReActAgent
 * operational base via the profile's `systemPrompt` -> `personaPrompt` seam, so the loop keeps
 * the base tool-use guidance below this persona.
 *
 * Distinct from the chat-path optimizer prompt (which is prose-first and treats the tool as a
 * silent copy of the prose) -- that shape fights a ReAct loop, where the model's thoughts are
 * the narration channel and each iteration must drive a real tool call.
 */
export const OPTI_AGENT_LOOP_PROMPT = `You are an autonomous optimization agent. Your job is to MODEL and SOLVE the user's
optimization scenario using the optimizer tools -- not merely advise. Work the problem end to end.

Tools:
- optihashi_decompose: break a multi-problem scenario into an ordered plan of solvable sub-problems.
- optihashi_formulate: turn one well-posed problem (or one plan step) into a concrete, structured instance.
- optihashi_edit_problem: adjust the currently loaded problem in place. It takes the current problem as
  an argument -- carry the latest formulated problem forward from your own prior observation and pass it.
- optihashi_schedule: run solvers on a formulated problem and return results.

Loop:
1. If the scenario spans multiple distinct problems, call optihashi_decompose first with the full plan.
   If it is a single well-posed problem, skip straight to optihashi_formulate.
2. Then walk the plan ONE step at a time: formulate (or edit) the step's instance -> schedule it to
   solve -> READ the result from the observation -> decide to advance, refine, or stop.
3. Read every solver result before moving on. If a result is poor or infeasible, refine the formulation
   (optihashi_edit_problem) and re-solve rather than blindly advancing.

Discipline:
- Be conservative about compute tier: most scenarios are well served by classical/durable solvers; say so
  plainly. Never claim one approach "beats" another or assert any performance advantage you did not measure.
- Do not loop for its own sake. Stop when: every planned step is formulated and solved, OR the next step
  would add nothing to the user's answer, OR the user's ask is fully addressed.
- When you stop, give a final answer that summarizes the walk and the result you read from each solve.`;

/**
 * Build the opti orchestration profile. `systemPrompt` defaults to the built-in loop prompt but
 * accepts an override (e.g. an admin-tuned prompt) resolved by the caller.
 */
export function buildOptiOrchestrationProfile(
  systemPrompt: string = OPTI_AGENT_LOOP_PROMPT
): ResolvedOrchestrationProfile {
  return {
    id: 'synthetic:opti-orchestration',
    name: 'Optimizer',
    allowedTools: OPTI_AGENT_TOOLS,
    deniedTools: OPTI_DENIED_TOOLS,
    maxIterations: { ...OPTI_MAX_ITERATIONS },
    defaultThoroughness: 'very_thorough',
    isSynthetic: true,
    systemPrompt,
  };
}
