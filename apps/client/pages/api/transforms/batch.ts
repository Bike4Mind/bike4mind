import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@server/utils/config';
import { transformBatchRepository } from '@bike4mind/database';
import { AnthropicBatchService, getAvailableModels, type BatchTransformRequest } from '@bike4mind/llm-adapters';
import { BadRequestError, type IMessage, type ModelInfo } from '@bike4mind/common';
import {
  completionCeilingUsd,
  createModelAdmission,
  isCreditsEnforced,
  reserveCompletionCredits,
} from '@server/billing/meterPlatformCompletion';
import { resolveRequestUsageSource } from '@server/utils/resolveRequestUsageSource';
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

// 32mb covers a full maxPerBatch payload of large transform prompts. Both the
// Next bodyParser (below) and baseApi's own content-length guard must be raised.
const handler = baseApi({ maxBodySize: 32 * 1024 * 1024 }).post(async (req, res) => {
  const body = BatchSubmitSchema.parse(req.body);

  const apiKey = Config.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'not-configured') {
    return res.status(503).json({ error: 'Anthropic API key not configured', request_id: req.requestId });
  }

  const modelIds = [...new Set(body.requests.map(r => r.model))];
  // Priced at the standard rate: the pricing layer does not model the Batches 50% discount, so the
  // hold (and the settlement) over-charges rather than under.
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
    return modelInfo ? sum + completionCeilingUsd(modelInfo, messages, r.max_tokens) : sum;
  }, 0);
  const service = AnthropicBatchService.fromApiKey(apiKey, req.logger);

  const requests: BatchTransformRequest[] = body.requests.map(r => ({
    clientRef: r.client_ref,
    model: r.model,
    maxTokens: r.max_tokens,
    system: r.system,
    messages: r.messages as MessageParam[],
  }));

  const reservation = await reserveCompletionCredits(req, ceilingUsd, 'batch transforms');

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
      // ponytail: an ended batch that is never polled keeps its hold forever; add a sweeper like
      // generationJobs/sweep.ts if consumers stop polling to completion.
      creditHold: reservation.hold,
      apiKeyId: req.apiKeyInfo?.keyId,
      usageSource: req.apiKeyInfo ? resolveRequestUsageSource(req) : undefined,
    });
  } catch (error) {
    req.logger.error(`[transforms/batch] Failed to persist batch ${anthropicBatchId} after submit`, error);
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
