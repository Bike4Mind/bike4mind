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
import type { IQuestGraphDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { buildPlanPrompt, extractPlan, planToNodes } from './planShape';

/** A plan is one structured reply; a model that has not produced JSON by now will not. */
const PLAN_TIMEOUT_MS = 120_000;
/** A plan is small. Anything past this is a model that has stopped following the schema. */
const MAX_PLAN_RESPONSE_CHARS = 60_000;

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
  const { graph, userId, model, logger } = args;

  // Planning writes a whole structure at once, so it owns an empty graph or
  // nothing. Refusing beats merging a second plan into a graph someone has
  // already started running, or silently discarding their work.
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
  const modelInfo = models.find((m: { id: string }) => m.id === resolvedModelId);
  if (!modelInfo) throw new BadRequestError(`Model "${model}" is not available`);

  const llm = getLlmByModel(apiKeyTable, { modelInfo, logger, endUserId: userId });
  if (!llm) throw new InternalServerError(`Could not initialise a model for "${model}"`);
  llm.currentModel = resolvedModelId;

  let reply = '';
  try {
    await Promise.race([
      llm.complete(
        resolvedModelId,
        [{ role: 'user' as const, content: buildPlanPrompt(graph.goal) }],
        { temperature: 0.4, stream: false },
        async (texts: (string | null | undefined)[]) => {
          if (!texts?.length) return;
          reply += texts.filter((t): t is string => typeof t === 'string').join('');
          if (reply.length > MAX_PLAN_RESPONSE_CHARS) {
            throw new Error('plan response exceeded its size limit');
          }
        }
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('plan generation timed out')), PLAN_TIMEOUT_MS)),
    ]);
  } catch (err) {
    logger.error('[questmaster-v5] plan generation failed', {
      graphId: graph.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new InternalServerError('Could not generate a plan for this quest');
  }

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
  const createdIds: string[] = [];
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
    if (node.parentIndex === null) await questGraphRepository.addRootNode(graph.id, created.id);
  }

  logger.info('[questmaster-v5] plan generated', {
    graphId: graph.id,
    phases: plan.phases.length,
    nodes: createdIds.length,
  });

  return { created: createdIds.length };
}
