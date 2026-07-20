import { ModelBackend } from '@bike4mind/common';

/**
 * TODO: This registry is currently unused but provides useful metadata about provider caching capabilities.
 * Potential uses:
 * - Pre-flight checks before enabling caching
 * - Documentation/reference for supported providers
 * - Feature flags based on provider capabilities
 *
 * Consider integrating with ChatCompletionProcess to validate cache strategy against provider capabilities.
 */

export interface ProviderCachingCapabilities {
  backend: ModelBackend;
  supported: boolean;
  automatic: boolean; // True if caching requires no code changes
  explicitControl: boolean; // True if provider supports explicit cache markers
  minTokens: number;
  maxTTL: string;
  costSavings: number; // Percentage (0-100)
}

/**
 * Registry of caching capabilities by provider
 */
export const CACHING_CAPABILITIES: Record<ModelBackend, ProviderCachingCapabilities> = {
  [ModelBackend.Anthropic]: {
    backend: ModelBackend.Anthropic,
    supported: true,
    automatic: false,
    explicitControl: true,
    minTokens: 1024,
    maxTTL: '1h',
    costSavings: 90,
  },
  [ModelBackend.OpenAI]: {
    backend: ModelBackend.OpenAI,
    supported: true,
    automatic: true,
    explicitControl: false,
    minTokens: 1024,
    maxTTL: '24h',
    costSavings: 90,
  },
  [ModelBackend.Gemini]: {
    backend: ModelBackend.Gemini,
    supported: true,
    automatic: true,
    explicitControl: true,
    minTokens: 1024,
    maxTTL: 'auto',
    costSavings: 90,
  },
  [ModelBackend.Bedrock]: {
    backend: ModelBackend.Bedrock,
    supported: true,
    automatic: false,
    explicitControl: true,
    minTokens: 1024,
    maxTTL: '1h',
    costSavings: 90,
  },
  [ModelBackend.XAI]: {
    backend: ModelBackend.XAI,
    supported: true,
    automatic: true,
    explicitControl: false,
    minTokens: 0, // Automatic
    maxTTL: '5m',
    costSavings: 60,
  },
  [ModelBackend.Ollama]: {
    backend: ModelBackend.Ollama,
    supported: false,
    automatic: false,
    explicitControl: false,
    minTokens: 0,
    maxTTL: '0',
    costSavings: 0,
  },
  [ModelBackend.BFL]: {
    backend: ModelBackend.BFL,
    supported: false, // Image generation, not text
    automatic: false,
    explicitControl: false,
    minTokens: 0,
    maxTTL: '0',
    costSavings: 0,
  },
  [ModelBackend.VoyageAI]: {
    backend: ModelBackend.VoyageAI,
    supported: false,
    automatic: false,
    explicitControl: false,
    minTokens: 0,
    maxTTL: '0',
    costSavings: 0,
  },
  [ModelBackend.AWS]: {
    backend: ModelBackend.AWS,
    supported: false,
    automatic: false,
    explicitControl: false,
    minTokens: 0,
    maxTTL: '0',
    costSavings: 0,
  },
  [ModelBackend.LocalImage]: {
    backend: ModelBackend.LocalImage,
    supported: false, // Image generation, not text
    automatic: false,
    explicitControl: false,
    minTokens: 0,
    maxTTL: '0',
    costSavings: 0,
  },
};

/**
 * Get caching capabilities for a model
 */
export function getCachingCapabilities(model: string): ProviderCachingCapabilities {
  // Map model ID to backend using heuristics
  // TODO: This could be enhanced by querying the ModelInfo registry if available
  const modelLower = model.toLowerCase();

  if (modelLower.includes('claude')) {
    return CACHING_CAPABILITIES[ModelBackend.Anthropic];
  } else if (modelLower.includes('gpt') || modelLower.includes('o1') || modelLower.includes('o3')) {
    return CACHING_CAPABILITIES[ModelBackend.OpenAI];
  } else if (modelLower.includes('gemini')) {
    return CACHING_CAPABILITIES[ModelBackend.Gemini];
  } else if (modelLower.includes('grok')) {
    return CACHING_CAPABILITIES[ModelBackend.XAI];
  } else if (modelLower.includes('bedrock')) {
    return CACHING_CAPABILITIES[ModelBackend.Bedrock];
  } else if (modelLower.includes('ollama')) {
    return CACHING_CAPABILITIES[ModelBackend.Ollama];
  }

  // Default: no caching support
  return {
    backend: ModelBackend.Anthropic, // Placeholder
    supported: false,
    automatic: false,
    explicitControl: false,
    minTokens: 0,
    maxTTL: '0',
    costSavings: 0,
  };
}

/**
 * Check if a model supports prompt caching
 */
export function supportsCaching(model: string): boolean {
  return getCachingCapabilities(model).supported;
}
