import {
  getEmbeddingModelCapabilities,
  listEmbeddingModelsContract,
  type ListEmbeddingModelsResponse,
} from '@bike4mind/common';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { getEmbeddingProviderRegistry } from '@bike4mind/services/llm/embeddingProviders';
import { getSettingsByNames } from '@bike4mind/utils';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';

const handler = nextRouteForContract(listEmbeddingModelsContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/embedding-models'),
}).get(async (req, res) => {
  const keys = await apiKeyService.getEffectiveLLMApiKeys(
    req.user.id,
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
    { logger: req.logger }
  );
  const registry = getEmbeddingProviderRegistry(keys);
  const body: ListEmbeddingModelsResponse = {
    models: registry
      .ids()
      .flatMap(provider => registry.get(provider)?.models ?? [])
      .map(id => {
        const capabilities = getEmbeddingModelCapabilities(id);
        const dimensions = capabilities.dimensions;
        return {
          id,
          object: 'embedding_model',
          display_name: capabilities.displayName,
          provider: capabilities.provider,
          dimensions: dimensions.kind === 'discrete' ? { ...dimensions, values: [...dimensions.values] } : dimensions,
          max_input_tokens: capabilities.maxInputTokens,
          supports_input_type: capabilities.inputType,
          pricing: capabilities.pricing
            ? { usd_per_million_input_tokens: capabilities.pricing.usdPerMillionTokens }
            : null,
        };
      }),
  };
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(body);
});

export default handler;
export const config = { api: { externalResolver: true } };
