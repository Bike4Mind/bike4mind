import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MANAGEMENT_RATE_LIMIT,
  buildRateLimitKeys,
  checkApiKeyRateLimit,
  evaluateCounterLockout,
  extractApiKeyFromHeaders,
  getApiKeyRateLimitUsage,
  resetApiKeyRateLimit,
  resolveCounterLimit,
} from './apiKeyRateLimitCheck';
import { cacheRepository } from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';

// Mock dependencies
vi.mock('@bike4mind/database', () => ({
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: vi.fn(),
    decrementCounter: vi.fn(),
    deleteByKey: vi.fn(),
    deleteByKeyAndReturn: vi.fn(),
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

    describe('meterDailyLimit: false (exempt reads)', () => {
      it('should not increment the day counter and report day usage from a read', async () => {
        // Minute increment succeeds; day counter must NOT be touched.
        vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow).mockResolvedValueOnce({
          success: true,
          count: 2,
          expiresAt: future(MINUTE_MS),
        });
        // Existing day counter (from prior POST submissions) is read, not incremented.
        vi.mocked(cacheRepository.findByKey).mockResolvedValueOnce({
          key: `api-key-rate-limit:${mockKeyId}:day`,
          result: { count: 40 },
          expiresAt: future(DAY_MS),
        } as never);

        const result = await checkApiKeyRateLimit(mockKeyId, mockRateLimit, mockContext, {
          meterDailyLimit: false,
        });

        expect(result.allowed).toBe(true);
        // Only the minute counter was incremented (day was read, not incremented).
        expect(cacheRepository.tryIncrementWithinLimitFixedWindow).toHaveBeenCalledTimes(1);
        expect(cacheRepository.tryIncrementWithinLimitFixedWindow).toHaveBeenCalledWith(
          expect.stringContaining(':minute'),
          mockRateLimit.requestsPerMinute,
          MINUTE_MS
        );
        expect(cacheRepository.findByKey).toHaveBeenCalledWith(expect.stringContaining(':day'));
        // Day headers reflect the read value without consuming a slot.
        expect(result.headers['X-RateLimit-Remaining-Minute']).toBe(3); // 5 - 2
        expect(result.headers['X-RateLimit-Remaining-Day']).toBe(60); // 100 - 40, unchanged by this read
      });

      it('should report a full day quota when no day counter exists yet', async () => {
        vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow).mockResolvedValueOnce({
          success: true,
          count: 1,
          expiresAt: future(MINUTE_MS),
        });
        vi.mocked(cacheRepository.findByKey).mockResolvedValueOnce(null as never);

        const result = await checkApiKeyRateLimit(mockKeyId, mockRateLimit, mockContext, {
          meterDailyLimit: false,
        });

        expect(result.allowed).toBe(true);
        expect(result.headers['X-RateLimit-Remaining-Day']).toBe(100); // full quota, nothing consumed
      });

      it('should still enforce the per-minute burst limit on exempt reads', async () => {
        // Even exempt reads count toward the minute limit, so a runaway poll is throttled.
        vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow).mockResolvedValueOnce({
          success: false,
          count: 5,
          expiresAt: future(MINUTE_MS),
        });

        const result = await checkApiKeyRateLimit(mockKeyId, mockRateLimit, mockContext, {
          meterDailyLimit: false,
        });

        expect(result.allowed).toBe(false);
        expect(result.limitType).toBe('minute');
        // Day counter never consulted once the minute limit rejects.
        expect(cacheRepository.findByKey).not.toHaveBeenCalled();
      });
    });

    describe("counter: 'management'", () => {
      it('charges its own keys and ceilings, so an exhausted request window cannot block it', async () => {
        // Both increments succeed: the request-quota day counter is a different
        // cache key, so the key being at its daily ceiling is not consulted here.
        vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow)
          .mockResolvedValueOnce({ success: true, count: 1, expiresAt: future(MINUTE_MS) })
          .mockResolvedValueOnce({ success: true, count: 1, expiresAt: future(DAY_MS) });

        // Configured ABOVE the management ceiling on both axes, so the header
        // assertions below can actually fail if a reported limit ever
        // regresses to the enforced one (mockRateLimit's per-minute value is
        // 5, identical to the management ceiling, and would hide that).
        const configured = { requestsPerMinute: 30, requestsPerDay: 100 };
        const result = await checkApiKeyRateLimit(mockKeyId, configured, mockContext, { counter: 'management' });

        expect(result.allowed).toBe(true);
        const keys = vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow).mock.calls.map(call => call[0]);
        expect(keys).toEqual([
          `api-key-rate-limit:${mockKeyId}:management:minute`,
          `api-key-rate-limit:${mockKeyId}:management:day`,
        ]);
        // Ceilings enforced (and consumed) are the management ones, not the
        // key's configured 30/100.
        const limits = vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow).mock.calls.map(call => call[1]);
        expect(limits).toEqual([MANAGEMENT_RATE_LIMIT.requestsPerMinute, MANAGEMENT_RATE_LIMIT.requestsPerDay]);
        // But the advertised Limit header is the key's own configured value -
        // a caller reading this back after mutating its own quota should see
        // what it configured, not the fixed management ceiling that actually
        // paid for the request.
        expect(result.headers['X-RateLimit-Limit-Day']).toBe(configured.requestsPerDay);
        expect(result.headers['X-RateLimit-Limit-Minute']).toBe(configured.requestsPerMinute);
        // Remaining still reflects the enforced ceiling, since that's what
        // actually governs the next 429.
        expect(result.headers['X-RateLimit-Remaining-Day']).toBe(MANAGEMENT_RATE_LIMIT.requestsPerDay - 1);
        expect(result.headers['X-RateLimit-Remaining-Minute']).toBe(MANAGEMENT_RATE_LIMIT.requestsPerMinute - 1);
      });

      it('never advertises more remaining than the limit it reports', async () => {
        // A key configured BELOW the management ceiling (limits validate at
        // min 1): without clamping, the enforced 5/50 headroom would be
        // reported against an advertised 2/10.
        const tightlyConfigured = { requestsPerMinute: 2, requestsPerDay: 10 };
        vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow)
          .mockResolvedValueOnce({ success: true, count: 1, expiresAt: future(MINUTE_MS) })
          .mockResolvedValueOnce({ success: true, count: 1, expiresAt: future(DAY_MS) });

        const result = await checkApiKeyRateLimit(mockKeyId, tightlyConfigured, mockContext, {
          counter: 'management',
        });

        expect(result.headers['X-RateLimit-Remaining-Minute']).toBe(tightlyConfigured.requestsPerMinute);
        expect(result.headers['X-RateLimit-Remaining-Day']).toBe(tightlyConfigured.requestsPerDay);
        expect(result.headers['X-RateLimit-Remaining-Minute']).toBeLessThanOrEqual(
          result.headers['X-RateLimit-Limit-Minute']
        );
        expect(result.headers['X-RateLimit-Remaining-Day']).toBeLessThanOrEqual(
          result.headers['X-RateLimit-Limit-Day']
        );
      });

      it('still rejects once the management quota itself is exhausted', async () => {
        vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow)
          .mockResolvedValueOnce({ success: true, count: 1, expiresAt: future(MINUTE_MS) })
          .mockResolvedValueOnce({
            success: false,
            count: MANAGEMENT_RATE_LIMIT.requestsPerDay,
            expiresAt: future(DAY_MS),
          });

        const result = await checkApiKeyRateLimit(mockKeyId, mockRateLimit, mockContext, { counter: 'management' });

        expect(result.allowed).toBe(false);
        expect(result.limitType).toBe('day');
        expect(result.error).toContain(`${MANAGEMENT_RATE_LIMIT.requestsPerDay} requests per day`);
      });

      it('leaves the default counter on its original unnamespaced keys', () => {
        expect(buildRateLimitKeys(mockKeyId)).toEqual(buildRateLimitKeys(mockKeyId, 'request'));
        expect(buildRateLimitKeys(mockKeyId, 'request')).toEqual({
          minuteKey: `api-key-rate-limit:${mockKeyId}:minute`,
          dayKey: `api-key-rate-limit:${mockKeyId}:day`,
        });
      });
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
      vi.mocked(cacheRepository.deleteByKeyAndReturn).mockResolvedValue(null);

      await resetApiKeyRateLimit(mockKeyId);

      expect(cacheRepository.deleteByKeyAndReturn).toHaveBeenCalledTimes(2);
      expect(cacheRepository.deleteByKeyAndReturn).toHaveBeenCalledWith(`api-key-rate-limit:${mockKeyId}:minute`);
      expect(cacheRepository.deleteByKeyAndReturn).toHaveBeenCalledWith(`api-key-rate-limit:${mockKeyId}:day`);
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

    it('leaves the management counter untouched by default', async () => {
      vi.mocked(cacheRepository.deleteByKeyAndReturn).mockResolvedValue(null);

      const result = await resetApiKeyRateLimit(mockKeyId);

      expect(cacheRepository.deleteByKeyAndReturn).toHaveBeenCalledTimes(2);
      const { minuteKey, dayKey } = buildRateLimitKeys(mockKeyId, 'management');
      expect(cacheRepository.deleteByKeyAndReturn).not.toHaveBeenCalledWith(minuteKey);
      expect(cacheRepository.deleteByKeyAndReturn).not.toHaveBeenCalledWith(dayKey);
      expect(result.management).toBeUndefined();
    });

    it('also clears the management counter when alsoResetManagement is set', async () => {
      vi.mocked(cacheRepository.deleteByKeyAndReturn).mockResolvedValue(null);

      await resetApiKeyRateLimit(mockKeyId, { alsoResetManagement: true });

      expect(cacheRepository.deleteByKeyAndReturn).toHaveBeenCalledTimes(4);
      const request = buildRateLimitKeys(mockKeyId);
      const management = buildRateLimitKeys(mockKeyId, 'management');
      expect(cacheRepository.deleteByKeyAndReturn).toHaveBeenCalledWith(request.minuteKey);
      expect(cacheRepository.deleteByKeyAndReturn).toHaveBeenCalledWith(request.dayKey);
      expect(cacheRepository.deleteByKeyAndReturn).toHaveBeenCalledWith(management.minuteKey);
      expect(cacheRepository.deleteByKeyAndReturn).toHaveBeenCalledWith(management.dayKey);
    });

    it('derives usage from the document it actually deleted, never a separate read', async () => {
      // Closes the race a concurrent increment could otherwise exploit: if
      // this derived a value from a prior `findByKey` and the counter was
      // bumped between that read and the delete, the reported usage would be
      // stale. Asserting `findByKey` is never called proves there is no such
      // separate read to race against - the deleted document IS the report.
      vi.mocked(cacheRepository.deleteByKeyAndReturn)
        .mockResolvedValueOnce({ result: { count: 60 }, expiresAt: future(MINUTE_MS) } as never) // request minute, at ceiling
        .mockResolvedValueOnce({ result: { count: 200 }, expiresAt: future(DAY_MS) } as never); // request day

      const result = await resetApiKeyRateLimit(mockKeyId);

      expect(result.request).toEqual({
        minute: 60,
        day: 200,
        minuteResetAt: Math.floor(future(MINUTE_MS).getTime() / 1000),
        dayResetAt: Math.floor(future(DAY_MS).getTime() / 1000),
      });
      expect(cacheRepository.findByKey).not.toHaveBeenCalled();
    });

    it('reports a missing counter document as usage 0', async () => {
      vi.mocked(cacheRepository.deleteByKeyAndReturn).mockResolvedValue(null);

      const result = await resetApiKeyRateLimit(mockKeyId);

      expect(result.request).toEqual({ minute: 0, day: 0 });
    });

    it('reports an expired-but-uncleaned counter document as usage 0', async () => {
      // deleteByKeyAndReturn has no expiresAt predicate (unlike findByKey), so it can return a
      // doc Mongo's TTL sweeper hasn't gotten to yet. readCounter's expiry check must still treat
      // that as an already-closed window, not report its stale count.
      vi.mocked(cacheRepository.deleteByKeyAndReturn).mockResolvedValue({
        result: { count: 60 },
        expiresAt: new Date(Date.now() - 1000),
      } as never);

      const result = await resetApiKeyRateLimit(mockKeyId);

      expect(result.request).toEqual({ minute: 0, day: 0 });
    });

    it('still clears and reports the request counter when clearing management fails, and logs the failure', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const request = buildRateLimitKeys(mockKeyId);
      const management = buildRateLimitKeys(mockKeyId, 'management');
      vi.mocked(cacheRepository.deleteByKeyAndReturn).mockImplementation(async key => {
        if (key === management.minuteKey || key === management.dayKey) {
          throw new Error('cache unavailable');
        }
        return null;
      });

      const result = await resetApiKeyRateLimit(mockKeyId, { alsoResetManagement: true });

      expect(result.request).toEqual({ minute: 0, day: 0 });
      expect(result.management).toBeUndefined();
      expect(cacheRepository.deleteByKeyAndReturn).toHaveBeenCalledWith(request.minuteKey);
      expect(cacheRepository.deleteByKeyAndReturn).toHaveBeenCalledWith(request.dayKey);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(mockKeyId));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('management'));
      warnSpy.mockRestore();
    });

    it('still clears and reports the management counter when clearing the request counter fails', async () => {
      // The mirror of the case above - this is the exact scenario the admin
      // reset endpoint exists for: an operator must still be able to recover
      // the management counter even if the request counter's clear hiccups.
      const request = buildRateLimitKeys(mockKeyId);
      const management = buildRateLimitKeys(mockKeyId, 'management');
      vi.mocked(cacheRepository.deleteByKeyAndReturn).mockImplementation(async key => {
        if (key === request.minuteKey || key === request.dayKey) {
          throw new Error('cache unavailable');
        }
        return null;
      });

      const result = await resetApiKeyRateLimit(mockKeyId, { alsoResetManagement: true });

      expect(result.request).toBeUndefined();
      expect(result.management).toEqual({ minute: 0, day: 0 });
      expect(cacheRepository.deleteByKeyAndReturn).toHaveBeenCalledWith(management.minuteKey);
      expect(cacheRepository.deleteByKeyAndReturn).toHaveBeenCalledWith(management.dayKey);
    });

    it('rejects when every attempted counter fails to clear anything, instead of reporting success', async () => {
      // A reset that clears nothing must not look like a reset that succeeded - the caller
      // (the admin route) needs this to surface as a failure, not a 200 with a hollow lockout.
      vi.mocked(cacheRepository.deleteByKeyAndReturn).mockRejectedValue(new Error('cache unavailable'));

      await expect(resetApiKeyRateLimit(mockKeyId, { alsoResetManagement: true })).rejects.toThrow(
        /failed to clear any rate-limit counters/i
      );
    });

    it('rejects when the only attempted group (no alsoResetManagement) fails to clear anything', async () => {
      vi.mocked(cacheRepository.deleteByKeyAndReturn).mockRejectedValue(new Error('cache unavailable'));

      await expect(resetApiKeyRateLimit(mockKeyId)).rejects.toThrow(/failed to clear any rate-limit counters/i);
    });

    it('reports the whole counter as unverified, not usage 0, when only one of its two windows fails', async () => {
      // A rejected day delete means the day window was never actually read - reporting it as 0
      // would fabricate "not at ceiling" for a counter that might still be at its limit. Only
      // when BOTH windows clear does the counter get a real reported usage.
      const { minuteKey, dayKey } = buildRateLimitKeys(mockKeyId);
      vi.mocked(cacheRepository.deleteByKeyAndReturn).mockImplementation(async key => {
        if (key === minuteKey) return { result: { count: 4 }, expiresAt: future(MINUTE_MS) } as never;
        if (key === dayKey) throw new Error('cache unavailable');
        return null;
      });

      const result = await resetApiKeyRateLimit(mockKeyId);

      expect(result.request).toBeUndefined();
    });

    it('does not treat a single-leg failure as total failure when the sibling leg genuinely removed a document', async () => {
      // The one attempted counter's usage is unverifiable (see above), but the minute delete DID
      // remove a real document - that is genuine progress and must not read as "nothing cleared
      // anywhere".
      const { minuteKey, dayKey } = buildRateLimitKeys(mockKeyId);
      vi.mocked(cacheRepository.deleteByKeyAndReturn).mockImplementation(async key => {
        if (key === minuteKey) return { result: { count: 4 }, expiresAt: future(MINUTE_MS) } as never;
        if (key === dayKey) throw new Error('cache unavailable');
        return null;
      });

      await expect(resetApiKeyRateLimit(mockKeyId)).resolves.toEqual({ request: undefined, management: undefined });
    });

    it('treats a fulfilled-null sibling next to a rejection as no progress, and rejects the whole reset', async () => {
      // A fulfilled `null` means "no document existed" - it proves nothing about whether the
      // REJECTED leg's document existed and was at its ceiling. Before this fix, a rejected
      // minute delete next to a null-fulfilled day delete still read as "cleared", so a reset
      // that removed nothing could report 200 success.
      const { minuteKey, dayKey } = buildRateLimitKeys(mockKeyId);
      vi.mocked(cacheRepository.deleteByKeyAndReturn).mockImplementation(async key => {
        if (key === minuteKey) throw new Error('cache unavailable');
        if (key === dayKey) return null;
        return null;
      });

      await expect(resetApiKeyRateLimit(mockKeyId)).rejects.toThrow(/failed to clear any rate-limit counters/i);
    });
  });

  describe('getApiKeyRateLimitUsage', () => {
    it('reads both counters by their canonical keys', async () => {
      const minuteDoc = { result: { count: 3 }, expiresAt: future(MINUTE_MS) };
      const dayDoc = { result: { count: 42 }, expiresAt: future(DAY_MS) };
      vi.mocked(cacheRepository.findByKey).mockResolvedValueOnce(minuteDoc).mockResolvedValueOnce(dayDoc);

      const usage = await getApiKeyRateLimitUsage(mockKeyId);

      expect(usage).toEqual({
        minute: 3,
        day: 42,
        minuteResetAt: Math.floor(minuteDoc.expiresAt.getTime() / 1000),
        dayResetAt: Math.floor(dayDoc.expiresAt.getTime() / 1000),
      });
      const { minuteKey, dayKey } = buildRateLimitKeys(mockKeyId);
      const queried = vi.mocked(cacheRepository.findByKey).mock.calls.map(call => call[0]);
      expect(new Set(queried)).toEqual(new Set([minuteKey, dayKey]));
    });

    it('reads a missing counter doc as 0', async () => {
      vi.mocked(cacheRepository.findByKey).mockResolvedValue(null);
      expect(await getApiKeyRateLimitUsage(mockKeyId)).toEqual({ minute: 0, day: 0 });
    });

    it('reads an expired window (awaiting TTL cleanup) as 0', async () => {
      const dayDoc = { result: { count: 500 }, expiresAt: future(DAY_MS) };
      vi.mocked(cacheRepository.findByKey)
        .mockResolvedValueOnce({ result: { count: 60 }, expiresAt: new Date(Date.now() - 1) })
        .mockResolvedValueOnce(dayDoc);

      // Expired minute window -> 0 with no reset; live day window keeps its reset.
      expect(await getApiKeyRateLimitUsage(mockKeyId)).toEqual({
        minute: 0,
        day: 500,
        dayResetAt: Math.floor(dayDoc.expiresAt.getTime() / 1000),
      });
    });

    it('reads a malformed counter doc as 0', async () => {
      vi.mocked(cacheRepository.findByKey)
        .mockResolvedValueOnce({ result: 'not-a-counter', expiresAt: future(MINUTE_MS) })
        .mockResolvedValueOnce({ expiresAt: future(DAY_MS) });

      expect(await getApiKeyRateLimitUsage(mockKeyId)).toEqual({ minute: 0, day: 0 });
    });

    it('always reads the request counter - no callers need a management-scoped read', async () => {
      // Both production callers (api-usage.ts, admin user-api-keys.ts) only ever read the
      // request counter; the admin reset's management diagnostic comes from
      // resetApiKeyRateLimit's own atomic delete instead. Pinning the request-only keys here
      // guards against that param quietly coming back as unused, untested surface.
      const minuteDoc = { result: { count: 2 }, expiresAt: future(MINUTE_MS) };
      const dayDoc = { result: { count: 10 }, expiresAt: future(DAY_MS) };
      vi.mocked(cacheRepository.findByKey).mockResolvedValueOnce(minuteDoc).mockResolvedValueOnce(dayDoc);

      const usage = await getApiKeyRateLimitUsage(mockKeyId);

      expect(usage).toEqual({
        minute: 2,
        day: 10,
        minuteResetAt: Math.floor(minuteDoc.expiresAt.getTime() / 1000),
        dayResetAt: Math.floor(dayDoc.expiresAt.getTime() / 1000),
      });
      const { minuteKey, dayKey } = buildRateLimitKeys(mockKeyId);
      const queried = vi.mocked(cacheRepository.findByKey).mock.calls.map(call => call[0]);
      expect(new Set(queried)).toEqual(new Set([minuteKey, dayKey]));
    });
  });

  describe('evaluateCounterLockout', () => {
    const limit = { requestsPerMinute: 5, requestsPerDay: 50 };

    it('reports neither window at limit when usage is under both ceilings', () => {
      expect(evaluateCounterLockout({ minute: 2, day: 30 }, limit)).toEqual({
        minuteAtLimit: false,
        dayAtLimit: false,
      });
    });

    it('reports the minute window at limit when usage meets or exceeds it', () => {
      expect(evaluateCounterLockout({ minute: 5, day: 30 }, limit)).toEqual({
        minuteAtLimit: true,
        dayAtLimit: false,
      });
    });

    it('reports the day window at limit when usage meets or exceeds it', () => {
      expect(evaluateCounterLockout({ minute: 2, day: 50 }, limit)).toEqual({
        minuteAtLimit: false,
        dayAtLimit: true,
      });
    });

    it('reports both windows at limit when usage exceeds both ceilings', () => {
      expect(evaluateCounterLockout({ minute: 9, day: 99 }, limit)).toEqual({
        minuteAtLimit: true,
        dayAtLimit: true,
      });
    });
  });

  describe('resolveCounterLimit', () => {
    it("returns the key's own configured limit for 'request'", () => {
      expect(resolveCounterLimit('request', mockRateLimit)).toBe(mockRateLimit);
    });

    it("returns the fixed MANAGEMENT_RATE_LIMIT for 'management', ignoring the key's own limit", () => {
      expect(resolveCounterLimit('management', mockRateLimit)).toBe(MANAGEMENT_RATE_LIMIT);
    });

    it('MANAGEMENT_RATE_LIMIT is 5/min, 50/day', () => {
      // The identity check above only pins that resolveCounterLimit returns this exact object -
      // it says nothing about what the policy value actually is, so a change to the constant
      // itself has no regression guard without asserting the literal.
      expect(MANAGEMENT_RATE_LIMIT).toEqual({ requestsPerMinute: 5, requestsPerDay: 50 });
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
