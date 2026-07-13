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
 * first-iteration query. It mirrors the guards used by
 * `publishMementoCompletion`:
 *
 * - the user is on NEITHER pipeline. V2 (if the user opted in) is tried first and is mutually
 *   exclusive with V1; V1 additionally requires `enableMementos` (user/admin).
 * - `parentExecutionId` set -> no retrieval. Subagent / DAG-child executions
 *   inherit the parent's materialized context via the existing handoff path
 *   and must not re-fetch (parity with the publish side).
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
import { MEMENTO_MIN_SIMILARITY } from '@bike4mind/common';
import { recallMementosV2 } from '@server/memory/recallMementosV2';
import type { IApiKeyRepository, IMementoRepository, IAdminSettingsRepository } from '@bike4mind/common';
import { mementoService } from '@bike4mind/services';

export type MementoRetrievalExecution = Pick<
  IAgentExecution,
  'id' | 'userId' | 'query' | 'enableMementos' | 'parentExecutionId'
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

export interface MementosPreambleResult {
  preamble: string;
  mementoIds: string[];
}

const EMPTY_RESULT: MementosPreambleResult = Object.freeze({ preamble: '', mementoIds: [] as string[] });

/** One preamble shape for both pipelines, so a user's memory reads identically whichever one served it. */
const buildPreamble = (lines: string[]): string =>
  `\n\n[KNOWN FACTS ABOUT THE USER — Use these to personalize your response when relevant. ` +
  `Do not mention this list explicitly unless asked.]\n${lines.join('\n')}`;

export async function getFirstIterationMementosPreamble(
  execution: MementoRetrievalExecution,
  adapters: MementoRetrievalAdapters,
  logger: Logger
): Promise<MementosPreambleResult> {
  if (execution.parentExecutionId) return EMPTY_RESULT;

  try {
    // Mementos V2: the two pipelines are mutually exclusive, exactly as in chat (MementoFeature). A V2
    // user's memory must reach agent mode too - gating this on `enableMementos` alone is what left a
    // V2-only user running un-personalized in agent mode while chat knew them perfectly well.
    //
    // V2 returns null for a user who is NOT on V2, which is what falls through to the V1 path below.
    const v2 = await recallMementosV2(execution.userId, execution.query);
    if (v2 !== null) {
      if (v2.length === 0) {
        logger.info('[Mementos V2] No relevant beliefs for first iteration', { executionId: execution.id });
        return EMPTY_RESULT;
      }
      const lines = v2.map(
        ({ fact, relevance }) => `  - [${Math.round(relevance * 100)}% relevant] ${sanitizeSummary(fact)}`
      );
      logger.info('[Mementos V2] Injected beliefs into first-iteration context', {
        executionId: execution.id,
        count: v2.length,
      });
      // V2 beliefs are not V1 mementos and have no memento id to track; `mementoIds` stays empty.
      return { preamble: buildPreamble(lines), mementoIds: [] };
    }

    if (!execution.enableMementos) return EMPTY_RESULT;

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

    return { preamble: buildPreamble(lines), mementoIds };
  } catch (err) {
    logger.warn('[Mementos] Failed to retrieve mementos for first iteration — proceeding without preamble', {
      executionId: execution.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return EMPTY_RESULT;
  }
}
