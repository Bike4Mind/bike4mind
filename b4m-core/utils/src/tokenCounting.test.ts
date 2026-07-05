import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TiktokenTokenizer, createTokenizer } from './tokenCounting';
import type { ILogger } from '@bike4mind/observability';

const mockEncode = vi.fn();
const mockFree = vi.fn();
const mockEncodingForModel = vi.fn();
const mockGetEncoding = vi.fn();

const mockEncoder = {
  encode: mockEncode,
  free: mockFree,
};

vi.mock('tiktoken', () => ({
  encoding_for_model: mockEncodingForModel,
  get_encoding: mockGetEncoding,
}));

describe('TiktokenTokenizer', () => {
  let mockLogger: ILogger;
  let tokenizer: TiktokenTokenizer;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLogger = {
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    mockEncodingForModel.mockReturnValue(mockEncoder);
    mockGetEncoding.mockReturnValue(mockEncoder);
    mockEncode.mockReturnValue(new Uint32Array([1, 2, 3])); // Mock 3 tokens

    tokenizer = new TiktokenTokenizer({ logger: mockLogger });
  });

  afterEach(() => {
    tokenizer.clearCache();
  });

  describe('countTokens', () => {
    it('should count tokens for a single text string', async () => {
      const result = await tokenizer.countTokens('Hello world');

      expect(result).toBe(3);
      expect(mockGetEncoding).toHaveBeenCalledWith('cl100k_base');
      expect(mockEncode).toHaveBeenCalledWith('Hello world');
    });

    it('should count tokens for multiple text strings', async () => {
      mockEncode
        .mockReturnValueOnce(new Uint32Array([1, 2])) // First text: 2 tokens
        .mockReturnValueOnce(new Uint32Array([3, 4, 5])); // Second text: 3 tokens

      const result = await tokenizer.countTokens(['Hello', 'world']);

      expect(result).toBe(5); // 2 + 3 = 5 tokens
      expect(mockEncode).toHaveBeenCalledTimes(2);
      expect(mockEncode).toHaveBeenNthCalledWith(1, 'Hello');
      expect(mockEncode).toHaveBeenNthCalledWith(2, 'world');
    });

    it('should use model-specific encoder when model ID is provided', async () => {
      await tokenizer.countTokens('test', 'gpt-4');

      expect(mockEncodingForModel).toHaveBeenCalledWith('gpt-4');
      expect(mockGetEncoding).not.toHaveBeenCalled();
    });

    it('should fallback to configured encoding when model-specific encoder fails', async () => {
      mockEncodingForModel.mockImplementationOnce(() => {
        throw new Error('Model not supported');
      });

      const result = await tokenizer.countTokens('test', 'unsupported-model');

      expect(result).toBe(3);
      expect(mockEncodingForModel).toHaveBeenCalledWith('unsupported-model');
      expect(mockGetEncoding).toHaveBeenCalledWith('cl100k_base');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to create encoder for model unsupported-model'),
        expect.any(Error)
      );
    });

    it('should cache encoders and reuse them by default', async () => {
      await tokenizer.countTokens('test1', 'gpt-4');
      expect(mockEncodingForModel).toHaveBeenCalledTimes(1);

      // Second call with same model should use cached encoder
      await tokenizer.countTokens('test2', 'gpt-4');
      expect(mockEncodingForModel).toHaveBeenCalledTimes(1); // Still only called once
      expect(mockEncode).toHaveBeenCalledTimes(2); // But encode called twice
    });

    it('should not cache when caching is disabled', async () => {
      const noCacheTokenizer = new TiktokenTokenizer({ enableCaching: false, logger: mockLogger });

      await noCacheTokenizer.countTokens('test1', 'gpt-4');
      expect(mockEncodingForModel).toHaveBeenCalledTimes(1);

      // Second call should create encoder again
      await noCacheTokenizer.countTokens('test2', 'gpt-4');
      expect(mockEncodingForModel).toHaveBeenCalledTimes(2); // Called twice

      noCacheTokenizer.clearCache();
    });

    it('should use custom fallback encoding', async () => {
      const customTokenizer = new TiktokenTokenizer({
        fallbackEncoding: 'p50k_base',
        logger: mockLogger,
      });

      await customTokenizer.countTokens('test');

      expect(mockGetEncoding).toHaveBeenCalledWith('p50k_base');
      customTokenizer.clearCache();
    });

    it('should handle empty strings', async () => {
      mockEncode.mockReturnValue(new Uint32Array([]));

      const result = await tokenizer.countTokens('');

      expect(result).toBe(0);
      expect(mockEncode).toHaveBeenCalledWith('');
    });

    it('should handle empty arrays', async () => {
      const result = await tokenizer.countTokens([]);

      expect(result).toBe(0);
      expect(mockEncode).not.toHaveBeenCalled();
    });

    it('should throw error when tokenizer is shutting down', async () => {
      tokenizer.clearCache(); // This sets isShuttingDown to true

      await expect(tokenizer.countTokens('test')).rejects.toThrow('TiktokenTokenizer is shutting down');
    });
  });

  describe('encodeTokens', () => {
    it('should encode text to token array', async () => {
      mockEncode.mockReturnValue(new Uint32Array([1, 2, 3]));

      const result = await tokenizer.encodeTokens('Hello world');

      expect(result).toEqual([1, 2, 3]);
      expect(mockEncode).toHaveBeenCalledWith('Hello world');
    });

    it('should use model-specific encoder for encoding', async () => {
      await tokenizer.encodeTokens('test', 'gpt-4');

      expect(mockEncodingForModel).toHaveBeenCalledWith('gpt-4');
    });
  });

  describe('clearCache', () => {
    it('should free all encoders and clear cache', async () => {
      await tokenizer.countTokens('test1', 'gpt-4');
      await tokenizer.countTokens('test2', 'gpt-3.5-turbo');

      const statsBefore = tokenizer.getCacheStats();
      expect(statsBefore.size).toBeGreaterThan(0);

      tokenizer.clearCache();

      expect(mockFree).toHaveBeenCalledTimes(statsBefore.size);
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Freed tiktoken encoder'));

      const statsAfter = tokenizer.getCacheStats();
      expect(statsAfter.size).toBe(0);
      expect(statsAfter.keys).toEqual([]);
    });

    it('should handle errors when freeing encoders', async () => {
      mockFree.mockImplementationOnce(() => {
        throw new Error('Free failed');
      });

      await tokenizer.countTokens('test');

      // Should not throw, just log warning
      expect(() => tokenizer.clearCache()).not.toThrow();
      expect(mockFree).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Error freeing encoder'), expect.any(Error));
    });
  });

  describe('warmUpCache', () => {
    it('should pre-load encoders for specified models', async () => {
      await tokenizer.warmUpCache(['gpt-4', 'gpt-3.5-turbo']);

      const stats = tokenizer.getCacheStats();
      expect(stats.size).toBe(2);
      expect(stats.keys).toContain('gpt-4');
      expect(stats.keys).toContain('gpt-3.5-turbo');
    });

    it('should handle errors during warm up', async () => {
      mockEncodingForModel.mockImplementationOnce(() => {
        throw new Error('Model not supported');
      });

      // Should not throw, just log warning
      await expect(tokenizer.warmUpCache(['unsupported-model'])).resolves.toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to create encoder for model unsupported-model'),
        expect.any(Error)
      );
    });
  });
});

describe('createTokenizer factory', () => {
  it('should create tokenizer with provided options', () => {
    const logger: ILogger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const tokenizer = createTokenizer({ logger, enableCaching: false });

    expect(tokenizer).toBeInstanceOf(TiktokenTokenizer);
  });
});
