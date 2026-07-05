/**
 * Shared AI model configuration parameters.
 *
 * Used across the resolution chain: channel -> agent -> org -> system fallback.
 * Each property is resolved independently - e.g., modelId may come from the
 * channel config while temperature comes from the org default.
 *
 * Undefined = inherit from the next level in the chain.
 */
export interface IModelConfig {
  /** AI model ID (e.g. 'gpt-4.1-mini-2025-04-14'). Undefined = inherit */
  preferredModel?: string;
  /**
   * Image generation model ID (e.g. 'flux-pro-1.1-ultra'). Undefined = inherit
   * (the caller's Smart Tools image selection / system default). Used by image
   * tools when this config's owner (e.g. an agent) generates images, mirroring
   * how `preferredModel` overrides the text model.
   */
  preferredImageModel?: string;
  /** Temperature for AI responses (0.0-2.0). Undefined = inherit */
  temperature?: number;
  /** Max output tokens (1-200000). Undefined = inherit */
  maxTokens?: number;
}
