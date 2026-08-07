/**
 * Memento retrieval helper for agent_executor (read-side parity).
 *
 * The chat-completion flow injects relevant mementos into the prompt via
 * `MementoFeature.getContextMessages` (`b4m-core/services/src/llm/
 * ChatCompletionFeatures.ts`). Before this helper, agent-mode runs never saw
 * the user's prior mementos - so a fact stored in agent mode ("User enjoys
 * chess on Saturdays") was invisible to the next agent run, even though the
 * write side was already populating it.
 *
 * This helper produces a preamble string the caller appends to the
 * first-iteration query. The caller resolves the memory policy once, via
 * `resolveExecutionMementoGates`, and hands us the concrete `MementoGates` - the SAME resolver the
 * write side (`publishMementoCompletion`) uses, so a per-request opt-out reads the same on both
 * sides (#1337). It mirrors those guards:
 *
 * - neither gate is live -> no retrieval. V2 (`gates.v2`) is tried first and is mutually exclusive
 *   with V1 at inject time; V1 (`gates.v1`) already folds in the admin setting and the request flag.
 *   An explicit `enableMementos: false` resolves both gates off, so nothing is read.
 * - `parentExecutionId` OR `spawnedByExecutionId` set -> no retrieval. Subagent / DAG-child
 *   executions inherit the parent's materialized context via the existing handoff path and must not
 *   re-fetch (parity with the publish side). Both fields must be checked: a BACKGROUND subagent is
 *   created with `parentExecutionId` deliberately unset and `spawnedByExecutionId` set instead
 *   (`agentExecutor.ts` child creation - it bills and counts independently), and `baseFields` never
 *   copies the parent's `enableMementos`, so a child checked on `parentExecutionId` alone arrives
 *   with `enableMementos: undefined` and resolves memory back ON despite the parent's opt-out.
 *
 * The caller (`processExecution` in `agentExecutor.ts`) gates on iteration 0
 * of a new execution - same gate as `maybeBuildFirstIterationQuery` - so
 * continuation Lambdas, gate-resumes, and DAG-resumes see the preamble
 * already persisted inside the checkpointed first user message and do NOT
 * re-fetch.
 *
 * Best-effort: a retrieval failure (Mongo blip, embedding API outage, missing
 * embedding model setting) does NOT fail the run - the agent still has the
 * user's query and runs un-personalized. Errors log and return ''.
 */

import type { Logger } from '@bike4mind/observability';
import type { IAgentExecution } from '@bike4mind/database';
import { buildMemoryContext } from '@bike4mind/common';
import { recallMementosV2 } from '@server/memory/recallMementosV2';
import type { IApiKeyRepository, IMementoRepository, IAdminSettingsRepository } from '@bike4mind/common';
import { mementoService, type MementoGates } from '@bike4mind/services';
import { resolveExecutionMementoGates, type MementoGateExecution } from './resolveExecutionMementoGates';

export type MementoRetrievalExecution = Pick<
  IAgentExecution,
  'id' | 'userId' | 'query' | 'parentExecutionId' | 'spawnedByExecutionId'
>;

export interface MementoRetrievalAdapters {
  db: {
    mementos: IMementoRepository;
    apiKeys: Pick<IApiKeyRepository, 'findByUserIdAndTypes' | 'findByUserIdAndType'>;
    adminSettings: IAdminSettingsRepository;
  };
}

/**
 * Strip line-terminator characters from memento summaries before splicing
 * them into the preamble. Mementos are LLM-generated and stored per-user, so
 * cross-user injection isn't a concern, but a newline inside a summary would
 * still break the bullet-list shape the agent reads.
 */
function sanitizeSummary(summary: string): string {
  return summary.replace(/[\r\n\t\v\f\u0085\u2028\u2029]/g, ' ');
}

/**
 * Same `topK` / `minSimilarity` as `MementoFeature.getContextMessages` so
 * agent-mode and chat-mode show the same set of mementos for the same prompt.
 */
const MEMENTO_TOP_K = 10;
const MEMENTO_MIN_SIMILARITY = 0.75;

export interface MementosPreambleResult {
  preamble: string;
  mementoIds: string[];
}

const EMPTY_RESULT: MementosPreambleResult = Object.freeze({ preamble: '', mementoIds: [] as string[] });

/**
 * The V2 preamble - the same friend-who-remembers framing chat mode's V2 path uses (buildMemoryContext).
 * Takes raw facts, not pre-decorated lines: a "% relevant" score is exactly the retrieval-metadata that
 * makes the model recite its memory instead of using it. The V1 path below keeps its own legacy format.
 */
const buildV2Preamble = (facts: string[]): string => {
  const context = buildMemoryContext(facts.map(sanitizeSummary));
  return context ? `\n\n${context}` : '';
};

export async function getFirstIterationMementosPreamble(
  execution: MementoRetrievalExecution,
  gates: MementoGates,
  adapters: MementoRetrievalAdapters,
  logger: Logger
): Promise<MementosPreambleResult> {
  if (execution.parentExecutionId || execution.spawnedByExecutionId) return EMPTY_RESULT;

  try {
    // Mementos V2: the two pipelines are mutually exclusive, exactly as in chat (MementoFeature). A V2
    // user's memory must reach agent mode too, but only when the resolved V2 gate allows it - an
    // explicit per-request opt-out resolves `gates.v2` off, so V2 recall never runs (#1337). We hand
    // recallMementosV2 the already-resolved opt-in so it does not look it up again.
    // V2 and V1 are mutually exclusive at inject time. We hand recallMementosV2 the already-resolved
    // opt-in as `enabled: true`, so it always returns an array here - its only `null` is the
    // `if (!enabled)` short-circuit, which this branch has already ruled out. A V2-gated turn therefore
    // resolves here and never falls through to the V1 path below.
    // MUST STAY IN SYNC with `recallMementosV2`: the `!` below is only sound while `if (!enabled)` is
    // that function's ONLY `return null`. A new null-return there would surface here as a caught
    // TypeError and memory would quietly stop injecting, so add a branch here if one is ever added.
    if (gates.v2) {
      const v2 = (await recallMementosV2(execution.userId, execution.query, { enabled: true }))!;
      if (v2.length === 0) {
        logger.info('[Mementos V2] No relevant beliefs for first iteration', { executionId: execution.id });
        return EMPTY_RESULT;
      }
      logger.info('[Mementos V2] Injected beliefs into first-iteration context', {
        executionId: execution.id,
        count: v2.length,
      });
      // V2 beliefs are not V1 mementos and have no memento id to track; `mementoIds` stays empty.
      return { preamble: buildV2Preamble(v2.map(({ fact }) => fact)), mementoIds: [] };
    }

    if (!gates.v1) return EMPTY_RESULT;

    const relevantMementos = await mementoService.getRelevantMementos(
      execution.userId,
      execution.query,
      {
        topK: MEMENTO_TOP_K,
        minSimilarity: MEMENTO_MIN_SIMILARITY,
        logger,
      },
      { db: adapters.db }
    );

    if (relevantMementos.length === 0) {
      logger.info('[Mementos] No relevant mementos found for first iteration', { executionId: execution.id });
      return EMPTY_RESULT;
    }

    const mementoIds = relevantMementos.map(({ memento }) => String(memento.id));
    const lines = relevantMementos.map(
      ({ memento, similarity }) => `  - [${Math.round(similarity * 100)}% relevant] ${sanitizeSummary(memento.summary)}`
    );

    logger.info('[Mementos] Injected mementos into first-iteration context', {
      executionId: execution.id,
      count: relevantMementos.length,
    });

    const preamble =
      `\n\n[KNOWN FACTS ABOUT THE USER - Use these to personalize your response when relevant. ` +
      `Do not mention this list explicitly unless asked.]\n${lines.join('\n')}`;

    return { preamble, mementoIds };
  } catch (err) {
    logger.warn('[Mementos] Failed to retrieve mementos for first iteration — proceeding without preamble', {
      executionId: execution.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return EMPTY_RESULT;
  }
}

/**
 * Resolve the memory policy and build the preamble, as ONE step - the read-side counterpart to
 * `resolveAndPublishMementoCompletion`. The caller never holds a `MementoGates` value, so it cannot
 * fabricate one; see that function's note for why that matters more than a wiring assertion (#1337).
 */
export async function resolveAndBuildMementosPreamble(
  execution: MementoRetrievalExecution & MementoGateExecution,
  adapters: MementoRetrievalAdapters,
  logger: Logger
): Promise<MementosPreambleResult> {
  const gates = await resolveExecutionMementoGates(execution, adapters, logger);
  return getFirstIterationMementosPreamble(execution, gates, adapters, logger);
}
