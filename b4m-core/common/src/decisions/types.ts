// Vendors, for key resolution, billing and metrics. Each provider PR appends its id here.
export const DECISION_PROVIDER_IDS = ['test', 'openai'] as const;
export type DecisionProviderId = (typeof DECISION_PROVIDER_IDS)[number];

// Adapters are keyed by wire protocol, not vendor: one protocol can front several vendors (e.g. a Jev-compatible
// `systemOne` endpoint served by more than one host).
export const DECISION_PROTOCOLS = ['test', 'openaiDecisions'] as const;
export type DecisionProtocol = (typeof DECISION_PROTOCOLS)[number];

export type DecisionModelLimits = {
  maxQuestions: number;
  maxChoices: number;
  maxLevels: number;
  /** 0 on a text-only model. */
  maxImages: number;
  /** Published for callers; not enforced locally, since tokenizers differ by vendor. */
  maxInputTokens: number;
  /** Longest image edge, in px; larger images are downscaled before encoding. */
  maxImageDimension: number;
};

export type DecisionModelPricing = {
  usdPerMillionInputTokens: number;
  usdPerMillionOutputTokens: number;
};

export type DecisionModelCapabilities = {
  provider: DecisionProviderId;
  protocol: DecisionProtocol;
  displayName: string;
  /** Set on a floating alias (e.g. `-latest`); callers tuning thresholds should pin the versioned id instead. */
  aliasOf?: string;
  limits: DecisionModelLimits;
  pricing: DecisionModelPricing;
};
