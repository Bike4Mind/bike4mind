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
  getEmbeddingModelCapabilities,
  getEmbeddingModelCost,
  hasPublishedEmbeddingRate,
  MAX_EMBEDDING_REQUEST_TOKENS,
  MAX_EMBEDDING_RESPONSE_VALUES,
  planEmbeddingDimensions,
  usdToCredits,
  usdToCreditsStochastic,
  type EmbeddingsResponse,
} from '@bike4mind/common';
import { adminSettingsRepository, apiKeyRepository, usageEventRepository } from '@bike4mind/database';
import { isEmbeddingAuthError } from '@bike4mind/fab-pipeline';
import { Logger } from '@bike4mind/observability';
import { apiKeyService } from '@bike4mind/services';
import { embeddingBackendForModel, resolveEmbeddingProvider } from '@bike4mind/services/llm/embeddingProviders';
import {
  createTokenizer,
  getSettingsByNames,
  getSettingsMap,
  getSettingsValue,
  type ITokenizer,
} from '@bike4mind/utils';
import { reserveRequestCredits } from '@server/billing/reserveRequestCredits';
import { encodeEmbeddingBase64 } from '@server/embeddings/embedTexts';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { resolveRequestUsageSource } from '@server/utils/resolveRequestUsageSource';

// Cached per container, so it gets a neutral logger: a request's logger would pin that request's context.
let sharedTokenizer: ITokenizer | undefined;
const APPROXIMATE_TOKEN_RESERVATION_MARGIN = 1.25;

// baseApi enforces its own 1 MB Content-Length cap ahead of Next's parser, so the 4 MB bodyParser limit below needs
// this to take effect.
const handler = nextRouteForContract(createEmbeddingsContract, { maxBodySize: 4 * 1024 * 1024 }).post(
  async (req, res) => {
    const { model, input, dimensions, encoding_format, input_type } = req.validated;
    // A model with no rate would price at $0 and skip the credit gate while the platform key pays the
    // provider (same hole semantic-search closes). Ollama's explicit 0 rates still pass.
    if (!hasPublishedEmbeddingRate(model)) {
      return res
        .status(422)
        .json({ error: `${model} has no published credit rate and cannot be billed on this endpoint.` });
    }
    const texts = Array.isArray(input) ? input : [input];
    const userId = req.user.id;
    const provider = getEmbeddingModelCapabilities(model).provider;

    const llmKeys = await apiKeyService.getEffectiveLLMApiKeys(
      userId,
      { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
      { logger: req.logger }
    );
    // Strict resolution, never the keyless fallback: the caller named a model, and substituting
    // another one would hand back vectors from a different space under the requested name.
    const resolution = resolveEmbeddingProvider(model, llmKeys);
    if (resolution.missing || !resolution.provider) {
      return res.status(503).json({
        error: `Embedding provider ${provider} is not configured for model ${model}.`,
        errorCode: 'provider_not_configured',
      });
    }

    const { dimensions: modelDimensions, maxInputTokens } = getEmbeddingModelCapabilities(model);
    const plan = planEmbeddingDimensions(model, dimensions);
    if (plan.kind === 'unsupported') {
      return res.status(422).json({ error: plan.message });
    }
    const outputWidth =
      plan.kind === 'truncate'
        ? plan.dimensions
        : plan.kind === 'provider'
          ? plan.outputDimension
          : modelDimensions.native;
    const maxInputs = Math.floor(MAX_EMBEDDING_RESPONSE_VALUES / outputWidth);
    if (texts.length > maxInputs) {
      return res.status(422).json({
        error: `At ${outputWidth} dimensions a request may carry at most ${maxInputs} inputs; split the input into smaller requests.`,
      });
    }

    sharedTokenizer ??= createTokenizer({ logger: new Logger({ metadata: { component: 'tokenizer' } }) });
    const tokenizer = sharedTokenizer;
    const tokenCounts = await Promise.all(texts.map(text => tokenizer.countTokens(text, model)));
    const oversizedIndex = tokenCounts.findIndex(count => count > maxInputTokens);
    if (oversizedIndex !== -1) {
      return res.status(422).json({
        error: `input[${oversizedIndex}] is ${tokenCounts[oversizedIndex]} tokens; ${model} accepts at most ${maxInputTokens}.`,
      });
    }
    const promptTokens = tokenCounts.reduce((sum, count) => sum + count, 0);
    if (promptTokens > MAX_EMBEDDING_REQUEST_TOKENS) {
      return res.status(422).json({
        error: `Request is ${promptTokens} tokens; the limit is ${MAX_EMBEDDING_REQUEST_TOKENS} per request.`,
      });
    }

    const settings = await getSettingsMap(
      { adminSettings: adminSettingsRepository },
      { names: ['enforceCredits'], skipCache: true }
    );
    // Only OpenAI models are counted with their own tokenizer; every other model falls back to cl100k_base,
    // and settlement trusts the provider's count, which the hold caps (see tokenCounting.ts).
    const approximateTokenizer = provider !== 'openai';
    const reservationTokens = approximateTokenizer
      ? Math.ceil(promptTokens * APPROXIMATE_TOKEN_RESERVATION_MARGIN)
      : promptTokens;
    const reservationCostUsd = getEmbeddingModelCost(model, reservationTokens);
    // Gate on USD, not usdToCredits' one-credit floor: a free embedder (Ollama) reserves nothing.
    // An unpriced model never gets here (rejected above), so cost 0 always means a genuine 0 rate.
    const reservation = await reserveRequestCredits({
      req,
      requiredCredits: reservationCostUsd > 0 ? usdToCredits(reservationCostUsd) : 0,
      enforceCredits: getSettingsValue('enforceCredits', settings),
      featureLabel: 'embeddings',
    });

    const requestId = `embeddings-${userId}-${Date.now()}`;
    const source = resolveRequestUsageSource(req);
    const startedAt = Date.now();
    let billedTokens = promptTokens;
    let settledBasis: 'local' | 'provider' = 'local';
    const recordUsage = (status: 'ok' | 'error', creditsCharged: number, costUsdValue: number) =>
      usageEventRepository
        .record({
          requestId,
          userId,
          ownerId: reservation.ownerId,
          ownerType: reservation.ownerType,
          sessionId: requestId,
          feature: 'embedding',
          provider: embeddingBackendForModel(model),
          model,
          source,
          inputTokens: billedTokens,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          settledBasis,
          costUsd: costUsdValue,
          creditsCharged,
          latencyMs: Date.now() - startedAt,
          status,
        })
        .catch(err => req.logger.warn('Failed to record embeddings usage event', { err }));

    let vectors: number[][];
    try {
      const result = await resolution.provider.embed({ model, inputs: texts, dimensions, inputType: input_type });
      vectors = result.vectors;
      if (result.inputTokens !== undefined) {
        billedTokens = result.inputTokens;
        settledBasis = 'provider';
      }
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

    const costUsd = getEmbeddingModelCost(model, billedTokens);
    const creditsCharged = await reservation.settle(usdToCreditsStochastic(costUsd), {
      type: 'text_generation_usage',
      sessionId: requestId,
      questId: requestId,
      model,
      inputTokens: billedTokens,
      outputTokens: 0,
      source,
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
      usage: { prompt_tokens: billedTokens, total_tokens: billedTokens },
    };
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(body);
  }
);

export default handler;

export const config = {
  api: {
    externalResolver: true,
    // MAX_EMBEDDING_REQUEST_TOKENS of text is ~1.2 MB, past Next's 1 MB default body limit.
    bodyParser: { sizeLimit: '4mb' },
  },
};
