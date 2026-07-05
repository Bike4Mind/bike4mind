import { ModelInfo } from '@bike4mind/common';

interface PricingInfo {
  input: number;
  output: number;
}

interface ExtendedModelInfo extends ModelInfo {
  pricing: Record<number, PricingInfo>;
}

/**
 * Ranks AI models by weighting multiple factors (capability, pricing, family, recency).
 *
 * @param model The model to score
 * @param allModels All available models (needed for normalization)
 * @returns A score between 0-1, higher is better
 */
export const calculateModelScore = (model: ExtendedModelInfo, allModels: ExtendedModelInfo[]): number => {
  // Find maximums for normalization
  const maxContextWindow = Math.max(...allModels.map(m => m.contextWindow));
  const maxTokens = Math.max(...allModels.map(m => m.max_tokens));

  // Base score components (normalized to 0-1 scale)
  const contextScore = model.contextWindow / maxContextWindow;
  const tokensScore = model.max_tokens / maxTokens;

  // Capability scores (binary)
  const toolsScore = model.supportsTools ? 1 : 0;
  const visionScore = model.supportsVision ? 1 : 0;

  // Get pricing info (lower price = higher score)
  let pricingScore = 0;
  if (model.pricing) {
    const firstKey = Number(Object.keys(model.pricing)[0]);
    if (!isNaN(firstKey) && model.pricing[firstKey]) {
      // Get average of input and output pricing
      const avgPrice = (model.pricing[firstKey].input + model.pricing[firstKey].output) / 2;
      // Invert so lower price = higher score (cap at 1.0)
      pricingScore = Math.min(1.0, 1 / (avgPrice * 5000)); // Scaling factor
    }
  }

  // Model family/generation assessment (subjective quality ranking)
  let familyScore = 0.3; // Base score for unrecognized models
  let trainingScore = 0;

  // Special handling for image models
  if (model.type === 'image') {
    if (model.name.includes('dall-e')) {
      familyScore = 0.1; // Put DALLE models at the bottom
    } else if (model.name.includes('flux-pro')) {
      familyScore = 0.9; // Put Flux Pro models at the top
    } else if (model.name.includes('flux')) {
      familyScore = 0.8; // Other Flux models below Pro
    }
    return familyScore;
  }

  // OpenAI models
  if (model.name.includes('o1')) {
    familyScore = 1.0; // OpenAI O1 models
  } else if (model.name.includes('o3')) {
    familyScore = 0.95; // OpenAI O3 models
  } else if (model.name.includes('gpt4o')) {
    familyScore = 0.85; // GPT-4o models
  } else if (model.name.includes('gpt4')) {
    familyScore = 0.8; // GPT-4 models
  } else if (model.name.includes('gpt3.5')) {
    familyScore = 0.5; // GPT-3.5 models
  }

  // Anthropic models - Claude 4.x family
  // model.name is the display name (e.g., "Claude 4.5 Haiku"), so we match on
  // capitalized tier names + "Claude 4" prefix to distinguish from Claude 3.x models.
  else if (
    model.name.includes('Opus') &&
    (model.name.includes('Claude 4') || model.name.includes('Claude 5') || model.name.includes('claude-opus-4'))
  ) {
    familyScore = 1.0; // Claude 4.x/5.x Opus models
  } else if (
    model.name.includes('Sonnet') &&
    (model.name.includes('Claude 4') ||
      model.name.includes('Claude 5') ||
      model.name.includes('claude-sonnet-4') ||
      model.name.includes('claude-sonnet-5'))
  ) {
    familyScore = 0.97; // Claude 4.x/5.x Sonnet models
  } else if (
    model.name.includes('Haiku') &&
    (model.name.includes('Claude 4') || model.name.includes('Claude 5') || model.name.includes('claude-haiku-4'))
  ) {
    familyScore = 0.85; // Claude 4.x/5.x Haiku models
  }

  // Anthropic models - Claude 3.x family
  else if (model.name.includes('claude-3-7')) {
    familyScore = 0.95; // Claude 3.7 models
  } else if (model.name.includes('claude-3-5-sonnet-v2')) {
    familyScore = 0.9; // Claude 3.5 Sonnet v2
  } else if (model.name.includes('claude-3-5-sonnet')) {
    familyScore = 0.85; // Claude 3.5 Sonnet
  } else if (model.name.includes('claude-3-5-haiku')) {
    familyScore = 0.75; // Claude 3.5 Haiku
  } else if (model.name.includes('claude-3-sonnet')) {
    familyScore = 0.7; // Claude 3 Sonnet
  } else if (model.name.includes('claude-3-haiku')) {
    familyScore = 0.6; // Claude 3 Haiku
  } else if (model.name.includes('claude-3')) {
    familyScore = 0.65; // Other Claude 3 models
  }

  // Training cutoff recency (if available)
  if (model.trainingCutoff) {
    const cutoffDate = new Date(model.trainingCutoff);
    const now = new Date();
    const ageInMonths = (now.getFullYear() - cutoffDate.getFullYear()) * 12 + (now.getMonth() - cutoffDate.getMonth());
    // Newer = better, with diminishing returns
    trainingScore = Math.max(0, 1 - ageInMonths / 24); // Normalize to 2 years
  }

  // Weights - adjustable based on what's most important
  const weights = {
    context: 0.2, // Context window is important
    tokens: 0.15, // Max tokens capability
    tools: 0.2, // Tools support
    vision: 0.2, // Vision capability
    pricing: 0.05, // Cost efficiency
    family: 0.35, // Model family/generation (most important)
    training: 0.1, // Training data recency
  };

  // Calculate weighted score
  const totalScore =
    contextScore * weights.context +
    tokensScore * weights.tokens +
    toolsScore * weights.tools +
    visionScore * weights.vision +
    pricingScore * weights.pricing +
    familyScore * weights.family +
    trainingScore * weights.training;

  return totalScore;
};

/**
 * Check if a model has an admin-configured rank override
 * (rank !== undefined and rank >= 0)
 */
const hasAdminRank = (model: ExtendedModelInfo): boolean => {
  return model.rank !== undefined && model.rank >= 0;
};

/**
 * Sort models using admin-configured ranks first, then the sophisticated ranking algorithm.
 *
 * Priority order:
 * 1. Models with admin-configured rank (lower rank = higher priority)
 * 2. Models without admin rank, sorted by calculated capability score
 */
export const sortModelsByCapability = (models: ExtendedModelInfo[]): ExtendedModelInfo[] => {
  return [...models].sort((a, b) => {
    const aHasRank = hasAdminRank(a);
    const bHasRank = hasAdminRank(b);

    // If both have admin ranks, sort by rank (lower = higher priority)
    if (aHasRank && bHasRank) {
      return (a.rank as number) - (b.rank as number);
    }

    // If only one has admin rank, that one comes first
    if (aHasRank && !bHasRank) return -1;
    if (!aHasRank && bHasRank) return 1;

    // Neither has admin rank, use calculated score (higher score = higher priority)
    const scoreA = calculateModelScore(a, models);
    const scoreB = calculateModelScore(b, models);
    return scoreB - scoreA;
  });
};
