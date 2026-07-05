import { ICachingAdapter } from './base';
import { AnthropicCachingAdapter } from './anthropic';
import { OpenAICachingAdapter } from './openai';
import { GeminiCachingAdapter } from './gemini';
import { XAICachingAdapter } from './xai';
import { ModelBackend } from '@bike4mind/common';

/**
 * No-op adapter for providers without caching support
 */
export class NoOpCachingAdapter implements ICachingAdapter {
  applyCaching(apiParams: Record<string, unknown>): Record<string, unknown> {
    return apiParams;
  }

  extractCacheStats(): undefined {
    return undefined;
  }
}

/**
 * Adapter registry
 */
const ADAPTERS: Record<ModelBackend, ICachingAdapter> = {
  [ModelBackend.Anthropic]: new AnthropicCachingAdapter(),
  [ModelBackend.OpenAI]: new OpenAICachingAdapter(),
  [ModelBackend.Gemini]: new GeminiCachingAdapter(),
  [ModelBackend.Bedrock]: new AnthropicCachingAdapter(), // Uses Anthropic format
  [ModelBackend.XAI]: new XAICachingAdapter(),
  [ModelBackend.Ollama]: new NoOpCachingAdapter(),
  [ModelBackend.BFL]: new NoOpCachingAdapter(),
  [ModelBackend.VoyageAI]: new NoOpCachingAdapter(),
  [ModelBackend.AWS]: new NoOpCachingAdapter(),
};

/**
 * Get the appropriate caching adapter for a provider
 */
export function getCachingAdapter(backend: ModelBackend): ICachingAdapter {
  return ADAPTERS[backend] || new NoOpCachingAdapter();
}

export * from './base';
export * from './anthropic';
export * from './openai';
export * from './gemini';
export * from './xai';
