import type { TiktokenEncoding, TiktokenModel, Tiktoken } from 'tiktoken';
import { type ILogger } from '@bike4mind/observability';

/**
 * Model ids tiktoken has no mapping for (Claude, Gemini, other vendors' embedding models). These are
 * expected, not faults, so each is noted once per process at debug level. Module-level rather than
 * per instance because several tokenizers live side by side (chat, KB search, embeddings, media).
 */
const modelsWithoutEncoding = new Set<string>();

/**
 * tiktoken matches exact ids only, and its table trails OpenAI's releases: `gpt-5.4-mini` is
 * unknown while `gpt-5` maps to o200k_base. Retry with trailing `-`/`.` segments stripped so a new
 * point release resolves to its family's encoding instead of silently counting with cl100k.
 */
function lookupByFamilyPrefix(
  lookupEncodingName: (model: TiktokenModel) => TiktokenEncoding,
  modelId: string
): TiktokenEncoding | undefined {
  const segments = modelId.split(/(?=[-.])/);
  for (let length = segments.length; length > 0; length--) {
    try {
      return lookupEncodingName(segments.slice(0, length).join('') as TiktokenModel);
    } catch {
      // Not in tiktoken's table; try the next shorter prefix.
    }
  }
  return undefined;
}

/**
 * Interface for different tokenizer implementations
 */
export interface ITokenizer {
  countTokens(text: string | string[], modelId?: string): Promise<number>;
  encodeTokens(text: string, modelId?: string): Promise<number[]>;
  decodeTokens(tokens: number[], modelId?: string): Promise<string>;
}

/**
 * Configuration options for the tokenizer
 */
export interface TokenizerOptions {
  logger: ILogger;
  enableCaching?: boolean;
  fallbackEncoding?: string;
}

/**
 * Tiktoken-based implementation of the tokenizer interface
 * Provides caching for performance and configurable logging
 *
 * Both methods encode via `encode_ordinary`, never `encode`: the text here is untrusted (user
 * messages, fab-file chunks, fetched pages, MCP tool descriptions) and `encode` REJECTS a
 * special-token literal such as "<|endoftext|>" - which zeroes the input-token breakdown and fails
 * prompt assembly outright. Admitting them as real special tokens (`allowed_special: 'all'`) is the
 * wrong repair: it charges one token instead of the several their characters cost, under-counting a
 * figure we bill on. Providers treat user-supplied literals as ordinary text too.
 * fab-pipeline's chunker/embedding service and the CLI TokenCounter use the same call for this reason.
 */
export class TiktokenTokenizer implements ITokenizer {
  /** Keyed by encoding name, so models sharing an encoding (gpt-4o, gpt-5, o3) share one WASM encoder. */
  private encoderCache = new Map<string, Tiktoken>();
  private isShuttingDown = false;
  private logger: ILogger;
  private enableCaching: boolean;
  private fallbackEncoding: string;

  constructor(options: TokenizerOptions) {
    this.logger = options.logger;
    this.enableCaching = options.enableCaching ?? true;
    this.fallbackEncoding = options.fallbackEncoding || 'cl100k_base';
  }

  /**
   * Count tokens in text using the appropriate encoder for the model
   * @param text - Text to count tokens for (string or array of strings)
   * @param modelId - Model ID to determine encoding (optional)
   * @returns Promise<number> - Token count
   */
  async countTokens(text: string | string[], modelId?: string, logger?: ILogger): Promise<number> {
    if (this.isShuttingDown) {
      throw new Error('TiktokenTokenizer is shutting down');
    }

    const encoder = await this.getEncoder(modelId, logger);

    const texts = Array.isArray(text) ? text : [text];
    return texts.reduce((sum, t) => sum + encoder.encode_ordinary(t).length, 0);
  }

  /**
   * Encode text to tokens using the appropriate encoder for the model
   * @param text - Text to encode (single string only)
   * @param modelId - Model ID to determine encoding (optional)
   * @returns Promise<number[]> - Array of token IDs
   */
  async encodeTokens(text: string, modelId?: string, logger?: ILogger): Promise<number[]> {
    if (this.isShuttingDown) {
      throw new Error('TiktokenTokenizer is shutting down');
    }

    const encoder = await this.getEncoder(modelId, logger);
    return Array.from(encoder.encode_ordinary(text));
  }

  /**
   * Decode token ids back to text through the same encoder encodeTokens used, so an
   * encode -> slice -> decode round trip yields real text rather than the ids themselves.
   * @param tokens - Token ids, typically a slice of an encodeTokens result
   * @param modelId - Model ID to determine encoding (must match the one used to encode)
   * @returns Promise<string> - The decoded text
   *
   * tiktoken's wasm decode() hands back raw UTF-8 bytes. A slice that ends mid-character therefore
   * decodes to a trailing U+FFFD; callers that sliced are expected to trim it.
   */
  async decodeTokens(tokens: number[], modelId?: string, logger?: ILogger): Promise<string> {
    if (this.isShuttingDown) {
      throw new Error('TiktokenTokenizer is shutting down');
    }

    const encoder = await this.getEncoder(modelId, logger);
    return new TextDecoder().decode(encoder.decode(new Uint32Array(tokens)));
  }

  /**
   * Returns a lightweight ITokenizer proxy that delegates WASM encoder operations
   * to this instance (preserving the shared encoder cache) but routes log output
   * through the provided logger. Useful for attaching per-request context (e.g.
   * requestId, userId) to tokenizer logs without sacrificing the singleton benefit.
   */
  withLogger(logger: ILogger): ITokenizer {
    return {
      countTokens: (text, modelId) => this.countTokens(text, modelId, logger),
      encodeTokens: (text, modelId) => this.encodeTokens(text, modelId, logger),
      decodeTokens: (tokens, modelId) => this.decodeTokens(tokens, modelId, logger),
    };
  }

  /**
   * Get or create an encoder for the given model
   * @private
   */
  private async getEncoder(modelId?: string, logger: ILogger = this.logger): Promise<Tiktoken> {
    const { get_encoding, get_encoding_name_for_model } = await import('tiktoken');

    const encodingName = this.resolveEncodingName(get_encoding_name_for_model, modelId, logger);

    const cached = this.enableCaching ? this.encoderCache.get(encodingName) : undefined;
    if (cached) {
      return cached;
    }

    const encoder = get_encoding(encodingName);
    logger.debug(`Created tiktoken encoder with ${encodingName} encoding`);

    if (this.enableCaching) {
      this.encoderCache.set(encodingName, encoder);
    }

    return encoder;
  }

  /**
   * Map a model id to its tiktoken encoding, or to the fallback for ids tiktoken does not know.
   * tiktoken only maps OpenAI ids, so every Claude/Gemini id lands on the fallback by design.
   */
  private resolveEncodingName(
    lookupEncodingName: (model: TiktokenModel) => TiktokenEncoding,
    modelId: string | undefined,
    logger: ILogger
  ): TiktokenEncoding {
    const fallback = this.fallbackEncoding as TiktokenEncoding;
    if (!modelId || modelsWithoutEncoding.has(modelId)) {
      return fallback;
    }

    const encodingName = lookupByFamilyPrefix(lookupEncodingName, modelId);
    if (encodingName) {
      return encodingName;
    }

    modelsWithoutEncoding.add(modelId);
    logger.debug(`No tiktoken encoding for model ${modelId}; counting with ${fallback}`);
    return fallback;
  }

  /**
   * Clear all cached encoders and free memory
   * Should be called during application shutdown
   */
  clearCache(): void {
    this.isShuttingDown = true;
    this.encoderCache.forEach((encoder, key) => {
      try {
        encoder.free();
        this.logger.debug(`Freed tiktoken encoder: ${key}`);
      } catch (error) {
        this.logger.warn(`Error freeing encoder ${key}:`, error);
      }
    });
    this.encoderCache.clear();
  }

  /**
   * Get cache statistics for monitoring
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.encoderCache.size,
      keys: Array.from(this.encoderCache.keys()),
    };
  }

  /**
   * Warm up the cache with commonly used encoders
   * @param modelIds - Array of model IDs to pre-load encoders for
   */
  async warmUpCache(modelIds: string[] = [this.fallbackEncoding]): Promise<void> {
    for (const modelId of modelIds) {
      try {
        await this.countTokens('test', modelId);
        this.logger.debug(`Warmed up encoder cache for: ${modelId}`);
      } catch (error) {
        this.logger.warn(`Failed to warm up cache for model ${modelId}:`, error);
      }
    }
  }
}

/**
 * Factory function to create a tokenizer instance with common configuration
 */
export function createTokenizer(options: TokenizerOptions): ITokenizer {
  return new TiktokenTokenizer(options);
}
