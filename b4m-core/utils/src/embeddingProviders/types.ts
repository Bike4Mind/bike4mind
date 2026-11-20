import type { EmbeddingProviderId, EmbeddingModelId } from '@bike4mind/common';

export type EmbeddingRequest = {
  model: EmbeddingModelId;
  inputs: readonly string[];
  /** Output width; omitted means the model's native width. */
  dimensions?: number;
  inputType?: 'query' | 'document';
};

export type EmbeddingResult = {
  /** One vector per input, in input order, each `dimensions ?? native` wide. */
  vectors: number[][];
  /** Provider-reported input tokens, when the response carries them. */
  inputTokens?: number;
};

export type EmbeddingContext = { signal?: AbortSignal };

/**
 * Contract every provider honours:
 * - empty `inputs` resolves `{ vectors: [] }` without a network call;
 * - a model not in `models`, or a width `planEmbeddingDimensions` reports unsupported, throws before any network call;
 * - the result is all-or-nothing (never partial) and holds exactly one vector per input, else the call throws;
 * - an authentication failure throws `EmbeddingAuthError` (key-based providers).
 */
export type EmbeddingProvider = {
  readonly id: EmbeddingProviderId;
  readonly models: readonly EmbeddingModelId[];
  embed(request: EmbeddingRequest, context?: EmbeddingContext): Promise<EmbeddingResult>;
};
