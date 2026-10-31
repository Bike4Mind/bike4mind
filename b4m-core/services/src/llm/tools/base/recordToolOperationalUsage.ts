import { buildUsagePriceStamp, getTextModelCost, getTurnsCost } from '@bike4mind/common';
import type { CompletionInfo } from '@bike4mind/llm-adapters';
import { recordOperationalUsage } from '../../../billing';
import { executedModelFields } from '../../shadowTier';
import type { ToolContext } from './types';
import { resolveToolBillingOrganization } from './resolveToolBillingOrganization';

export type RecordToolOperationalUsageArgs = {
  /** Exact model id passed to the llm.complete call being measured. */
  model: string;
  /** Token usage from the llm.complete callback; some backends leave it undefined. */
  completionInfo?: CompletionInfo;
  /** Set just before the llm.complete call so latency reflects the model call, not setup. */
  startTime: number;
  /** Id to record instead of `model` when the tool ran a fixed model on a restricted-tier turn; wins over context.toLedgerModel. */
  ledgerModel?: string;
};

/**
 * Record a UsageEvent for a tool-internal operational llm.complete call (blog draft,
 * deep-research analysis, file edit, notebook generation). Resolves the owner + COGS
 * from the tool context and hands off to the shared recorder.
 *
 * Debits under the operational billing policy only on a host that wires
 * `db.operationalBilling` and does not fold the spend itself via `onToolLlmUsage`; otherwise
 * recorded only. Cost degrades to 0 when the model isn't in the request's catalog, but the
 * event is still written.
 *
 * Best-effort: never throws, so a recording failure can't break the tool it measures.
 */
export async function recordToolOperationalUsage(
  context: ToolContext,
  args: RecordToolOperationalUsageArgs
): Promise<void> {
  const { model, completionInfo, startTime } = args;
  const recordedModel = args.ledgerModel ?? context.toLedgerModel?.(model) ?? model;

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
    const organization = await resolveToolBillingOrganization(context);

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
    const turnUsage = completionInfo?.turnUsage;
    const costUsd = !modelInfo
      ? 0
      : turnUsage?.length
        ? getTurnsCost(modelInfo, turnUsage)
        : getTextModelCost(
            modelInfo,
            inputTokens,
            outputTokens,
            cachedInputTokens,
            cacheWriteTokens,
            inputTokens + cachedInputTokens + cacheWriteTokens
          );

    // Report the spend to a billing host (e.g. the agent executor) so nested tool
    // generation is folded into its ledger rather than billed at zero (#630). Fired
    // before the analytics write so an analytics failure can't drop the charge.
    // A host that sets onToolLlmUsage must not also wire db.usageEvents, or the cost
    // is recorded twice (see agentExecutor's toolDeps.db).
    context.onToolLlmUsage?.({
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens: cachedInputTokens,
      cacheWriteTokens,
      costUsd,
    });

    const recordedProvider = context.availableModels?.find(m => m.id === recordedModel)?.backend ?? 'unknown';
    await recordOperationalUsage(
      {
        requestId: context.sessionId ?? context.userId,
        user: context.user,
        organization,
        sessionId: context.sessionId,
        feature: 'operations',
        provider: recordedProvider,
        model: recordedModel,
        ...executedModelFields(
          { id: recordedModel, backend: recordedProvider },
          { id: model, backend: modelInfo?.backend ?? 'unknown' }
        ),
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheWriteTokens,
        costUsd,
        priceStamp: modelInfo
          ? buildUsagePriceStamp(modelInfo, {
              turns: turnUsage,
              tierBasisTokens: inputTokens + cachedInputTokens + cacheWriteTokens,
            })
          : undefined,
        latencyMs: Date.now() - startTime,
        source: 'system',
        apiKeyId: context.apiKeyId,
        finishReason: completionInfo?.stopReason,
      },
      {
        db: {
          usageEvents: context.db.usageEvents,
          adminSettings: context.db.adminSettings,
          // A host that folds this spend through onToolLlmUsage already charges it.
          ...(context.onToolLlmUsage ? {} : context.db.operationalBilling),
        },
        billingCheck: context.operationalBillingCheck,
        logger: context.logger,
      }
    );
  } catch (err) {
    context.logger.warn('[recordToolOperationalUsage] failed to record operational usage', err);
  }
}
