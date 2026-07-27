import { Logger } from '@bike4mind/observability';
import OpenAI from 'openai';
import { EmbeddingModelInfo, EmbeddingModelProvider, EmbeddingService } from '../EmbeddingService';
import { OpenAIEmbeddingModel } from '@bike4mind/common';

export const OPENAI_EMBEDDING_MODEL_MAP: Record<OpenAIEmbeddingModel, EmbeddingModelInfo<OpenAIEmbeddingModel>> = {
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL]: {
    provider: EmbeddingModelProvider.OPENAI,
    model: OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL,
    contextWindow: 8192,
    dimensions: [1536],
  },
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE]: {
    provider: EmbeddingModelProvider.OPENAI,
    model: OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE,
    contextWindow: 8192,
    dimensions: [3072],
  },
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002]: {
    provider: EmbeddingModelProvider.OPENAI,
    model: OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002,
    contextWindow: 8192,
    dimensions: [1536],
  },
};

export class OpenAIEmbeddingService implements EmbeddingService {
  private client: OpenAI;
  private model: OpenAIEmbeddingModel;

  /** Hard limit imposed by OpenAI's embeddings API. */
  private static readonly MAX_TOKENS_PER_REQUEST = 300000;

  /**
   * Effective token limit with a 10% safety buffer.
   * The tiktoken fallback (text.length/3) deliberately overestimates to be safe,
   * but DB token counts may have been produced by a different tokenizer (Bedrock, Voyage)
   * that underestimates. The buffer keeps us clear of the hard limit under tokenizer variance.
   */
  private static readonly EFFECTIVE_TOKEN_LIMIT = Math.floor(OpenAIEmbeddingService.MAX_TOKENS_PER_REQUEST * 0.9);

  constructor(apiKey: string, model: OpenAIEmbeddingModel = OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002) {
    this.client = new OpenAI({ apiKey });
    this.validateModel(model);
    this.model = model;
  }

  private validateModel(model: OpenAIEmbeddingModel): void {
    if (!OPENAI_EMBEDDING_MODEL_MAP[model]) {
      throw new Error(`Invalid OpenAI embedding model: ${model}`);
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const response = await this.client.embeddings
      .create({
        model: this.model,
        input: text,
      })
      .catch((error: unknown) => {
        throw this.toActionableAuthError(error);
      });

    if (response.data && response.data.length > 0) {
      return response.data[0].embedding;
    }

    throw new Error('No embedding data received from OpenAI');
  }

  /**
   * Turn a raw OpenAI 401 into an operator-actionable message. A missing/placeholder key is caught
   * up front by EmbeddingFactory; this is the runtime backstop for a key that is invalid or revoked
   * at call time, so a failed file reports what to fix instead of a bare AuthenticationError.
   * Preserves the original message, and is a no-op for any non-auth error so the token-limit /
   * rate-limit / server-error handling below is left untouched.
   */
  private toActionableAuthError(error: unknown): unknown {
    if (error instanceof OpenAI.AuthenticationError) {
      return new Error(
        `OpenAI rejected the embedding request (401 Unauthorized): the OPENAI_API_KEY is invalid or expired. ` +
          `Set a valid key, or for an airgapped self-host unset it and set OLLAMA_BASE_URL to use a local embedder. ` +
          `(original: ${error.message})`
      );
    }
    return error;
  }

  /**
   * Generate embeddings for multiple texts in a single API call.
   * OpenAI constraints:
   * - Max 2,048 inputs per request
   * - Max 8,192 tokens per individual input
   * - Max 300,000 tokens total across all inputs in single request
   *
   * Automatically splits into multiple API calls if limits exceeded.
   *
   * @param texts - Array of text strings to embed
   * @param tokenCounts - Optional pre-calculated token counts per text (for performance optimization)
   * @returns Array of embedding vectors in the same order as inputs
   */
  async generateEmbeddingBatch(texts: string[], tokenCounts?: number[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const MAX_INPUTS_PER_REQUEST = 2048;
    const MAX_TOKENS_PER_INPUT = 8192;

    // Validate provided token counts for data integrity issues (undefined, null, NaN, <=0).
    // Cross-provider tokenizer mismatches are handled by the safety check in processSingleBatch().
    let tokens: number[];
    let needsRecalculation = false;

    if (!tokenCounts || tokenCounts.length !== texts.length) {
      needsRecalculation = true;
    } else {
      // Check for invalid values (undefined, null, NaN, 0, negative)
      for (let i = 0; i < tokenCounts.length; i++) {
        if (typeof tokenCounts[i] !== 'number' || !isFinite(tokenCounts[i]) || tokenCounts[i] <= 0) {
          needsRecalculation = true;
          break;
        }
      }
    }

    // Self-healing: recalculate only if data integrity validation fails
    if (needsRecalculation) {
      Logger.globalInstance.debug('[OpenAI] Invalid token counts detected, recalculating with tiktoken');
      tokens = await this.calculateTokenCounts(texts);
    } else {
      tokens = tokenCounts!;
    }

    // Validate individual inputs don't exceed per-input limit
    let totalTokens = 0;
    for (let i = 0; i < texts.length; i++) {
      const tokenCount = tokens[i];

      if (tokenCount > MAX_TOKENS_PER_INPUT) {
        throw new Error(`Input at index ${i} exceeds ${MAX_TOKENS_PER_INPUT} token limit (${tokenCount} tokens)`);
      }

      totalTokens += tokenCount;
    }

    Logger.globalInstance.debug(`[OpenAI] Batch embedding: ${texts.length} inputs, ${totalTokens} total tokens`);

    // Split into batches using the effective limit (not the hard 300k) to absorb tokenizer variance.
    const batches = this.createBatches(
      texts,
      tokens,
      MAX_INPUTS_PER_REQUEST,
      OpenAIEmbeddingService.EFFECTIVE_TOKEN_LIMIT
    );

    Logger.globalInstance.debug(
      `[OpenAI] Split into ${batches.length} batch(es) (effective limit: ${OpenAIEmbeddingService.EFFECTIVE_TOKEN_LIMIT} tokens)`
    );

    // If only one batch, process directly.
    // Safety check recalculates with OpenAI tiktoken to verify batch size.
    if (batches.length === 1) {
      return await this.processSingleBatch(batches[0].texts);
    }

    // Process multiple batches
    const allEmbeddings: number[][] = new Array(texts.length);

    for (const batch of batches) {
      // Safety check will recalculate token counts with OpenAI tiktoken for cross-provider accuracy
      const batchEmbeddings = await this.processSingleBatch(batch.texts);

      // Place embeddings in correct positions
      batchEmbeddings.forEach((embedding, batchIndex) => {
        allEmbeddings[batch.startIndex + batchIndex] = embedding;
      });
    }

    return allEmbeddings;
  }

  /**
   * Calculate token counts for texts using tiktoken (lazy loaded).
   * Falls back to estimation if tiktoken unavailable.
   */
  private async calculateTokenCounts(texts: string[]): Promise<number[]> {
    try {
      // Lazy load tiktoken only when needed
      const { encoding_for_model } = await import('tiktoken');
      const encoding = encoding_for_model('text-embedding-ada-002');

      const counts = texts.map(text => {
        const tokens = encoding.encode(text);
        return tokens.length;
      });

      encoding.free(); // Clean up

      return counts;
    } catch (error) {
      // Fallback to conservative estimation if tiktoken not available.
      // Dividing by 3 (not 4) because code and technical content averages ~3 chars/token.
      // Overestimating causes extra batch splits - that's safe. Underestimating causes API failures.
      Logger.globalInstance.warn(
        'tiktoken not available, using conservative token estimation (chars/3). Install tiktoken for accuracy.'
      );
      return texts.map(text => Math.ceil(text.length / 3));
    }
  }

  /**
   * Create batches that respect both input count and token limits.
   */
  private createBatches(
    texts: string[],
    tokenCounts: number[],
    maxInputs: number,
    maxTokens: number
  ): Array<{ texts: string[]; startIndex: number }> {
    const batches: Array<{ texts: string[]; startIndex: number }> = [];
    let currentBatch: string[] = [];
    let currentTokenCount = 0;
    let currentStartIndex = 0;

    for (let i = 0; i < texts.length; i++) {
      const tokenCount = tokenCounts[i];

      // Check if adding this text would exceed limits
      const wouldExceedInputLimit = currentBatch.length >= maxInputs;
      const wouldExceedTokenLimit = currentTokenCount + tokenCount > maxTokens;

      if (wouldExceedInputLimit || wouldExceedTokenLimit) {
        // Save current batch and start new one
        if (currentBatch.length > 0) {
          batches.push({ texts: currentBatch, startIndex: currentStartIndex });
        }
        currentBatch = [texts[i]];
        currentTokenCount = tokenCount;
        currentStartIndex = i;
      } else {
        currentBatch.push(texts[i]);
        currentTokenCount += tokenCount;
      }
    }

    // Add final batch
    if (currentBatch.length > 0) {
      batches.push({ texts: currentBatch, startIndex: currentStartIndex });
    }

    return batches;
  }

  /**
   * Process a single batch with safety checks.
   * Validates batch size using OpenAI's tiktoken and recursively splits if needed.
   * @param texts - Array of text strings to embed
   * @param preCalculatedTokens - Optional pre-calculated token counts from recursive split (avoids recalculation)
   */
  private async processSingleBatch(texts: string[], preCalculatedTokens?: number[]): Promise<number[][]> {
    // Safety Check: Verify batch size with OpenAI's actual tokenizer
    // ALWAYS use tiktoken (not DB token counts which might be from different tokenizer like Bedrock/Voyage)
    // Only skip recalculation if preCalculatedTokens provided from recursive split (same texts, already calculated)
    const tokenCounts = preCalculatedTokens || (await this.calculateTokenCounts(texts));
    const batchTokens = tokenCounts.reduce((sum, count) => sum + count, 0);

    if (batchTokens > OpenAIEmbeddingService.EFFECTIVE_TOKEN_LIMIT) {
      // Safety check triggered - likely cross-provider tokenizer mismatch (e.g., Bedrock chunks, OpenAI vectorization)
      Logger.globalInstance.warn(
        `[OpenAI] Batch exceeds effective token limit (${batchTokens}/${OpenAIEmbeddingService.EFFECTIVE_TOKEN_LIMIT} tokens), splitting recursively`
      );

      // Split in half and process recursively
      // Pass token counts to avoid recalculation in recursive calls
      const mid = Math.ceil(texts.length / 2);
      const firstHalf = texts.slice(0, mid);
      const secondHalf = texts.slice(mid);
      const firstTokens = tokenCounts.slice(0, mid);
      const secondTokens = tokenCounts.slice(mid);

      const [firstEmbeddings, secondEmbeddings] = await Promise.all([
        this.processSingleBatch(firstHalf, firstTokens),
        this.processSingleBatch(secondHalf, secondTokens),
      ]);

      return [...firstEmbeddings, ...secondEmbeddings];
    }

    // Check if any single text exceeds 8192 token limit (using already calculated tokens)
    for (let i = 0; i < tokenCounts.length; i++) {
      if (tokenCounts[i] > 8192) {
        throw new Error(
          `Text at index ${i} exceeds OpenAI's 8192 token limit per input (${tokenCounts[i]} tokens). ` +
            `This indicates a data integrity issue - chunk should have been smaller. ` +
            `This chunk cannot be processed and the entire batch must fail.`
        );
      }
    }

    // Normal batch processing
    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: texts,
      });

      if (response.data && response.data.length > 0) {
        // Sort by index to ensure correct order (API may return out of order)
        const sorted = response.data.sort((a, b) => a.index - b.index);
        return sorted.map(item => item.embedding);
      } else {
        throw new Error('No embedding data received from OpenAI');
      }
    } catch (error) {
      // A 401 is an auth failure, not a token-limit or transient error: surface it actionably and
      // do NOT fall through to the split / individual-fallback branches (which would either mask it
      // or re-issue the same doomed request once per text).
      if (error instanceof OpenAI.AuthenticationError) {
        throw this.toActionableAuthError(error);
      }

      // If API rejects due to token limit, split and retry recursively.
      // This handles cases where the local tokenizer underestimates the actual token count.
      if (this.isTokenLimitError(error)) {
        if (texts.length === 1) {
          // Cannot split a single text further
          throw error;
        }
        Logger.globalInstance.warn(
          `[OpenAI] API rejected batch due to token limit, splitting ${texts.length} texts and retrying`
        );
        const mid = Math.ceil(texts.length / 2);
        const [firstEmbeddings, secondEmbeddings] = await Promise.all([
          this.processSingleBatch(texts.slice(0, mid)),
          this.processSingleBatch(texts.slice(mid)),
        ]);
        return [...firstEmbeddings, ...secondEmbeddings];
      }

      // If batch fails, fall back to individual calls for resilience
      if (this.shouldFallbackToIndividual(error)) {
        Logger.globalInstance.warn(`Batch embedding failed, falling back to individual calls: ${error}`);
        return await this.generateEmbeddingBatchFallback(texts);
      }
      throw error;
    }
  }

  /**
   * Check if the error is an OpenAI token limit rejection.
   */
  private isTokenLimitError(error: unknown): boolean {
    if (error instanceof OpenAI.BadRequestError) {
      const body = error.error as { type?: string } | undefined;
      return body?.type === 'max_tokens_per_request';
    }
    return false;
  }

  /**
   * Check if we should fallback to individual calls on error.
   * Fallback for rate limits (429) and server errors (5xx), but not for auth/validation errors.
   */
  private shouldFallbackToIndividual(error: unknown): boolean {
    const err = error as { status?: number; response?: { status?: number } };
    const status = err.status ?? err.response?.status;
    // Fallback for rate limits and server errors
    return status === 429 || (status !== undefined && status >= 500 && status < 600);
  }

  /**
   * Fallback mechanism: Process texts individually if batch fails.
   * Used for resilience when batch API encounters transient errors.
   */
  private async generateEmbeddingBatchFallback(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];

    for (const text of texts) {
      try {
        const embedding = await this.generateEmbedding(text);
        embeddings.push(embedding);
      } catch (error) {
        // No more fallback. generateEmbedding already surfaces an actionable message (e.g. the
        // wrapped 401 for a mid-flight-revoked key), so rethrow it as-is rather than burying it
        // under a generic prefix; only a non-Error throw gets the descriptive wrapper.
        throw error instanceof Error ? error : new Error(`Failed to generate embedding for text: ${String(error)}`);
      }
    }

    return embeddings;
  }

  getModelInfo(): EmbeddingModelInfo<OpenAIEmbeddingModel> {
    return OPENAI_EMBEDDING_MODEL_MAP[this.model];
  }
}
