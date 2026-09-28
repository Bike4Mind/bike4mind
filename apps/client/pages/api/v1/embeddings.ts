/**
 * POST /api/v1/embeddings - raw embedding vectors for caller-supplied text.
 *
 * OpenAI-shaped request and success bodies (see schemas/embeddingsApi.ts); B4M error envelope.
 * Billing follows the paid media routes: the local-tokenizer cost is RESERVED before the provider
 * call, refunded if it fails, and settled on success (server/billing/reserveRequestCredits.ts).
 * Settlement rounds the sub-credit cost stochastically, like the operational embedding meter
 * (recordOperationalUsage), so a stream of tiny requests pays its true cost in expectation rather
 * than a one-credit floor each.
 */

import {
  createEmbeddingsContract,
  getEmbeddingModelCost,
  MAX_EMBEDDING_REQUEST_TOKENS,
  MAX_EMBEDDING_RESPONSE_VALUES,
  usdToCredits,
  usdToCreditsStochastic,
  type EmbeddingsResponse,
} from '@bike4mind/common';
import { adminSettingsRepository, apiKeyRepository, usageEventRepository } from '@bike4mind/database';
import {
  EmbeddingFactory,
  getProviderFromModel,
  isEmbeddingAuthError,
  resolveEmbeddingConfig,
} from '@bike4mind/fab-pipeline';
import { apiKeyService } from '@bike4mind/services';
import {
  createTokenizer,
  getSettingsByNames,
  getSettingsMap,
  getSettingsValue,
  type ITokenizer,
} from '@bike4mind/utils';
import { reserveRequestCredits } from '@server/billing/reserveRequestCredits';
import { embedTexts, encodeEmbeddingBase64 } from '@server/embeddings/embedTexts';
import { planEmbeddingDimensions } from '@server/embeddings/planEmbeddingDimensions';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';

let sharedTokenizer: ITokenizer | undefined;

const handler = nextRouteForContract(createEmbeddingsContract).post(async (req, res) => {
  const { model, input, dimensions, encoding_format } = req.validated;
  const texts = Array.isArray(input) ? input : [input];
  const userId = req.user.id;
  const provider = getProviderFromModel(model);

  const llmKeys = await apiKeyService.getEffectiveLLMApiKeys(
    userId,
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
    { logger: req.logger }
  );
  // Strict resolution, never the keyless fallback: the caller named a model, and substituting
  // another one would hand back vectors from a different space under the requested name.
  const resolution = resolveEmbeddingConfig(provider, llmKeys);
  if (resolution.missing) {
    return res.status(503).json({
      error: `No ${resolution.missing} credential is configured for embedding model ${model}.`,
      errorCode: 'provider_not_configured',
    });
  }

  const service = new EmbeddingFactory(resolution.config).createEmbeddingService(model);
  const modelInfo = service.getModelInfo();
  const plan = planEmbeddingDimensions(model, modelInfo, dimensions);
  if (plan.kind === 'unsupported') {
    return res.status(422).json({ error: plan.message });
  }
  const outputWidth =
    plan.kind === 'truncate'
      ? plan.dimensions
      : plan.kind === 'provider'
        ? plan.outputDimension
        : modelInfo.dimensions[0];
  const maxInputs = Math.floor(MAX_EMBEDDING_RESPONSE_VALUES / outputWidth);
  if (texts.length > maxInputs) {
    return res.status(422).json({
      error: `At ${outputWidth} dimensions a request may carry at most ${maxInputs} inputs; split the input into smaller requests.`,
    });
  }

  sharedTokenizer ??= createTokenizer({ logger: req.logger });
  const tokenizer = sharedTokenizer;
  const tokenCounts = await Promise.all(texts.map(text => tokenizer.countTokens(text, model)));
  const oversizedIndex = tokenCounts.findIndex(count => count > modelInfo.contextWindow);
  if (oversizedIndex !== -1) {
    return res.status(422).json({
      error: `input[${oversizedIndex}] is ${tokenCounts[oversizedIndex]} tokens; ${model} accepts at most ${modelInfo.contextWindow}.`,
    });
  }
  const promptTokens = tokenCounts.reduce((sum, count) => sum + count, 0);
  if (promptTokens > MAX_EMBEDDING_REQUEST_TOKENS) {
    return res.status(422).json({
      error: `Request is ${promptTokens} tokens; the limit is ${MAX_EMBEDDING_REQUEST_TOKENS} per request.`,
    });
  }

  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['enforceCredits'] });
  const costUsd = getEmbeddingModelCost(model, promptTokens);
  // Gate on USD, not usdToCredits' one-credit floor: a free embedder (Ollama) reserves nothing.
  const reservation = await reserveRequestCredits({
    req,
    requiredCredits: costUsd > 0 ? usdToCredits(costUsd) : 0,
    enforceCredits: getSettingsValue('enforceCredits', settings),
    featureLabel: 'embeddings',
  });

  const requestId = `embeddings-${userId}-${Date.now()}`;
  const startedAt = Date.now();
  const recordUsage = (status: 'ok' | 'error', creditsCharged: number, costUsdValue: number) =>
    usageEventRepository
      .record({
        requestId,
        userId,
        ownerId: reservation.ownerId,
        ownerType: reservation.ownerType,
        sessionId: requestId,
        feature: 'embedding',
        provider,
        model,
        source: 'api',
        inputTokens: promptTokens,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        settledBasis: 'local',
        costUsd: costUsdValue,
        creditsCharged,
        latencyMs: Date.now() - startedAt,
        status,
      })
      .catch(err => req.logger.warn('Failed to record embeddings usage event', { err }));

  let vectors: number[][];
  try {
    vectors = await embedTexts(service, texts, tokenCounts, plan);
  } catch (error) {
    req.logger.error('Embedding generation failed', {
      model,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    await reservation.refund();
    recordUsage('error', 0, 0);
    if (isEmbeddingAuthError(error)) {
      return res.status(401).json({
        error: `The ${provider} embedding provider rejected the configured credential.`,
        errorCode: 'provider_rejected',
      });
    }
    return res.status(502).json({ error: 'Embedding generation failed' });
  }

  const creditsCharged = await reservation.settle(usdToCreditsStochastic(costUsd), {
    type: 'text_generation_usage',
    sessionId: requestId,
    questId: requestId,
    model,
    inputTokens: promptTokens,
    outputTokens: 0,
    source: 'api',
  });
  recordUsage('ok', creditsCharged, costUsd);

  const body: EmbeddingsResponse = {
    object: 'list',
    data: vectors.map((vector, index) => ({
      object: 'embedding',
      index,
      embedding: encoding_format === 'base64' ? encodeEmbeddingBase64(vector) : vector,
    })),
    model,
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  };
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(body);
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
    // MAX_EMBEDDING_REQUEST_TOKENS of text is ~1.2 MB, past Next's 1 MB default body limit.
    bodyParser: { sizeLimit: '4mb' },
  },
};
