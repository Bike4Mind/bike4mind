export const EMBEDDING_PROVIDER_IDS = ['openai', 'voyage', 'bedrock', 'ollama'] as const;
export type EmbeddingProviderId = (typeof EMBEDDING_PROVIDER_IDS)[number];

/**
 * The output widths a model can serve through our pipeline - what the provider path actually honours, not every
 * width the vendor publishes.
 *
 * - `fixed`: native width only.
 * - `range`: any width from `min` to `native`; we embed at full width and truncate (Matryoshka-trained models).
 * - `discrete`: only the listed widths (`values` includes `native`); the provider shortens it itself.
 */
export type EmbeddingDimensions =
  | { kind: 'fixed'; native: number }
  | { kind: 'range'; native: number; min: number }
  | { kind: 'discrete'; native: number; values: readonly number[] };

export type EmbeddingModelCapabilities = {
  provider: EmbeddingProviderId;
  displayName: string;
  dimensions: EmbeddingDimensions;
  /** Per-input token ceiling; also sizes chunks (SmartChunker), so it can sit below the vendor's limit. */
  maxInputTokens: number;
  /** null = no published rate: the model settles $0 with an alarm and is refused by spend preflights. */
  pricing: { usdPerMillionTokens: number } | null;
};
