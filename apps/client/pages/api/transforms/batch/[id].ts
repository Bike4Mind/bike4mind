import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@bike4mind/server-utils/utils/config';
import { transformBatchRepository, usageEventRepository } from '@bike4mind/database';
import { NotFoundError, usdToCreditsStochastic } from '@bike4mind/utils';
import type { ModelInfo } from '@bike4mind/common';
import { isUnpricedTextModel } from '@bike4mind/services/llm/modelAdmission';
import { anthropicBatchCost } from '@server/billing/anthropicBatchPricing';
import { AnthropicBatchService, getAvailableModels } from '@bike4mind/llm-adapters';
import { settleHeldCredits } from '@server/billing/reserveRequestCredits';

/**
 * GET /api/transforms/batch/:id - poll a submitted batch (id = Anthropic batch id).
 *
 * While Anthropic reports `in_progress`, returns counts only. Once `ended`,
 * streams the per-request results and maps each back to the caller's
 * `client_ref`. Partial failures are surfaced per item (status: "failed")
 * so the caller can recycle just those. Polling, no webhook (v1).
 */

const handler = baseApi().get(async (req, res) => {
  const anthropicBatchId = String(req.query.id ?? '');
  if (!anthropicBatchId) {
    throw new NotFoundError('Batch not found');
  }

  const batch = await transformBatchRepository.findByAnthropicBatchId(anthropicBatchId);
  // Don't leak existence of batches owned by other API keys.
  if (!batch || batch.ownerUserId !== req.user.id) {
    throw new NotFoundError('Batch not found');
  }

  // Short-circuit: once completed, results are cached on the row - return them
  // without re-streaming the (potentially large) JSONL from Anthropic on every
  // poll. The consumer typically polls completed once, but this also makes the
  // poll idempotent + cheap if it retries. An empty array is a stored zero-result batch; only an
  // absent field means the results were never written.
  // Durable pending holds can safely retry settlement after a poll dies: their receipt prevents
  // duplicate charges. Legacy holds have no such receipt and remain first-claim-only.
  const canRetrySettlement = Boolean(batch.creditHold?.pendingHoldId);
  if (batch.status === 'completed' && Array.isArray(batch.results) && !canRetrySettlement) {
    return res.json({
      batch_id: anthropicBatchId,
      status: 'completed',
      counts: { succeeded: batch.succeededCount, errored: batch.erroredCount },
      results: batch.results,
    });
  }

  const apiKey = Config.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'not-configured') {
    return res.status(503).json({ error: 'Anthropic API key not configured', request_id: req.requestId });
  }

  const service = AnthropicBatchService.fromApiKey(apiKey, req.logger);
  const status = await service.getBatchResults(anthropicBatchId, batch.customIdMap);

  if (status.processingStatus !== 'ended') {
    return res.json({ batch_id: anthropicBatchId, status: 'in_progress', counts: status.counts });
  }

  // First time we've seen it end - map, cache on the row, and return.
  const results = (status.results ?? []).map(r => ({
    client_ref: r.clientRef,
    status: r.status,
    reply: r.reply,
    tokenUsage: r.tokenUsage
      ? {
          actualInputTokens: r.tokenUsage.inputTokens,
          actualOutputTokens: r.tokenUsage.outputTokens,
          cacheReadInputTokens: r.tokenUsage.cacheReadInputTokens,
          cacheCreationInputTokens: r.tokenUsage.cacheCreationInputTokens,
          cacheWrite5mInputTokens: r.tokenUsage.cacheWrite5mInputTokens,
          cacheWrite1hInputTokens: r.tokenUsage.cacheWrite1hInputTokens,
        }
      : undefined,
    error: r.error,
  }));

  // Best-effort: results over Mongo's 16MB document cap must not fail the poll; a completed row
  // without stored results re-streams them from Anthropic on the next poll.
  const saveResults = () =>
    transformBatchRepository.saveResults(batch.id, results).catch(error => {
      req.logger.error(`[transforms/batch] Failed to persist results for batch ${anthropicBatchId}`, error);
    });

  // Legacy holds cannot safely retry, but modern pending holds settle idempotently below.
  if (batch.status === 'completed' && !canRetrySettlement) {
    await saveResults();
    return res.json({ batch_id: anthropicBatchId, status: 'completed', counts: status.counts, results });
  }

  const succeededResults = (status.results ?? []).filter(result => result.status === 'done');
  if (batch.creditHold && succeededResults.length !== status.counts.succeeded) {
    throw new Error(`[transforms/batch] Incomplete succeeded results for batch ${anthropicBatchId}`);
  }

  // Load prices before claiming completion so a catalog outage leaves new work unclaimed.
  const mappings = new Map(batch.customIdMap.map(mapping => [mapping.customId, mapping]));
  const needsCatalog =
    Boolean(batch.creditHold) &&
    succeededResults.some(result => !batch.billingModels?.[mappings.get(result.customId)?.model ?? '']);
  const catalog = needsCatalog ? await getAvailableModels({ anthropic: apiKey }) : [];
  const billedModels = new Map<string, ModelInfo>();
  if (batch.creditHold) {
    for (const result of succeededResults) {
      const modelId = mappings.get(result.customId)?.model;
      const modelInfo = batch.billingModels?.[modelId ?? ''] ?? catalog.find(model => model.id === modelId);
      if (!result.tokenUsage || !modelInfo || isUnpricedTextModel({ ...modelInfo, type: 'text' })) {
        throw new Error(
          `[transforms/batch] Cannot price succeeded item ${result.customId} in batch ${anthropicBatchId}`
        );
      }
      billedModels.set(result.customId, modelInfo);
    }
  }
  // The first poll claims completion; later polls resume any durable unsettled hold. Concurrent
  // retries are safe because settlement's pending-hold transaction moves the balance only once.
  const claimed =
    batch.status === 'completed'
      ? batch
      : await transformBatchRepository.claimCompletion(batch.id, {
          succeededCount: status.counts.succeeded,
          erroredCount: status.counts.errored + status.counts.canceled + status.counts.expired,
        });
  if (claimed?.creditHold) {
    // Failed items are free. Each successful item uses the same batch/cache rates as its hold.
    let usd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    const models = new Set<string>();
    for (const r of status.results ?? []) {
      const modelInfo = billedModels.get(r.customId);
      if (r.status !== 'done' || !r.tokenUsage || !modelInfo) continue;
      const u = r.tokenUsage;
      usd += anthropicBatchCost(modelInfo, u);
      inputTokens += u.inputTokens;
      outputTokens += u.outputTokens;
      cacheReadTokens += u.cacheReadInputTokens ?? 0;
      cacheWriteTokens += u.cacheCreationInputTokens ?? 0;
      models.add(modelInfo.id);
    }
    const model = [...models].join(',') || 'unknown';
    const creditsCharged = await settleHeldCredits(
      claimed.creditHold,
      usdToCreditsStochastic(usd),
      {
        type: 'completion_api_usage',
        sessionId: anthropicBatchId,
        model,
        apiKeyId: claimed.apiKeyId,
        source: claimed.usageSource,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      },
      { featureLabel: 'batch transforms', logger: req.logger, throwOnUnconfirmed: true }
    );
    // Stamped even when the sweep already refunded the hold (charged 0): either way it is resolved.
    // Only the caller that clears the durable hold emits analytics; a concurrent receipt replay
    // must not count the same batch twice.
    const stamped = await transformBatchRepository.markCreditSettled(batch.id);
    if (stamped !== false) {
      await usageEventRepository
        .record({
          requestId: anthropicBatchId,
          userId: claimed.ownerUserId,
          ownerId: claimed.creditHold.ownerId,
          ownerType: claimed.creditHold.ownerType,
          feature: 'completion_api',
          provider: 'anthropic',
          model,
          inputTokens,
          outputTokens,
          cachedInputTokens: cacheReadTokens,
          cacheWriteTokens,
          settledBasis: 'local',
          costUsd: usd,
          creditsCharged,
          status: 'ok',
          source: claimed.usageSource,
          apiKeyId: claimed.apiKeyId,
        })
        .catch(err => req.logger.warn('[transforms/batch] usage event failed', err));
    }
  }
  if (claimed) await saveResults();

  return res.json({
    batch_id: anthropicBatchId,
    status: 'completed',
    counts: status.counts,
    results,
  });
});

export default handler;
