import {
  getDecisionModelCapabilities,
  listDecisionModelsContract,
  type DecisionModel,
  type DecisionModelId,
  type ListDecisionModelsResponse,
} from '@bike4mind/common';
import { getDecisionProviderRegistry } from '@server/decisions/providers';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { rateLimit } from '@server/middlewares/rateLimit';

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
  rateLimit: rateLimit({ limit: 60, windowMs: 60_000, bucket: 'GET /api/v1/decision-models' }),
}).get(async (_req, res) => {
  const body: ListDecisionModelsResponse = { models: getDecisionProviderRegistry().models().map(toDecisionModel) };
  return res.json(body);
});

export default handler;

export const config = { api: { externalResolver: true } };
