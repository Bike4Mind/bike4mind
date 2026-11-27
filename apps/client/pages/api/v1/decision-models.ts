import {
  getDecisionModelCapabilities,
  listDecisionModelsContract,
  type DecisionModel,
  type DecisionModelId,
  type ListDecisionModelsResponse,
} from '@bike4mind/common';
import {
  getDecisionProviderRegistry,
  resolveCallableDecisionProviders,
} from '@bike4mind/server-utils/decisions/providers';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';

const toDecisionModel = (id: DecisionModelId): DecisionModel => {
  const { displayName, provider, aliasOf, limits, pricing } = getDecisionModelCapabilities(id);
  return {
    id,
    object: 'decision_model',
    display_name: displayName,
    provider,
    alias_of: aliasOf ?? null,
    supports_images: limits.maxImages > 0,
    limits: {
      max_questions: limits.maxQuestions,
      max_choices: limits.maxChoices,
      max_levels: limits.maxLevels,
      max_images: limits.maxImages,
      max_input_tokens: limits.maxInputTokens,
    },
    pricing: {
      usd_per_million_input_tokens: pricing.usdPerMillionInputTokens,
      usd_per_million_output_tokens: pricing.usdPerMillionOutputTokens,
    },
  };
};

const handler = nextRouteForContract(listDecisionModelsContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/decision-models'),
}).get(async (req, res) => {
  const entries = getDecisionProviderRegistry()
    .models()
    .map(id => ({ id, provider: getDecisionModelCapabilities(id).provider }));
  const providers = [...new Set(entries.map(entry => entry.provider))];
  // A model whose provider has no usable key for this caller would only answer 503 provider_not_configured.
  const callable = await resolveCallableDecisionProviders(req.user.id, providers, req.logger);
  const body: ListDecisionModelsResponse = {
    models: entries.filter(entry => callable.has(entry.provider)).map(entry => toDecisionModel(entry.id)),
  };
  return res.json(body);
});

export default handler;

export const config = { api: { externalResolver: true } };
