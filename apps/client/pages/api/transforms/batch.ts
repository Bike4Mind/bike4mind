import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@server/utils/config';
import { transformBatchRepository } from '@bike4mind/database';
import { AnthropicBatchService, type BatchTransformRequest } from '@bike4mind/llm-adapters';
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

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
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

  const service = AnthropicBatchService.fromApiKey(apiKey, req.logger);

  const requests: BatchTransformRequest[] = body.requests.map(r => ({
    clientRef: r.client_ref,
    model: r.model,
    maxTokens: r.max_tokens,
    system: r.system,
    messages: r.messages as MessageParam[],
  }));

  const { anthropicBatchId, customIdMap } = await service.submitBatch(requests);

  await transformBatchRepository.create({
    ownerUserId: req.user.id,
    anthropicBatchId,
    status: 'in_progress',
    requestCount: requests.length,
    succeededCount: 0,
    erroredCount: 0,
    customIdMap,
  });

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
