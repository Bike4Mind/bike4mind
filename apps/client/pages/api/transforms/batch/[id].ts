import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@server/utils/config';
import { transformBatchRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/utils';
import { AnthropicBatchService } from '@bike4mind/llm-adapters';

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
  if (batch.status === 'completed') {
    return res.json({
      batch_id: anthropicBatchId,
      status: 'completed',
      counts: { succeeded: batch.succeededCount, errored: batch.erroredCount },
      results: batch.results ?? [],
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
      ? { actualInputTokens: r.tokenUsage.inputTokens, actualOutputTokens: r.tokenUsage.outputTokens }
      : undefined,
    error: r.error,
  }));

  await transformBatchRepository.update({
    id: batch.id,
    status: 'completed',
    succeededCount: status.counts.succeeded,
    erroredCount: status.counts.errored + status.counts.canceled + status.counts.expired,
    results,
  });

  return res.json({
    batch_id: anthropicBatchId,
    status: 'completed',
    counts: status.counts,
    results,
  });
});

export default handler;
