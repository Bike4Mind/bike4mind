import { getTextModelCost } from '@bike4mind/common';
import type { CompletionInfo } from '@bike4mind/llm-adapters';
import { recordOperationalUsage } from '../../../billing';
import type { ToolContext } from './types';

export type RecordToolOperationalUsageArgs = {
  /** Exact model id passed to the llm.complete call being measured. */
  model: string;
  /** Token usage from the llm.complete callback; some backends leave it undefined. */
  completionInfo?: CompletionInfo;
  /** Set just before the llm.complete call so latency reflects the model call, not setup. */
  startTime: number;
};

/**
 * Record a UsageEvent for a tool-internal operational llm.complete call (blog draft,
 * deep-research analysis, file edit, notebook generation). Resolves the owner + COGS
 * from the tool context and hands off to the shared recorder.
 *
 * Recorded-only by design: the narrowed tool db omits the billing repos, so this writes
 * analytics COGS but never debits credits (mirrors search_knowledge_base). Cost degrades
 * to 0 when the model isn't in the request's catalog, but the event is still written.
 *
 * Best-effort: never throws, so a recording failure can't break the tool it measures.
 */
export async function recordToolOperationalUsage(
  context: ToolContext,
  args: RecordToolOperationalUsageArgs
): Promise<void> {
  const { model, completionInfo, startTime } = args;

  const inputTokens = completionInfo?.inputTokens ?? 0;
  const outputTokens = completionInfo?.outputTokens ?? 0;
  const cachedInputTokens = completionInfo?.cacheReadInputTokens ?? 0;
  const cacheWriteTokens = completionInfo?.cacheCreationInputTokens ?? 0;

  // Nothing to attribute or cost when the backend reported no usage. Mirrors
  // recordSessionOperationalUsage: a backend that doesn't thread token counts back
  // leaves completionInfo undefined, and a $0/0-token row would only add noise.
  if (inputTokens === 0 && outputTokens === 0) {
    context.logger.debug(`[recordToolOperationalUsage] no token usage for ${model}; skipping usage record`);
    return;
  }

  try {
    const organization =
      context.user.organizationId && context.db.organizations
        ? await context.db.organizations.findById(context.user.organizationId)
        : null;

    const modelInfo = context.availableModels?.find(m => m.id === model);
    // Cost needs the model's pricing map; if the id isn't in this request's catalog we
    // still record the event (tokens are real) but can't price it. Warn so the resulting
    // COGS gap is visible rather than silently settling $0 - getTextModelCost's own
    // [UNPRICED_MODEL] alarm never fires on this branch because it isn't called.
    if (!modelInfo) {
      context.logger.warn(
        `[recordToolOperationalUsage] model "${model}" not in request catalog; recording usage with costUsd=0`
      );
    }
    const costUsd = modelInfo
      ? getTextModelCost(modelInfo, inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens)
      : 0;

    await recordOperationalUsage(
      {
        requestId: context.sessionId ?? context.userId,
        user: context.user,
        organization,
        sessionId: context.sessionId,
        feature: 'operations',
        provider: modelInfo?.backend ?? 'unknown',
        model,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheWriteTokens,
        costUsd,
        latencyMs: Date.now() - startTime,
        source: 'system',
      },
      { db: { usageEvents: context.db.usageEvents, adminSettings: context.db.adminSettings }, logger: context.logger }
    );
  } catch (err) {
    context.logger.warn('[recordToolOperationalUsage] failed to record operational usage', err);
  }
}
