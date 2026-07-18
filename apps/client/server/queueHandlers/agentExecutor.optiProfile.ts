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
  'optihashi_solve',
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
 * only -- no provider names, no unmeasured performance-advantage claims. Prepended to the ReActAgent
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
- optihashi_schedule: run solvers on a job-shop SCHEDULING problem and return results.
- optihashi_solve: run solvers on ANY OTHER family problem (routing, packing, assignment, network,
  partitioning, selection, economic, continuous) and return results. Pass the formulated problem (with its
  "family" field). Use optihashi_solve for every non-scheduling step; use optihashi_schedule only for scheduling.

Loop:
1. If the scenario spans multiple distinct problems, call optihashi_decompose ONCE with the full plan.
   IMPORTANT: optihashi_decompose automatically formulates and loads STEP 1 as the active brief -- do
   NOT call optihashi_formulate for step 1, it is already loaded. (Only if the scenario is a single
   well-posed problem with no decomposition: call optihashi_formulate once to load it.)
2. Solve the currently loaded step: run solvers on the active brief -- optihashi_schedule if the step's
   family is scheduling, otherwise optihashi_solve -- then READ the result from the observation.
3. Advance to the NEXT planned step (2, 3, ...): call optihashi_formulate to build THAT step's instance
   -- this is the ONLY time you formulate; never re-formulate a step that is already loaded -- then run
   solvers on it (optihashi_schedule or optihashi_solve, by family), then read the result. Repeat until
   EVERY planned step has been formulated AND solved.
4. If a formulate or solve call returns a validation error, fix the specific field it names and retry that
   one call once with corrected, complete parameters for the step's family. Use optihashi_edit_problem only
   to adjust the CURRENT active brief when a solver result is poor or infeasible, then re-run solvers.

This is an AUTONOMOUS run -- see it through in ONE turn:
- NEVER ask the user for permission to continue, and NEVER end a turn with a question like "Ready to proceed
  to step 2?" or "Say the word and I'll continue." Just proceed to the next step yourself.
- Call optihashi_decompose AT MOST ONCE. Once the plan exists, NEVER decompose again -- you already have the
  ordered plan and step 1 is loaded; re-decomposing restarts the walk and resets your progress. Advance the
  plan you have; do not re-plan.
- Work ONE step at a time: formulate the NEXT step, solve it, read its result, then move on. Do not formulate
  several steps up front -- keep the plan and the console in lock-step.
- Do not stop after step 1. Keep going -- formulate and solve every planned step -- before the final answer.
- Only stop when every planned step has been solved (or a step is genuinely infeasible even after one retry
  -- then say so briefly and move to the next step; do not halt the whole run).

Discipline:
- Be conservative about compute tier: most scenarios are well served by classical/durable solvers; say so
  plainly. Never claim one approach "beats" another or assert any performance advantage you did not measure.
- When you finish, give a final answer that summarizes the walk and the result you read from each solve.
- Narrate as you go: before each tool call, write ONE short sentence saying what you're about to do and
  why (e.g. "Solving the staffing schedule now to see if resequencing beats the naive order."). This
  streams to the user live, so it keeps a multi-step run feeling responsive. Keep it to one sentence -
  the tool call does the real work.`;

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
    // Disable the confidence gate for the autonomous optimizer loop. The opti tools are
    // sandboxed (LLM/solver + undoable /opti side-effect, no external mutation) and the
    // whole point is an unattended decompose -> solve -> advance walk; a single recoverable
    // formulation error dropping one iteration's confidence must not pause the run for a
    // human mid-demo. maxIterations (30) stays the runaway backstop.
    confidenceGateThreshold: 0,
  };
}
