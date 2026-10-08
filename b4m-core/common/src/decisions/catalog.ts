import type { DecisionModelCapabilities, DecisionModelLimits } from './types';

/**
 * Platform ceilings, enforced by the request schema and visible in OpenAPI. Per-model caps in the catalog can only
 * tighten these; `validateDecisionRequest` enforces them and names the cap.
 */
export const DECISION_PLATFORM_LIMITS = {
  maxQuestions: 50,
  maxChoices: 64,
  minLevels: 2,
  maxLevels: 10,
  maxImages: 8,
  /** Per text field and per serialized `json` part, in characters. */
  maxTextLength: 256 * 1024,
} as const;

const PLATFORM_CAPS: Omit<DecisionModelLimits, 'maxInputTokens' | 'maxImageDimension'> = {
  maxQuestions: DECISION_PLATFORM_LIMITS.maxQuestions,
  maxChoices: DECISION_PLATFORM_LIMITS.maxChoices,
  maxLevels: DECISION_PLATFORM_LIMITS.maxLevels,
  maxImages: DECISION_PLATFORM_LIMITS.maxImages,
};

// Adding a model: append its id here, then TypeScript forces a declaration in DECISION_MODEL_CATALOG. Every entry must
// be a real decision model: a chat model asked for a probability returns uncalibrated numbers.
export const DECISION_MODEL_IDS = ['test-decisions', 'gpt-6-luna'] as const;
export type DecisionModelId = (typeof DECISION_MODEL_IDS)[number];

export const DECISION_MODEL_CATALOG: Record<DecisionModelId, DecisionModelCapabilities> = {
  // Deterministic and free; registered only when ENABLE_TEST_DECISION_PROVIDER=true (never in production).
  'test-decisions': {
    provider: 'test',
    protocol: 'test',
    displayName: 'Test decisions (non-production)',
    limits: { ...PLATFORM_CAPS, maxInputTokens: 64_000, maxImageDimension: 1024 },
    pricing: { usdPerMillionInputTokens: 0, usdPerMillionOutputTokens: 0 },
  },
  // OpenAI publishes no per-request caps yet, so the platform ceilings apply. It reports no versioned id either:
  // the response `model` is `gpt-6-luna`, so there is nothing to pin to until it does.
  'gpt-6-luna': {
    provider: 'openai',
    protocol: 'openaiDecisions',
    displayName: 'GPT-6 Luna',
    limits: { ...PLATFORM_CAPS, maxInputTokens: 64_000, maxImageDimension: 2000 },
    pricing: { usdPerMillionInputTokens: 0.1, usdPerMillionOutputTokens: 0 },
  },
};

// The wire `model` is a plain string (as for video models), so retiring or adding an id never changes the published
// request schema; an id outside the catalog is a 422 `model_unavailable`, the same as one this deployment does not serve.
export const isDecisionModelId = (id: string): id is DecisionModelId => Object.hasOwn(DECISION_MODEL_CATALOG, id);

export const getDecisionModelCapabilities = (id: DecisionModelId): DecisionModelCapabilities =>
  DECISION_MODEL_CATALOG[id];
