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
 * Core generics offered to the optimizer agent alongside the premium optimizer tools (verified
 * registered in `b4m-core/services/src/llm/tools/index.ts`). Kept deliberately small so the loop
 * stays on the model->formulate->solve->advance task.
 *
 * `retrieve_knowledge_content` is load-bearing rather than a convenience: the agent path injects
 * attached files as METADATA ONLY and points the agent at this tool to read them
 * (`agentExecutor.firstIterationQuery.ts`). Without it, a user who attaches a file to an
 * optimizer chat gets "I can't access the attached file" even though the file ingested fine.
 * `search_knowledge_base` is deliberately NOT here - reading an explicitly attached file keeps
 * the loop on task, whereas open-ended lake search invites it off task, and that search is
 * still available on the chat path.
 */
export const OPTI_CORE_AGENT_TOOLS: readonly string[] = [
  'retrieve_knowledge_content',
  'web_search',
  'current_datetime',
];

/**
 * The optimizer agent's toolbelt: every premium tool the host has registered, plus the core
 * generics above (deduped, so an overlay name colliding with a generic is offered once).
 *
 * The premium names are DERIVED from the caller's tool map rather than restated here. That map is
 * generated from whichever overlay packages are hydrated at install/dev-server time
 * (`apps/client/scripts/generate-premium-glue.mjs` -> `premiumLlmTools.generated.ts`, gitignored),
 * so a list written out here drifts silently: a newly registered tool is resolvable on the chat
 * path but invisible to this profile until someone edits the list by hand, and nothing fails loudly
 * when that happens - the agent simply never sees the tool and answers in prose instead.
 *
 * Assumption, true of every premium tool registered today: a premium tool belongs on the optimizer
 * surface. `ToolDefinition` carries no surface tag, so if a non-optimizer overlay ever contributes
 * one, the fix is to tag the definition rather than to reintroduce a name list here.
 *
 * `OPTI_DENIED_TOOLS` is still subtracted downstream, so a derived name remains deniable.
 */
export function resolveOptiAgentTools(premiumToolNames: readonly string[]): string[] {
  return [...new Set([...premiumToolNames, ...OPTI_CORE_AGENT_TOOLS])];
}

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
 * Build the opti orchestration profile.
 *
 * `premiumToolNames` is required rather than defaulted: this file stays a pure builder (no Mongo,
 * AWS or overlay engine imports), so it cannot read the generated premium map itself and the caller
 * passes `Object.keys(premiumLlmTools)`. Requiring it turns a caller that forgets into a compile
 * error rather than an agent silently missing its optimizer tools.
 *
 * `systemPrompt` defaults to the built-in loop prompt but accepts an override (e.g. an admin-tuned
 * prompt) resolved by the caller.
 */
export function buildOptiOrchestrationProfile({
  premiumToolNames,
  systemPrompt = OPTI_AGENT_LOOP_PROMPT,
}: {
  premiumToolNames: readonly string[];
  systemPrompt?: string;
}): ResolvedOrchestrationProfile {
  return {
    id: 'synthetic:opti-orchestration',
    name: 'Optimizer',
    allowedTools: resolveOptiAgentTools(premiumToolNames),
    deniedTools: OPTI_DENIED_TOOLS,
    maxIterations: { ...OPTI_MAX_ITERATIONS },
    defaultThoroughness: 'very_thorough',
    isSynthetic: true,
    // The walk needs its whole toolbelt: decompose plans it, formulate/solve advance it, and a
    // caller's per-run tool selection narrowing that set strands the loop midway. Observed in
    // production - a classifier-routed send carried a payload naming a single optimizer tool, so
    // the agent had no way to decompose the scenario it had just been asked to break down.
    toolsetIsExclusive: true,
    systemPrompt,
    // Disable the confidence gate for the autonomous optimizer loop. The opti tools are
    // sandboxed (LLM/solver + undoable /opti side-effect, no external mutation) and the
    // whole point is an unattended decompose -> solve -> advance walk; a single recoverable
    // formulation error dropping one iteration's confidence must not pause the run for a
    // human mid-demo. maxIterations (30) stays the runaway backstop.
    confidenceGateThreshold: 0,
  };
}
