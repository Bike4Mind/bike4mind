import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

// Hoist mock functions so they're available during vi.mock()
const { mockUpdateOne, mockFindById, mockFind, mockFindOne, mockFindByIdAndUpdate, mockCreate, mockDeleteOne } =
  vi.hoisted(() => ({
    mockUpdateOne: vi.fn(),
    mockFindById: vi.fn(),
    mockFind: vi.fn(),
    mockFindOne: vi.fn(),
    mockFindByIdAndUpdate: vi.fn(),
    mockCreate: vi.fn(),
    mockDeleteOne: vi.fn(),
  }));

vi.mock('mongoose', async importOriginal => {
  const actual = await importOriginal<typeof mongoose>();
  return {
    ...actual,
    model: vi.fn(() => ({
      updateOne: mockUpdateOne,
      findById: mockFindById,
      find: mockFind,
      findOne: mockFindOne,
      findByIdAndUpdate: mockFindByIdAndUpdate,
      create: mockCreate,
      deleteOne: mockDeleteOne,
    })),
    models: {},
  };
});

// Import after mocks are set up
import { liveopsTriageConfigRepository } from '../LiveopsTriageConfigModel';

describe('LiveopsTriageConfigRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('atomicMarkRunStartedIfNotRecent', () => {
    const testConfigId = '507f1f77bcf86cd799439011';
    const idempotencyWindowMs = 5 * 60 * 1000; // 5 minutes

    it('returns true when lock is acquired (modifiedCount === 1)', async () => {
      mockUpdateOne.mockResolvedValue({ modifiedCount: 1, matchedCount: 1 });

      const result = await liveopsTriageConfigRepository.atomicMarkRunStartedIfNotRecent(
        testConfigId,
        idempotencyWindowMs
      );

      expect(result).toBe(true);
      expect(mockUpdateOne).toHaveBeenCalledTimes(1);

      // Verify the query uses atomic conditions
      const [query, update] = mockUpdateOne.mock.calls[0];
      expect(query._id).toBe(testConfigId);
      expect(query.$or).toBeDefined();
      expect(query.$or).toHaveLength(3); // null, not exists, or older than cutoff
      expect(update.$set.lastRunStartedAt).toBeInstanceOf(Date);
    });

    it('returns false when lock is not acquired (modifiedCount === 0)', async () => {
      mockUpdateOne.mockResolvedValue({ modifiedCount: 0, matchedCount: 1 });

      const result = await liveopsTriageConfigRepository.atomicMarkRunStartedIfNotRecent(
        testConfigId,
        idempotencyWindowMs
      );

      expect(result).toBe(false);
    });

    it('uses correct cutoff time based on idempotency window', async () => {
      const now = Date.now();
      vi.setSystemTime(now);

      mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });

      await liveopsTriageConfigRepository.atomicMarkRunStartedIfNotRecent(testConfigId, idempotencyWindowMs);

      const [query] = mockUpdateOne.mock.calls[0];
      const cutoffCondition = query.$or.find(
        (c: Record<string, unknown>) => c.lastRunStartedAt && '$lt' in (c.lastRunStartedAt as Record<string, unknown>)
      );

      expect(cutoffCondition).toBeDefined();
      const cutoffTime = (cutoffCondition.lastRunStartedAt as { $lt: Date }).$lt;
      // Cutoff should be approximately now - idempotencyWindowMs
      expect(cutoffTime.getTime()).toBeCloseTo(now - idempotencyWindowMs, -2); // Within 100ms

      vi.useRealTimers();
    });

    it('handles lastRunStartedAt being null', async () => {
      mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });

      await liveopsTriageConfigRepository.atomicMarkRunStartedIfNotRecent(testConfigId, idempotencyWindowMs);

      const [query] = mockUpdateOne.mock.calls[0];
      const nullCondition = query.$or.find((c: Record<string, unknown>) => c.lastRunStartedAt === null);
      expect(nullCondition).toBeDefined();
    });

    it('handles lastRunStartedAt not existing', async () => {
      mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });

      await liveopsTriageConfigRepository.atomicMarkRunStartedIfNotRecent(testConfigId, idempotencyWindowMs);

      const [query] = mockUpdateOne.mock.calls[0];
      const notExistsCondition = query.$or.find(
        (c: Record<string, unknown>) =>
          c.lastRunStartedAt && '$exists' in (c.lastRunStartedAt as Record<string, unknown>)
      );
      expect(notExistsCondition).toBeDefined();
      expect((notExistsCondition.lastRunStartedAt as { $exists: boolean }).$exists).toBe(false);
    });
  });

  describe('markRunComplete', () => {
    const testConfigId = '507f1f77bcf86cd799439011';

    it('clears lastRunStartedAt using $unset on completion', async () => {
      mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });

      await liveopsTriageConfigRepository.markRunComplete(testConfigId, {
        status: 'success',
        errorsProcessed: 10,
        issuesCreated: 2,
        issuesDeduplicated: 3,
      });

      const [, update] = mockUpdateOne.mock.calls[0];
      expect(update.$unset).toBeDefined();
      expect(update.$unset.lastRunStartedAt).toBe(1);
    });

    it('resets consecutiveFailures to 0 on success', async () => {
      mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });

      await liveopsTriageConfigRepository.markRunComplete(testConfigId, {
        status: 'success',
        errorsProcessed: 10,
        issuesCreated: 2,
        issuesDeduplicated: 3,
      });

      const [, update] = mockUpdateOne.mock.calls[0];
      expect(update.$set.consecutiveFailures).toBe(0);
    });

    it('increments consecutiveFailures on failure', async () => {
      mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });

      await liveopsTriageConfigRepository.markRunComplete(testConfigId, {
        status: 'failure',
        errorsProcessed: 0,
        issuesCreated: 0,
        issuesDeduplicated: 0,
        error: 'Test error',
      });

      const [, update] = mockUpdateOne.mock.calls[0];
      expect(update.$inc).toBeDefined();
      expect(update.$inc.consecutiveFailures).toBe(1);
    });

    it('avoids MongoDB conflict: $set and $inc never both modify consecutiveFailures', async () => {
      mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });

      // Test failure case - should use $inc, NOT $set for consecutiveFailures
      await liveopsTriageConfigRepository.markRunComplete(testConfigId, {
        status: 'failure',
        errorsProcessed: 0,
        issuesCreated: 0,
        issuesDeduplicated: 0,
        error: 'Test error',
      });

      const [, update] = mockUpdateOne.mock.calls[0];

      // Verify $set does NOT contain consecutiveFailures on failure
      expect(update.$set.consecutiveFailures).toBeUndefined();
      // Verify $inc DOES contain consecutiveFailures on failure
      expect(update.$inc.consecutiveFailures).toBe(1);
    });
  });
});
