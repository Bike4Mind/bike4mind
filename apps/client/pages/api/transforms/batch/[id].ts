import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@server/utils/config';
import { transformBatchRepository, usageEventRepository } from '@bike4mind/database';
import { NotFoundError, usdToCreditsStochastic } from '@bike4mind/utils';
import { getTextModelCost } from '@bike4mind/common';
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
  // poll idempotent + cheap if it retries.
  if (batch.status === 'completed' && batch.results?.length) {
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

  // Completed but no results stored: the write failed or the claiming poll has not reached it.
  // Settlement belongs to the claim winner alone, so never settle here.
  if (batch.status === 'completed') {
    await saveResults();
    return res.json({ batch_id: anthropicBatchId, status: 'completed', counts: status.counts, results });
  }

  // Fetched before the claim: once the claim lands, a throw here could never be retried.
  const catalog = batch.creditHold ? await getAvailableModels({ anthropic: apiKey }) : [];
  // Only the poll that wins the in_progress -> completed transition sees the hold, so a retried or
  // concurrent poll never settles twice. The hold stays on the row until markCreditSettled, so a
  // crash before then leaves a record of the unsettled hold.
  const claimed = await transformBatchRepository.claimCompletion(batch.id, {
    succeededCount: status.counts.succeeded,
    erroredCount: status.counts.errored + status.counts.canceled + status.counts.expired,
  });
  if (claimed?.creditHold) {
    // Failed items are free. Standard rate, as reserved at submit (no Batches discount in pricing).
    const modelByCustomId = new Map(claimed.customIdMap.map(m => [m.customId, m.model]));
    let usd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    const models = new Set<string>();
    for (const r of status.results ?? []) {
      const modelInfo = catalog.find(m => m.id === modelByCustomId.get(r.customId));
      if (r.status === 'done' && r.tokenUsage && !modelInfo) {
        req.logger.error(
          `[transforms/batch] Unbilled item in batch ${anthropicBatchId}: model ${modelByCustomId.get(r.customId)} missing from catalog`
        );
      }
      if (r.status !== 'done' || !r.tokenUsage || !modelInfo) continue;
      const u = r.tokenUsage;
      usd += getTextModelCost(
        modelInfo,
        u.inputTokens,
        u.outputTokens,
        u.cacheReadInputTokens ?? 0,
        u.cacheCreationInputTokens ?? 0
      );
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
      },
      { featureLabel: 'batch transforms', logger: req.logger }
    );
    await transformBatchRepository.markCreditSettled(batch.id);
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
  if (claimed) await saveResults();

  return res.json({
    batch_id: anthropicBatchId,
    status: 'completed',
    counts: status.counts,
    results,
  });
});

export default handler;
