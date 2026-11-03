import { admitRequestCompletion } from '@server/utils/untrustedCompletionQuota';
import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@bike4mind/server-utils/utils/config';
import { transformBatchRepository } from '@bike4mind/database';
import { AnthropicBatchService, getAvailableModels, type BatchTransformRequest } from '@bike4mind/llm-adapters';
import { BadRequestError, type IMessage, type ModelInfo } from '@bike4mind/common';
import {
  completionCeilingUsd,
  createModelAdmission,
  isCreditsEnforced,
  reserveCompletionCredits,
} from '@server/billing/meterPlatformCompletion';
import { ANTHROPIC_BATCH_RATE, batchHoldModel } from '@server/billing/anthropicBatchPricing';
import { resolveRequestUsageSource } from '@server/utils/resolveRequestUsageSource';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { z } from 'zod';

/**
 * POST /api/transforms/batch - submit a batch of latency-tolerant transforms
 * through Anthropic's Message Batches API (50% off + separate rate-limit pool).
 *
 * Lean async pass-through: the caller (e.g. BedrockNews's bulk ingest stream)
 * sends fully-formed prompts; we submit one Anthropic batch and persist a
 * `TransformBatch` record. Results are fetched lazily on GET .../batch/:id.
 *
 * Auth: standard API-key (`X-API-Key`). One batch submit = one API-key
 * request, so a 200-article batch does not dent the interactive day budget,
 * and Anthropic bills it on the separate (discounted) batch pool.
 */

/**
 * Anthropic caches a byte-identical prefix of the request, so a caller that
 * wants a cache breakpoint has to send `content` as blocks rather than a flat
 * string. Only text blocks are accepted - batches are tool-less, single-shot
 * inference, so images and tool blocks have no path here.
 */
const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  // Anthropic allows at most 4 breakpoints per request and rejects more; we
  // pass through rather than counting, so an over-budget request 400s there.
  cache_control: z.object({ type: z.literal('ephemeral'), ttl: z.enum(['5m', '1h']).optional() }).optional(),
});

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(TextBlockSchema).min(1)]),
});

const BatchSubmitSchema = z.object({
  requests: z
    .array(
      z.object({
        client_ref: z.string().min(1),
        model: z.string().min(1),
        // Ceiling guards against absurd values; comfortably above any current
        // Claude max output.
        max_tokens: z.number().int().positive().max(200000),
        system: z.string().optional(),
        messages: z.array(MessageSchema).min(1),
      })
    )
    .min(1)
    .max(10000),
});

// The hold must outlive every poll that can still bill: Anthropic serves a batch's results for 29 days
// after creation, so a shorter expiry would let a caller who polls late get the batch free.
const BATCH_CREDIT_HOLD_TTL_MS = 29 * 24 * 60 * 60_000;

// 32mb covers a full maxPerBatch payload of large transform prompts. Both the
// Next bodyParser (below) and baseApi's own content-length guard must be raised.
const handler = baseApi({ maxBodySize: 32 * 1024 * 1024 }).post(async (req, res) => {
  const body = BatchSubmitSchema.parse(req.body);
  // The provider queues this work; its lifetime is independent of the HTTP request.
  await admitRequestCompletion(req, { holdSlot: false });

  const apiKey = Config.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'not-configured') {
    return res.status(503).json({ error: 'Anthropic API key not configured', request_id: req.requestId });
  }

  const modelIds = [...new Set(body.requests.map(r => r.model))];
  const catalog = await getAvailableModels({ anthropic: apiKey });
  const admission = await createModelAdmission(req.user, catalog);
  for (const modelId of modelIds) await admission.assert(modelId);
  const modelInfos = new Map<string, ModelInfo>(catalog.filter(m => modelIds.includes(m.id)).map(m => [m.id, m]));
  const unpriced = modelIds.filter(id => !modelInfos.has(id));
  if (unpriced.length > 0 && (await isCreditsEnforced())) {
    throw new BadRequestError(`Unknown model(s): ${unpriced.join(', ')}`);
  }
  const ceilingUsd = body.requests.reduce((sum, r) => {
    const modelInfo = modelInfos.get(r.model);
    const messages = [{ role: 'system', content: r.system ?? '' }, ...r.messages] as IMessage[];
    const cacheWrites = r.messages.some(msg => Array.isArray(msg.content) && msg.content.some(b => b.cache_control));
    const oneHourCache = r.messages.some(
      msg => Array.isArray(msg.content) && msg.content.some(block => block.cache_control?.ttl === '1h')
    );
    return modelInfo
      ? sum +
          completionCeilingUsd(batchHoldModel(modelInfo, oneHourCache), messages, r.max_tokens, cacheWrites) *
            ANTHROPIC_BATCH_RATE
      : sum;
  }, 0);
  const service = AnthropicBatchService.fromApiKey(apiKey, req.logger);

  const requests: BatchTransformRequest[] = body.requests.map(r => ({
    clientRef: r.client_ref,
    model: r.model,
    maxTokens: r.max_tokens,
    system: r.system,
    messages: r.messages as MessageParam[],
  }));

  const reservation = await reserveCompletionCredits(req, ceilingUsd, 'batch transforms', {
    holdTtlMs: BATCH_CREDIT_HOLD_TTL_MS,
  });

  let submitted: Awaited<ReturnType<typeof service.submitBatch>>;
  try {
    submitted = await service.submitBatch(requests);
  } catch (error) {
    await reservation.refund();
    throw error;
  }
  const { anthropicBatchId } = submitted;
  // submitBatch maps requests in order, so customIdMap[i] is requests[i].
  const customIdMap = submitted.customIdMap.map((m, i) => ({ ...m, model: requests[i].model }));

  try {
    await transformBatchRepository.create({
      ownerUserId: req.user.id,
      anthropicBatchId,
      status: 'in_progress',
      requestCount: requests.length,
      succeededCount: 0,
      erroredCount: 0,
      customIdMap,
      billingModels: Object.fromEntries(modelInfos),
      // Settled by the first poll that sees the batch end, through the pending-hold claim; a batch
      // never polled within BATCH_CREDIT_HOLD_TTL_MS is refunded by the expired-hold sweep instead.
      creditHold: reservation.hold,
      apiKeyId: req.apiKeyInfo?.keyId,
      usageSource: req.apiKeyInfo ? resolveRequestUsageSource(req) : undefined,
    });
  } catch (error) {
    req.logger.error(`[transforms/batch] Failed to persist batch ${anthropicBatchId} after submit`, error);
    // Unrecorded, the batch would run on the platform key with nothing to settle it.
    await new Anthropic({ apiKey }).messages.batches
      .cancel(anthropicBatchId)
      .catch(cancelError =>
        req.logger.error(`[transforms/batch] Failed to cancel unrecorded batch ${anthropicBatchId}`, cancelError)
      );
    await reservation.refund();
    throw error;
  }

  req.logger.info(`[transforms/batch] Submitted batch ${anthropicBatchId} (${requests.length} requests)`);

  return res.status(202).json({ batch_id: anthropicBatchId, status: 'in_progress' });
});

// Batch submissions carry many full transform prompts (~25-35KB each), so the
// payload routinely exceeds Next's default 1mb API body limit at realistic
// batch sizes. Anthropic's Batch API allows up to 256MB / 10k requests; cap
// here at 32mb, which comfortably covers maxPerBatch (~200 x ~35KB ≈ 7MB).
export const config = {
  api: {
    bodyParser: { sizeLimit: '32mb' },
  },
};

export default handler;
