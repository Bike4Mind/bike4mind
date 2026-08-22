import {
  adminSettingsRepository,
  apiKeyRepository,
  questGraphRepository,
  questNodeRepository,
} from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { getAvailableModels, getLlmByModel, resolveDeprecatedModelId, type ApiKeyTable } from '@bike4mind/llm-adapters';
import { getSettingsByNames } from '@bike4mind/utils';
import { BadRequestError, InternalServerError } from '@bike4mind/common';
import type { IQuestGraphDocument, ModelInfo } from '@bike4mind/common';
import type { CompletionInfo } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import { recordSessionOperationalUsage } from '@server/events/recordSessionOperationalUsage';
import { buildPlanPrompt, extractPlan, planToNodes } from './planShape';

/** A plan is one structured reply; a model that has not produced JSON by now will not. */
const PLAN_TIMEOUT_MS = 120_000;
/** A plan is small. Anything past this is a model that has stopped following the schema. */
const MAX_PLAN_RESPONSE_CHARS = 60_000;
/**
 * How long a planning claim is honoured before another request may steal it.
 * The claim is held across the LLM call, so this has to outlast the timeout;
 * past it the holder is a Lambda that died, and refusing forever would leave the
 * graph permanently unplannable.
 */
const PLAN_CLAIM_STALE_MS = PLAN_TIMEOUT_MS + 60_000;

/**
 * A model that overran its size limit or stalled. Distinguished from a server
 * fault so it surfaces as a 400 the caller can act on ("try a stronger model")
 * rather than a 500 that reads as our bug - the same reasoning the unusable-plan
 * path below already applies.
 */
class PlanModelFailure extends Error {}

/**
 * Turn a graph's goal into a spine of phases and their task nodes.
 *
 * A single structured LLM call, NOT an agent run. Planning needs no tools and no
 * iteration - it is "read a goal, return a shape" - so dispatching it through
 * the executor would buy checkpointing and billing machinery it has no use for
 * while making a fast synchronous operation asynchronous.
 *
 * The model returns structure only. Dependency edges are derived in
 * `planToNodes`, so a plan cannot come back cyclic or dangling - see that file.
 */
export async function generateQuestPlan(args: {
  graph: IQuestGraphDocument;
  userId: string;
  model: string;
  logger: Logger;
}): Promise<{ created: number }> {
  const { graph, logger } = args;

  // Take the planning lock BEFORE reading the graph's nodes. The empty-graph
  // check below is a read-then-write with a minutes-long LLM call in the gap:
  // unlocked, two concurrent requests both see zero nodes, both pass, and both
  // write a full plan into one graph - two interleaved spines that the
  // empty-graph guard then refuses to re-plan, with no node-delete surface to
  // recover through. The lock makes the loser refuse instead.
  const claimed = await questGraphRepository.claimForPlanning(graph.id, PLAN_CLAIM_STALE_MS);
  if (!claimed) {
    throw new BadRequestError('A plan is already being generated for this quest');
  }

  try {
    return await planUnderClaim(args);
  } finally {
    // Released whether the plan landed or threw: a plan that failed must be
    // retryable immediately, not after the stale window.
    await questGraphRepository.releasePlanningClaim(graph.id).catch(err => {
      logger.warn('[questmaster-v5] failed to release the planning claim', {
        graphId: graph.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

/** The plan itself, run with the graph's planning lock held. */
async function planUnderClaim(args: {
  graph: IQuestGraphDocument;
  userId: string;
  model: string;
  logger: Logger;
}): Promise<{ created: number }> {
  const { graph, userId, model, logger } = args;

  // Planning writes a whole structure at once, so it owns an empty graph or
  // nothing. Refusing beats merging a second plan into a graph someone has
  // already started running, or silently discarding their work. Read under the
  // claim, so the answer cannot go stale while the model is thinking.
  const existing = await questNodeRepository.getNodes(graph.id);
  if (existing.length > 0) {
    throw new BadRequestError('This quest already has nodes; planning only works on an empty quest');
  }

  const apiKeyTable = (await apiKeyService.getEffectiveLLMApiKeys(userId, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  })) as ApiKeyTable;

  const resolvedModelId = resolveDeprecatedModelId(model, 'questmaster-v5-plan');
  const models = await getAvailableModels(apiKeyTable);
  const found = models.find((m: ModelInfo) => m.id === resolvedModelId);
  if (!found) throw new BadRequestError(`Model "${model}" is not available`);
  // Re-bound as a definite const: the meter below closes over it, and narrowing
  // from the throw above does not survive into a nested function.
  const modelInfo: ModelInfo = found;

  const llm = getLlmByModel(apiKeyTable, { modelInfo, logger, endUserId: userId });
  if (!llm) throw new InternalServerError(`Could not initialise a model for "${model}"`);
  llm.currentModel = resolvedModelId;

  let reply = '';
  /** Guards the meter against running twice on the failure-then-return path. */
  let metered = false;
  // Captured from the completion callback so the spend can be metered. Some
  // backends never report usage, which the recorder treats as "nothing to
  // attribute" rather than an error.
  let lastCompletionInfo: CompletionInfo | undefined;
  // Held so it can be cleared: an uncleared timer keeps a serverless invocation
  // alive after the completion returns, and bills for the wait.
  let timeoutHandle: NodeJS.Timeout | undefined;
  // Set just before the call so the recorded latency is the model's, not setup's.
  const startTime = Date.now();

  /**
   * Record the completion's spend. Planning is one billable LLM call, and the
   * route's own comment said so while nothing metered it - so this puts it on
   * the same footing as the other operational completions (auto-naming,
   * summarization, tagging), correlated to the graph rather than a session
   * because a graph is what the plan belongs to.
   *
   * Whether it debits credits or is recorded-only is the shared recorder's
   * decision (`billOperationalUsage` + `enforceCredits`), not this call site's.
   */
  async function meterPlanUsage(): Promise<void> {
    if (metered) return;
    metered = true;
    await recordSessionOperationalUsage({
      userId,
      requestId: graph.id,
      sessionId: graph.sessionId,
      modelId: resolvedModelId,
      modelInfo,
      completionInfo: lastCompletionInfo,
      startTime,
      logger,
    });
  }

  try {
    await Promise.race([
      llm.complete(
        resolvedModelId,
        [{ role: 'user' as const, content: buildPlanPrompt(graph.goal) }],
        { temperature: 0.4, stream: false },
        async (texts: (string | null | undefined)[], completionInfo?: CompletionInfo) => {
          if (completionInfo) lastCompletionInfo = completionInfo;
          if (!texts?.length) return;
          reply += texts.filter((t): t is string => typeof t === 'string').join('');
          if (reply.length > MAX_PLAN_RESPONSE_CHARS) {
            throw new PlanModelFailure('The model kept writing past what a plan can be. Try a stronger model.');
          }
        }
      ),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(new PlanModelFailure('The model took too long to return a plan. Try again, or use a faster model.')),
          PLAN_TIMEOUT_MS
        );
      }),
    ]);
  } catch (err) {
    logger.error('[questmaster-v5] plan generation failed', {
      graphId: graph.id,
      error: err instanceof Error ? err.message : String(err),
    });
    // Metered even on failure: an overrun or a stall consumed real tokens, and
    // not recording them is exactly the invisible spend this route was faulted
    // for. Only the model's own misbehaviour is the caller's to retry.
    await meterPlanUsage();
    if (err instanceof PlanModelFailure) throw new BadRequestError(err.message);
    throw new InternalServerError('Could not generate a plan for this quest');
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  await meterPlanUsage();

  const plan = extractPlan(reply);
  if (!plan) {
    // A model that ignored the schema is a bad result, not a server fault - the
    // caller can retry, usually with a more capable model.
    logger.warn('[questmaster-v5] model did not return a usable plan', {
      graphId: graph.id,
      replyLength: reply.length,
    });
    throw new BadRequestError('The model did not return a usable plan. Try again, or use a stronger model.');
  }

  const planned = planToNodes(plan);

  // Sequential: each node's dependencies and parent must already exist, and
  // `planToNodes` guarantees both point strictly backwards in this list.
  //
  // All-or-nothing. A half-written plan would be far worse than none: the
  // empty-graph guard above would then refuse to re-plan it, and there is no
  // node-delete surface, so the quest would be stuck with a partial plan and no
  // way back. On any failure the nodes written so far are removed and the graph
  // returns to empty, which is retryable.
  const createdIds: string[] = [];
  const rootIds: string[] = [];
  try {
    for (const node of planned) {
      const created = await questNodeRepository.addNode({
        graphId: graph.id,
        title: node.title,
        task: node.task,
        acceptanceCriteria: node.acceptanceCriteria,
        kind: node.kind,
        parentId: node.parentIndex === null ? null : createdIds[node.parentIndex],
        dependsOn: node.dependsOnIndices.map(i => createdIds[i]),
        order: createdIds.length,
      });
      createdIds.push(created.id);
      if (node.parentIndex === null) rootIds.push(created.id);
    }
  } catch (err) {
    logger.error('[questmaster-v5] plan write failed - rolling back the partial plan', {
      graphId: graph.id,
      written: createdIds.length,
      error: err instanceof Error ? err.message : String(err),
    });
    for (const id of createdIds) {
      await questNodeRepository.delete(id).catch(() => {});
    }
    throw new InternalServerError('Could not write the plan for this quest');
  }

  // Root ids are registered only once every node landed, so a rolled-back plan
  // leaves no dangling references behind on the graph.
  for (const id of rootIds) await questGraphRepository.addRootNode(graph.id, id);

  logger.info('[questmaster-v5] plan generated', {
    graphId: graph.id,
    phases: plan.phases.length,
    nodes: createdIds.length,
  });

  return { created: createdIds.length };
}
