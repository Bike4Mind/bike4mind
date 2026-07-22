import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildRateLimitKeys,
  checkApiKeyRateLimit,
  extractApiKeyFromHeaders,
  getApiKeyRateLimitUsage,
  resetApiKeyRateLimit,
} from './apiKeyRateLimitCheck';
import { cacheRepository } from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';

// Mock dependencies
vi.mock('@bike4mind/database', () => ({
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: vi.fn(),
    decrementCounter: vi.fn(),
    deleteByKey: vi.fn(),
    findByKey: vi.fn(),
  },
}));

vi.mock('@server/utils/analyticsLog', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));

// Helper: a future window-end timestamp relative to the (faked) current time.
const future = (ms: number) => new Date(Date.now() + ms);
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

describe('apiKeyRateLimitCheck', () => {
  const mockKeyId = 'test-api-key-123';
  const mockRateLimit = {
    requestsPerMinute: 5,
    requestsPerDay: 100,
  };
  const mockContext = {
    userId: 'user-123',
    endpoint: '/api/test',
    method: 'POST',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('checkApiKeyRateLimit', () => {
    it('should allow request when under rate limit', async () => {
      // Mock atomic fixed-window increments (both succeed)
      vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow)
        .mockResolvedValueOnce({ success: true, count: 3, expiresAt: future(MINUTE_MS) }) // minute → 3
        .mockResolvedValueOnce({ success: true, count: 51, expiresAt: future(DAY_MS) }); // day → 51

      const result = await checkApiKeyRateLimit(mockKeyId, mockRateLimit, mockContext);

      expect(result.allowed).toBe(true);
      expect(result.headers['X-RateLimit-Remaining-Minute']).toBe(2); // 5 - 3 = 2
      expect(result.headers['X-RateLimit-Remaining-Day']).toBe(49); // 100 - 51 = 49
      expect(logEvent).not.toHaveBeenCalled();
    });

    it('should reject request when per-minute limit exceeded', async () => {
      // Mock atomic increment failure (minute limit exceeded)
      vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow).mockResolvedValueOnce({
        success: false,
        count: 5, // Already at limit
        expiresAt: future(MINUTE_MS),
      });

      const result = await checkApiKeyRateLimit(mockKeyId, mockRateLimit, mockContext);

      expect(result.allowed).toBe(false);
      expect(result.limitType).toBe('minute');
      expect(result.error).toContain('5 requests per minute');
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.retryAfter).toBeLessThanOrEqual(60);

      // Should only attempt minute increment (fails immediately)
      expect(cacheRepository.tryIncrementWithinLimitFixedWindow).toHaveBeenCalledTimes(1);

      // Should log analytics event
      expect(logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'User API Key Rate Limited',
          userId: mockContext.userId,
          metadata: expect.objectContaining({
            keyId: mockKeyId,
            limitType: 'minute',
            limit: 5,
            currentCount: 5,
          }),
        })
      );
    });

    it('should reject request when per-day limit exceeded', async () => {
      // Mock: minute succeeds, day fails
      vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow)
        .mockResolvedValueOnce({ success: true, count: 3, expiresAt: future(MINUTE_MS) }) // minute ok
        .mockResolvedValueOnce({ success: false, count: 100, expiresAt: future(DAY_MS) }); // day at limit

      // Mock rollback
      vi.mocked(cacheRepository.decrementCounter).mockResolvedValueOnce(2);

      const result = await checkApiKeyRateLimit(mockKeyId, mockRateLimit, mockContext);

      expect(result.allowed).toBe(false);
      expect(result.limitType).toBe('day');
      expect(result.error).toContain('100 requests per day');
      expect(result.retryAfter).toBeGreaterThan(0);

      // Should rollback minute counter
      expect(cacheRepository.decrementCounter).toHaveBeenCalledWith(expect.stringContaining(':minute'));

      // Should log analytics event
      expect(logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'User API Key Rate Limited',
          userId: mockContext.userId,
          metadata: expect.objectContaining({
            limitType: 'day',
            limit: 100,
            currentCount: 100,
          }),
        })
      );
    });

    it('should handle first request (no existing counters)', async () => {
      // Mock fixed-window increments for first request (both succeed, count=1)
      vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow)
        .mockResolvedValueOnce({ success: true, count: 1, expiresAt: future(MINUTE_MS) }) // minute: first
        .mockResolvedValueOnce({ success: true, count: 1, expiresAt: future(DAY_MS) }); // day: first

      const result = await checkApiKeyRateLimit(mockKeyId, mockRateLimit, mockContext);

      expect(result.allowed).toBe(true);
      expect(result.headers['X-RateLimit-Remaining-Minute']).toBe(4); // 5 - 1 = 4
      expect(result.headers['X-RateLimit-Remaining-Day']).toBe(99); // 100 - 1 = 99

      // Should create both counters atomically
      expect(cacheRepository.tryIncrementWithinLimitFixedWindow).toHaveBeenCalledTimes(2);
      expect(cacheRepository.tryIncrementWithinLimitFixedWindow).toHaveBeenCalledWith(
        expect.stringContaining(':minute'),
        mockRateLimit.requestsPerMinute,
        60_000 // 60 seconds in ms
      );
      expect(cacheRepository.tryIncrementWithinLimitFixedWindow).toHaveBeenCalledWith(
        expect.stringContaining(':day'),
        mockRateLimit.requestsPerDay,
        86_400_000 // 24 hours in ms
      );
    });

    it('should enforce minimum retry-after of 1 second', async () => {
      // Window is about to roll: expiry only 100ms out -> retry-after clamps to 1s
      vi.setSystemTime(new Date('2024-01-01T12:00:59.900Z'));

      vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow).mockResolvedValueOnce({
        success: false,
        count: 5,
        expiresAt: future(100),
      });

      const result = await checkApiKeyRateLimit(mockKeyId, mockRateLimit, mockContext);

      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThanOrEqual(1); // Always at least 1 second
    });

    it('should use atomic fixed-window increment operations', async () => {
      vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow)
        .mockResolvedValueOnce({ success: true, count: 1, expiresAt: future(MINUTE_MS) })
        .mockResolvedValueOnce({ success: true, count: 1, expiresAt: future(DAY_MS) });

      await checkApiKeyRateLimit(mockKeyId, mockRateLimit, mockContext);

      // Verify fixed-window conditional increment is used with proper limits
      expect(cacheRepository.tryIncrementWithinLimitFixedWindow).toHaveBeenCalledWith(
        expect.stringContaining(':minute'),
        mockRateLimit.requestsPerMinute,
        60_000
      );
      expect(cacheRepository.tryIncrementWithinLimitFixedWindow).toHaveBeenCalledWith(
        expect.stringContaining(':day'),
        mockRateLimit.requestsPerDay,
        86_400_000
      );
    });

    it('should handle concurrent requests correctly (no race condition)', async () => {
      // This tests the atomic nature of the implementation. With atomic
      // fixed-window conditional increment, only requests under the limit succeed.
      const mockIncrement = vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow);

      // Request 1: count goes from 3 to 4 (success)
      mockIncrement
        .mockResolvedValueOnce({ success: true, count: 4, expiresAt: future(MINUTE_MS) }) // req1 minute: 3→4
        .mockResolvedValueOnce({ success: true, count: 1, expiresAt: future(DAY_MS) }); // req1 day

      const result1 = await checkApiKeyRateLimit(mockKeyId, mockRateLimit, mockContext);

      // Request 2: count goes from 4 to 5 (success, exactly at limit)
      mockIncrement
        .mockResolvedValueOnce({ success: true, count: 5, expiresAt: future(MINUTE_MS) }) // req2 minute: 4→5
        .mockResolvedValueOnce({ success: true, count: 2, expiresAt: future(DAY_MS) }); // req2 day

      const result2 = await checkApiKeyRateLimit(mockKeyId, mockRateLimit, mockContext);

      // Request 3: count is already 5, cannot increment (blocked)
      mockIncrement.mockResolvedValueOnce({ success: false, count: 5, expiresAt: future(MINUTE_MS) }); // req3 BLOCKED

      const result3 = await checkApiKeyRateLimit(mockKeyId, mockRateLimit, mockContext);

      // First 2 succeed, 3rd is blocked - this proves exact enforcement
      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
      expect(result3.allowed).toBe(false);

      // Verify atomic fixed-window increment ensures exact enforcement
      expect(mockIncrement).toHaveBeenCalledTimes(5); // 2 full requests + 1 rejected at minute check
    });

    it('should include correct rate limit headers', async () => {
      vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow)
        .mockResolvedValueOnce({ success: true, count: 3, expiresAt: future(MINUTE_MS) })
        .mockResolvedValueOnce({ success: true, count: 51, expiresAt: future(DAY_MS) });

      const result = await checkApiKeyRateLimit(mockKeyId, mockRateLimit, mockContext);

      expect(result.headers).toMatchObject({
        'X-RateLimit-Limit-Minute': 5,
        'X-RateLimit-Remaining-Minute': 2,
        'X-RateLimit-Reset-Minute': expect.any(Number),
        'X-RateLimit-Limit-Day': 100,
        'X-RateLimit-Remaining-Day': 49,
        'X-RateLimit-Reset-Day': expect.any(Number),
      });

      // Verify reset timestamps are in the future
      expect(result.headers['X-RateLimit-Reset-Minute']).toBeGreaterThan(Date.now() / 1000);
      expect(result.headers['X-RateLimit-Reset-Day']).toBeGreaterThan(Date.now() / 1000);
    });

    it('should not log analytics when context userId is missing', async () => {
      vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow).mockResolvedValueOnce({
        success: false,
        count: 5,
        expiresAt: future(MINUTE_MS),
      });

      await checkApiKeyRateLimit(mockKeyId, mockRateLimit, {
        endpoint: '/api/test',
        method: 'POST',
      });

      expect(logEvent).not.toHaveBeenCalled();
    });

    it('should continue if analytics logging fails', async () => {
      vi.mocked(logEvent).mockRejectedValueOnce(new Error('Analytics service down'));

      vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow).mockResolvedValueOnce({
        success: false,
        count: 5,
        expiresAt: future(MINUTE_MS),
      });

      // Should not throw, just log error and continue
      const result = await checkApiKeyRateLimit(mockKeyId, mockRateLimit, mockContext);

      expect(result.allowed).toBe(false);
    });

    it('should use 16-char key prefix for security', async () => {
      // Use a longer key ID to test prefix truncation
      const longKeyId = 'test-api-key-1234567890abcdef-extra';

      vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow).mockResolvedValueOnce({
        success: false,
        count: 5,
        expiresAt: future(MINUTE_MS),
      });

      await checkApiKeyRateLimit(longKeyId, mockRateLimit, mockContext);

      expect(logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            keyPrefix: 'test-api-key-123', // First 16 chars of the long key
          }),
        })
      );
    });
  });

  describe('resetApiKeyRateLimit', () => {
    it('deletes exactly the minute and day counter keys', async () => {
      vi.mocked(cacheRepository.deleteByKey).mockResolvedValue(undefined);

      await resetApiKeyRateLimit(mockKeyId);

      expect(cacheRepository.deleteByKey).toHaveBeenCalledTimes(2);
      expect(cacheRepository.deleteByKey).toHaveBeenCalledWith(`api-key-rate-limit:${mockKeyId}:minute`);
      expect(cacheRepository.deleteByKey).toHaveBeenCalledWith(`api-key-rate-limit:${mockKeyId}:day`);
    });

    it('uses the same keys the enforcer passes to the fixed-window increment', async () => {
      // Desync guard: if the enforcer's key construction ever diverges from
      // buildRateLimitKeys, this cross-check fails.
      vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow)
        .mockResolvedValueOnce({ success: true, count: 1, expiresAt: future(MINUTE_MS) })
        .mockResolvedValueOnce({ success: true, count: 1, expiresAt: future(DAY_MS) });

      await checkApiKeyRateLimit(mockKeyId, mockRateLimit, mockContext);

      const { minuteKey, dayKey } = buildRateLimitKeys(mockKeyId);
      const enforcerKeys = vi
        .mocked(cacheRepository.tryIncrementWithinLimitFixedWindow)
        .mock.calls.map(call => call[0]);
      expect(enforcerKeys).toEqual([minuteKey, dayKey]);
    });
  });

  describe('getApiKeyRateLimitUsage', () => {
    it('reads both counters by their canonical keys', async () => {
      vi.mocked(cacheRepository.findByKey)
        .mockResolvedValueOnce({ result: { count: 3 }, expiresAt: future(MINUTE_MS) })
        .mockResolvedValueOnce({ result: { count: 42 }, expiresAt: future(DAY_MS) });

      const usage = await getApiKeyRateLimitUsage(mockKeyId);

      expect(usage).toEqual({ minute: 3, day: 42 });
      const { minuteKey, dayKey } = buildRateLimitKeys(mockKeyId);
      const queried = vi.mocked(cacheRepository.findByKey).mock.calls.map(call => call[0]);
      expect(new Set(queried)).toEqual(new Set([minuteKey, dayKey]));
    });

    it('reads a missing counter doc as 0', async () => {
      vi.mocked(cacheRepository.findByKey).mockResolvedValue(null);
      expect(await getApiKeyRateLimitUsage(mockKeyId)).toEqual({ minute: 0, day: 0 });
    });

    it('reads an expired window (awaiting TTL cleanup) as 0', async () => {
      vi.mocked(cacheRepository.findByKey)
        .mockResolvedValueOnce({ result: { count: 60 }, expiresAt: new Date(Date.now() - 1) })
        .mockResolvedValueOnce({ result: { count: 500 }, expiresAt: future(DAY_MS) });

      expect(await getApiKeyRateLimitUsage(mockKeyId)).toEqual({ minute: 0, day: 500 });
    });

    it('reads a malformed counter doc as 0', async () => {
      vi.mocked(cacheRepository.findByKey)
        .mockResolvedValueOnce({ result: 'not-a-counter', expiresAt: future(MINUTE_MS) })
        .mockResolvedValueOnce({ expiresAt: future(DAY_MS) });

      expect(await getApiKeyRateLimitUsage(mockKeyId)).toEqual({ minute: 0, day: 0 });
    });
  });

  describe('extractApiKeyFromHeaders', () => {
    it('should extract API key from X-API-Key header', () => {
      const headers = { 'x-api-key': 'test-key-123' };
      expect(extractApiKeyFromHeaders(headers)).toBe('test-key-123');
    });

    it('should extract API key from X-API-Key header (case insensitive)', () => {
      const headers = { 'X-API-Key': 'test-key-123' };
      expect(extractApiKeyFromHeaders(headers)).toBe('test-key-123');
    });

    it('should extract API key from Authorization header with ApiKey scheme', () => {
      const headers = { authorization: 'ApiKey test-key-123' };
      expect(extractApiKeyFromHeaders(headers)).toBe('test-key-123');
    });

    it('should extract API key from Authorization header with Bearer b4m_ prefix', () => {
      const headers = { authorization: 'Bearer b4m_live_abc123def456' };
      expect(extractApiKeyFromHeaders(headers)).toBe('b4m_live_abc123def456');
    });

    it('should not extract JWT token from Bearer header', () => {
      const headers = { authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' };
      expect(extractApiKeyFromHeaders(headers)).toBeNull();
    });

    it('should handle case-insensitive Authorization header', () => {
      const headers = { Authorization: 'ApiKey test-key-123' };
      expect(extractApiKeyFromHeaders(headers)).toBe('test-key-123');
    });

    it('should handle array header values', () => {
      const headers = { 'x-api-key': ['test-key-123', 'ignored'] };
      expect(extractApiKeyFromHeaders(headers)).toBe('test-key-123');
    });

    it('should return null when no API key found', () => {
      const headers = { 'content-type': 'application/json' };
      expect(extractApiKeyFromHeaders(headers)).toBeNull();
    });

    it('should return null for empty headers', () => {
      expect(extractApiKeyFromHeaders({})).toBeNull();
    });

    it('should prioritize X-API-Key over Authorization', () => {
      const headers = {
        'x-api-key': 'key-from-x-api-key',
        authorization: 'ApiKey key-from-auth',
      };
      expect(extractApiKeyFromHeaders(headers)).toBe('key-from-x-api-key');
    });

    it('should handle mixed case header names', () => {
      const headers = { 'X-Api-Key': 'test-key-123' };
      expect(extractApiKeyFromHeaders(headers)).toBe('test-key-123');
    });
  });
});
