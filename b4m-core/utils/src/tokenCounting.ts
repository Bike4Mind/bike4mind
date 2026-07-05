import type { TiktokenModel, Tiktoken } from 'tiktoken';
import { type ILogger } from '@bike4mind/observability';

/**
 * Interface for different tokenizer implementations
 */
export interface ITokenizer {
  countTokens(text: string | string[], modelId?: string): Promise<number>;
  encodeTokens(text: string, modelId?: string): Promise<number[]>;
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
 */
export class TiktokenTokenizer implements ITokenizer {
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
    return texts.reduce((sum, t) => sum + encoder.encode(t).length, 0);
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
    return Array.from(encoder.encode(text));
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
    };
  }

  /**
   * Get or create an encoder for the given model
   * @private
   */
  private async getEncoder(modelId?: string, logger: ILogger = this.logger): Promise<Tiktoken> {
    const { encoding_for_model, get_encoding } = await import('tiktoken');

    const cacheKey = modelId || this.fallbackEncoding;

    if (this.enableCaching && this.encoderCache.has(cacheKey)) {
      return this.encoderCache.get(cacheKey)!;
    }

    let encoder: Tiktoken;
    try {
      if (modelId) {
        encoder = encoding_for_model(modelId as TiktokenModel);
        logger.debug(`Created tiktoken encoder for model: ${modelId}`);
      } else {
        encoder = get_encoding(this.fallbackEncoding as any);
        logger.debug(`Created tiktoken encoder with ${this.fallbackEncoding} encoding`);
      }

      if (this.enableCaching) {
        this.encoderCache.set(cacheKey, encoder);
      }
    } catch (error) {
      logger.warn(`Failed to create encoder for model ${modelId}, falling back to ${this.fallbackEncoding}:`, error);
      encoder = get_encoding(this.fallbackEncoding as any);

      if (this.enableCaching) {
        this.encoderCache.set(this.fallbackEncoding, encoder);
      }
    }

    return encoder;
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
