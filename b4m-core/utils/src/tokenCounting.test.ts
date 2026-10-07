import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TiktokenTokenizer, createTokenizer } from './tokenCounting';
import type { ILogger } from '@bike4mind/observability';

const mockEncodeOrdinary = vi.fn();
const mockFree = vi.fn();
const mockGetEncodingNameForModel = vi.fn();
const mockGetEncoding = vi.fn();

// A slice of tiktoken's real table. Anything else throws, as tiktoken does for every non-OpenAI id.
const KNOWN_ENCODINGS: Record<string, string> = {
  'gpt-4': 'cl100k_base',
  'gpt-3.5-turbo': 'cl100k_base',
  'gpt-4o': 'o200k_base',
  'gpt-5': 'o200k_base',
};
const lookupEncodingName = (model: string) => {
  const encoding = KNOWN_ENCODINGS[model];
  if (!encoding) throw new Error(`Invalid model: ${model}`);
  return encoding;
};

// Reaching `encode` at all is the bug: it rejects untrusted text carrying a special-token literal.
// Failing here names the regression, instead of leaving it to surface as a zeroed billing estimate.
const mockEncode = vi.fn(() => {
  throw new Error('The text contains a special token that is not allowed: <|endoftext|>');
});

const mockDecode = vi.fn();

const mockEncoder = {
  encode: mockEncode,
  encode_ordinary: mockEncodeOrdinary,
  decode: mockDecode,
  free: mockFree,
};

vi.mock('tiktoken', () => ({
  get_encoding_name_for_model: mockGetEncodingNameForModel,
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

    mockGetEncodingNameForModel.mockImplementation(lookupEncodingName);
    mockGetEncoding.mockReturnValue(mockEncoder);
    mockEncodeOrdinary.mockReturnValue(new Uint32Array([1, 2, 3])); // Mock 3 tokens

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
      expect(mockEncodeOrdinary).toHaveBeenCalledWith('Hello world');
    });

    it('should count tokens for multiple text strings', async () => {
      mockEncodeOrdinary
        .mockReturnValueOnce(new Uint32Array([1, 2])) // First text: 2 tokens
        .mockReturnValueOnce(new Uint32Array([3, 4, 5])); // Second text: 3 tokens

      const result = await tokenizer.countTokens(['Hello', 'world']);

      expect(result).toBe(5); // 2 + 3 = 5 tokens
      expect(mockEncodeOrdinary).toHaveBeenCalledTimes(2);
      expect(mockEncodeOrdinary).toHaveBeenNthCalledWith(1, 'Hello');
      expect(mockEncodeOrdinary).toHaveBeenNthCalledWith(2, 'world');
    });

    it('should use the encoding tiktoken maps the model to', async () => {
      await tokenizer.countTokens('test', 'gpt-4o');

      expect(mockGetEncodingNameForModel).toHaveBeenCalledWith('gpt-4o');
      expect(mockGetEncoding).toHaveBeenCalledWith('o200k_base');
    });

    it('should count a model tiktoken cannot map with the fallback encoding, without a warning', async () => {
      const result = await tokenizer.countTokens('test', 'global.anthropic.claude-sonnet-5');

      expect(result).toBe(3);
      expect(mockGetEncoding).toHaveBeenCalledWith('cl100k_base');
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'No tiktoken encoding for model global.anthropic.claude-sonnet-5; counting with cl100k_base'
      );
    });

    // The unknown-model set is module-level, so these ids must not be reused by any other test.
    it('should note an unmapped model once per process, across tokenizer instances', async () => {
      const otherTokenizer = new TiktokenTokenizer({ logger: mockLogger });

      await tokenizer.countTokens('a', 'voyage-3');
      await tokenizer.countTokens('b', 'voyage-3');
      await otherTokenizer.countTokens('c', 'voyage-3');
      await tokenizer.countTokens('d', 'nomic-embed-text');

      const unmappedNotes = vi
        .mocked(mockLogger.debug)
        .mock.calls.filter(([message]) => String(message).startsWith('No tiktoken encoding'));
      expect(unmappedNotes).toEqual([
        ['No tiktoken encoding for model voyage-3; counting with cl100k_base'],
        ['No tiktoken encoding for model nomic-embed-text; counting with cl100k_base'],
      ]);
      const voyageLookups = mockGetEncodingNameForModel.mock.calls.filter(([model]) => model === 'voyage-3');
      expect(voyageLookups).toHaveLength(1);
      expect(tokenizer.getCacheStats().keys).toEqual(['cl100k_base']);

      otherTokenizer.clearCache();
    });

    it('should resolve a point release tiktoken does not list to its family encoding', async () => {
      await tokenizer.countTokens('test', 'gpt-5.4-mini');

      expect(mockGetEncodingNameForModel).toHaveBeenNthCalledWith(1, 'gpt-5.4-mini');
      expect(mockGetEncodingNameForModel).toHaveBeenLastCalledWith('gpt-5');
      expect(mockGetEncoding).toHaveBeenCalledWith('o200k_base');
      expect(mockLogger.debug).not.toHaveBeenCalledWith(expect.stringContaining('No tiktoken encoding'));
    });

    it('should share one encoder between models with the same encoding', async () => {
      await tokenizer.countTokens('a', 'gpt-4o');
      await tokenizer.countTokens('b', 'gpt-5');

      expect(mockGetEncoding).toHaveBeenCalledTimes(1);
      expect(tokenizer.getCacheStats().keys).toEqual(['o200k_base']);
    });

    it('should cache encoders and reuse them by default', async () => {
      await tokenizer.countTokens('test1', 'gpt-4');
      expect(mockGetEncoding).toHaveBeenCalledTimes(1);

      await tokenizer.countTokens('test2', 'gpt-4');
      expect(mockGetEncoding).toHaveBeenCalledTimes(1);
      expect(mockEncodeOrdinary).toHaveBeenCalledTimes(2);
    });

    it('should not cache when caching is disabled', async () => {
      const noCacheTokenizer = new TiktokenTokenizer({ enableCaching: false, logger: mockLogger });

      await noCacheTokenizer.countTokens('test1', 'gpt-4');
      expect(mockGetEncoding).toHaveBeenCalledTimes(1);

      await noCacheTokenizer.countTokens('test2', 'gpt-4');
      expect(mockGetEncoding).toHaveBeenCalledTimes(2);

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
      mockEncodeOrdinary.mockReturnValue(new Uint32Array([]));

      const result = await tokenizer.countTokens('');

      expect(result).toBe(0);
      expect(mockEncodeOrdinary).toHaveBeenCalledWith('');
    });

    it('should handle empty arrays', async () => {
      const result = await tokenizer.countTokens([]);

      expect(result).toBe(0);
      expect(mockEncodeOrdinary).not.toHaveBeenCalled();
    });

    it('should throw error when tokenizer is shutting down', async () => {
      tokenizer.clearCache(); // This sets isShuttingDown to true

      await expect(tokenizer.countTokens('test')).rejects.toThrow('TiktokenTokenizer is shutting down');
    });

    it('should never use the special-token-rejecting encode', async () => {
      await tokenizer.countTokens('what does <|endoftext|> mean');
      await tokenizer.countTokens(['<|endofprompt|>', '<|fim_prefix|>']);
      await tokenizer.encodeTokens('<|endoftext|>');

      expect(mockEncode).not.toHaveBeenCalled();
    });
  });

  describe('encodeTokens', () => {
    it('should encode text to token array', async () => {
      mockEncodeOrdinary.mockReturnValue(new Uint32Array([1, 2, 3]));

      const result = await tokenizer.encodeTokens('Hello world');

      expect(result).toEqual([1, 2, 3]);
      expect(mockEncodeOrdinary).toHaveBeenCalledWith('Hello world');
    });

    it('should use model-specific encoder for encoding', async () => {
      await tokenizer.encodeTokens('test', 'gpt-4o');

      expect(mockGetEncoding).toHaveBeenCalledWith('o200k_base');
    });
  });

  describe('decodeTokens', () => {
    it('decodes the UTF-8 bytes tiktoken returns back into a string', async () => {
      mockDecode.mockReturnValue(new TextEncoder().encode('Hello world'));

      const result = await tokenizer.decodeTokens([1, 2, 3]);

      expect(result).toBe('Hello world');
      expect(mockDecode).toHaveBeenCalledWith(new Uint32Array([1, 2, 3]));
    });

    it('decodes through the same model-specific encoder encodeTokens uses', async () => {
      mockDecode.mockReturnValue(new TextEncoder().encode('test'));

      await tokenizer.decodeTokens([1], 'gpt-4o');

      expect(mockGetEncoding).toHaveBeenCalledWith('o200k_base');
    });

    it('refuses to decode once shutting down', async () => {
      tokenizer.clearCache();

      await expect(tokenizer.decodeTokens([1])).rejects.toThrow('TiktokenTokenizer is shutting down');
    });
  });

  describe('clearCache', () => {
    it('should free all encoders and clear cache', async () => {
      await tokenizer.countTokens('test1', 'gpt-4');
      await tokenizer.countTokens('test2', 'gpt-4o');

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
      await tokenizer.warmUpCache(['gpt-4', 'gpt-3.5-turbo', 'gpt-4o']);

      const stats = tokenizer.getCacheStats();
      expect(stats.keys.sort()).toEqual(['cl100k_base', 'o200k_base']);
    });

    it('should handle errors during warm up', async () => {
      mockGetEncoding.mockImplementationOnce(() => {
        throw new Error('WASM init failed');
      });

      await expect(tokenizer.warmUpCache(['gpt-4'])).resolves.toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to warm up cache for model gpt-4'),
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
