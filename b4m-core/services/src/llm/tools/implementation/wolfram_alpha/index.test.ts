import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateQueryParams, wolframAlphaQuery, WolframAlphaParams } from './index';

// Mock the apiKeyService
vi.mock('../../../../apiKeyService', () => ({
  getWolframAlphaKey: vi.fn(),
}));

import { getWolframAlphaKey } from '../../../../apiKeyService';

describe('wolfram_alpha', () => {
  const mockLogger = {
    log: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };

  const mockAdapters = {
    db: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('validateQueryParams', () => {
    it('should return null for valid query', () => {
      const result = validateQueryParams({ query: 'What is 2+2?' });
      expect(result).toBeNull();
    });

    it('should return error for missing query', () => {
      const result = validateQueryParams({} as WolframAlphaParams);
      expect(result).toBe('Invalid query parameter: query must be a non-empty string.');
    });

    it('should return error for null query', () => {
      const result = validateQueryParams({ query: null } as unknown as WolframAlphaParams);
      expect(result).toBe('Invalid query parameter: query must be a non-empty string.');
    });

    it('should return error for non-string query', () => {
      const result = validateQueryParams({ query: 123 } as unknown as WolframAlphaParams);
      expect(result).toBe('Invalid query parameter: query must be a non-empty string.');
    });

    it('should return error for empty string query', () => {
      const result = validateQueryParams({ query: '' });
      expect(result).toBe('Invalid query parameter: query must be a non-empty string.');
    });

    it('should return error for whitespace-only query', () => {
      const result = validateQueryParams({ query: '   ' });
      expect(result).toBe('Query cannot be empty.');
    });

    it('should return error for query exceeding max length', () => {
      const longQuery = 'a'.repeat(501);
      const result = validateQueryParams({ query: longQuery });
      expect(result).toBe('Query is too long. Maximum 500 characters allowed.');
    });

    it('should accept query at max length', () => {
      const maxQuery = 'a'.repeat(500);
      const result = validateQueryParams({ query: maxQuery });
      expect(result).toBeNull();
    });
  });

  describe('wolframAlphaQuery', () => {
    describe('missing API key', () => {
      it('should return error message when API key is not configured', async () => {
        vi.mocked(getWolframAlphaKey).mockResolvedValue(null);

        const result = await wolframAlphaQuery(mockAdapters, { query: 'test query' }, mockLogger);

        expect(result).toBe(
          'Wolfram Alpha is not configured. Please contact your administrator to set up the WolframAlphaKey in admin settings.'
        );
        expect(mockLogger.error).toHaveBeenCalledWith('Wolfram Alpha: No API key configured');
      });
    });

    describe('input validation', () => {
      it('should return validation error for invalid query', async () => {
        const result = await wolframAlphaQuery(mockAdapters, { query: '' }, mockLogger);

        expect(result).toBe('Invalid query parameter: query must be a non-empty string.');
        expect(mockLogger.error).toHaveBeenCalledWith('Wolfram Alpha: Validation failed', {
          error: 'Invalid query parameter: query must be a non-empty string.',
        });
      });

      it('should not call API when validation fails', async () => {
        vi.mocked(getWolframAlphaKey).mockResolvedValue('test-key');
        const fetchSpy = vi.spyOn(global, 'fetch');

        await wolframAlphaQuery(mockAdapters, { query: '' }, mockLogger);

        expect(fetchSpy).not.toHaveBeenCalled();
      });
    });

    describe('successful response', () => {
      beforeEach(() => {
        vi.mocked(getWolframAlphaKey).mockResolvedValue('test-app-id');
      });

      it('should return result from Wolfram Alpha', async () => {
        const mockResponse = 'The answer is 4';
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: () => Promise.resolve(mockResponse),
        });

        const resultPromise = wolframAlphaQuery(mockAdapters, { query: '2+2' }, mockLogger);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result).toBe('The answer is 4');
        expect(mockLogger.log).toHaveBeenCalledWith('🔢 Wolfram Alpha: Querying:', '2+2');
        expect(mockLogger.log).toHaveBeenCalledWith('📡 Wolfram Alpha: Response status:', 200);
      });

      it('should trim query before sending', async () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: () => Promise.resolve('result'),
        });

        const resultPromise = wolframAlphaQuery(mockAdapters, { query: '  2+2  ' }, mockLogger);
        await vi.runAllTimersAsync();
        await resultPromise;

        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('input=2%2B2'), expect.any(Object));
      });

      it('should include maxchars parameter when provided', async () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: () => Promise.resolve('result'),
        });

        const resultPromise = wolframAlphaQuery(mockAdapters, { query: '2+2', maxchars: 1000 }, mockLogger);
        await vi.runAllTimersAsync();
        await resultPromise;

        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('maxchars=1000'), expect.any(Object));
      });

      it('should return fallback message for empty response', async () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: () => Promise.resolve(''),
        });

        const resultPromise = wolframAlphaQuery(mockAdapters, { query: '2+2' }, mockLogger);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result).toBe('No results from Wolfram Alpha.');
      });
    });

    describe('response size limiting', () => {
      beforeEach(() => {
        vi.mocked(getWolframAlphaKey).mockResolvedValue('test-app-id');
      });

      it('should truncate response to MAX_RESPONSE_SIZE (50000)', async () => {
        const largeResponse = 'a'.repeat(60000);
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: () => Promise.resolve(largeResponse),
        });

        const resultPromise = wolframAlphaQuery(mockAdapters, { query: '2+2' }, mockLogger);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result.length).toBe(50000);
      });

      it('should use maxchars if smaller than MAX_RESPONSE_SIZE', async () => {
        const response = 'a'.repeat(2000);
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: () => Promise.resolve(response),
        });

        const resultPromise = wolframAlphaQuery(mockAdapters, { query: '2+2', maxchars: 1000 }, mockLogger);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result.length).toBe(1000);
      });

      it('should cap maxchars at MAX_RESPONSE_SIZE even if larger value provided', async () => {
        const largeResponse = 'a'.repeat(100000);
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: () => Promise.resolve(largeResponse),
        });

        const resultPromise = wolframAlphaQuery(mockAdapters, { query: '2+2', maxchars: 100000 }, mockLogger);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result.length).toBe(50000);
      });
    });

    describe('HTTP error handling', () => {
      beforeEach(() => {
        vi.mocked(getWolframAlphaKey).mockResolvedValue('test-app-id');
      });

      it('should return specific message for 501 error (query not understood)', async () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 501,
          statusText: 'Not Implemented',
          text: () => Promise.resolve('Invalid input'),
        });

        const resultPromise = wolframAlphaQuery(mockAdapters, { query: 'gibberish' }, mockLogger);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result).toBe(
          `Wolfram Alpha could not interpret this query. This typically happens when:
1. The query combines multiple concepts that should be broken into simpler parts
2. The query is too vague or conversational
3. The query doesn't contain a specific computation or data lookup
4. The query asks about Wolfram Alpha's capabilities (meta-queries are not supported)

Try breaking compound queries into simpler steps, or send a concrete computational query like "integrate x^2 dx", "population of Japan 2023", or "convert 100 USD to EUR".

Wolfram Alpha responded: Invalid input`
        );
        expect(mockLogger.error).toHaveBeenCalledWith('Wolfram Alpha: API error', {
          status: 501,
          statusText: 'Not Implemented',
          errorText: 'Invalid input',
        });
      });

      it('should return specific message for 403 error (invalid API key)', async () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          text: () => Promise.resolve('Invalid appid'),
        });

        const resultPromise = wolframAlphaQuery(mockAdapters, { query: '2+2' }, mockLogger);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result).toBe('Wolfram Alpha API key is invalid or missing. Please contact your administrator.');
      });

      it('should return user-friendly message for 500 server errors', async () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: () => Promise.resolve('Unable to verify Ip'),
        });

        const resultPromise = wolframAlphaQuery(mockAdapters, { query: '2+2' }, mockLogger);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result).toBe(
          "Wolfram Alpha encountered a temporary server error. This is usually a transient issue on Wolfram Alpha's side. Please try your query again in a moment.\n\nWolfram Alpha responded: Unable to verify Ip"
        );
      });
    });

    describe('timeout handling', () => {
      beforeEach(() => {
        vi.mocked(getWolframAlphaKey).mockResolvedValue('test-app-id');
      });

      it('should return timeout message when request times out', async () => {
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';

        global.fetch = vi.fn().mockRejectedValue(abortError);

        const resultPromise = wolframAlphaQuery(mockAdapters, { query: '2+2' }, mockLogger);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result).toBe('Wolfram Alpha request timed out. Please try a simpler query.');
        expect(mockLogger.error).toHaveBeenCalledWith('Wolfram Alpha: Request timed out');
      });
    });

    describe('network error handling', () => {
      beforeEach(() => {
        vi.mocked(getWolframAlphaKey).mockResolvedValue('test-app-id');
      });

      it('should return generic error message for network failures', async () => {
        global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

        const resultPromise = wolframAlphaQuery(mockAdapters, { query: '2+2' }, mockLogger);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result).toBe('Failed to reach Wolfram Alpha. Please try again.');
        expect(mockLogger.error).toHaveBeenCalledWith('Wolfram Alpha: Fetch error', expect.any(Error));
      });
    });

    describe('logging without logger', () => {
      it('should not throw when logger is undefined', async () => {
        vi.mocked(getWolframAlphaKey).mockResolvedValue('test-app-id');
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: () => Promise.resolve('result'),
        });

        const resultPromise = wolframAlphaQuery(mockAdapters, { query: '2+2' });
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result).toBe('result');
      });
    });
  });
});
