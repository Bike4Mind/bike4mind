import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sreErrorTrackingRepository } from './SreErrorTrackingModel';

// We test the repository class by overriding the internal Mongoose model methods.
// This verifies the query construction and atomic CAS logic without a real DB.

describe('SreErrorTrackingRepository', () => {
  describe('claimRevision', () => {
    let mockFindOneAndUpdate: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFindOneAndUpdate = vi.fn();
      // Access the internal model and override findOneAndUpdate
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sreErrorTrackingRepository as any).model.findOneAndUpdate = mockFindOneAndUpdate;
    });

    it('queries with correct filter (status in [fixed, failed], has PR, revisionCount < max, not merged)', async () => {
      mockFindOneAndUpdate.mockResolvedValue(null);

      await sreErrorTrackingRepository.claimRevision('doc-1', 2);

      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: 'doc-1',
          status: { $in: ['fixed', 'failed', 'wont_fix'] },
          fixPrNumber: { $exists: true },
          revisionCount: { $lt: 2 },
          fixMergedAt: { $exists: false },
        },
        {
          $set: { status: 'revision_requested', githubRunDispatched: false },
          $inc: { revisionCount: 1 },
        },
        { returnDocument: 'after' }
      );
    });

    it('returns the document when claim succeeds', async () => {
      const doc = {
        _id: 'doc-1',
        id: 'doc-1',
        status: 'revision_requested',
        revisionCount: 1,
        toObject: () => ({
          id: 'doc-1',
          status: 'revision_requested',
          revisionCount: 1,
        }),
      };
      mockFindOneAndUpdate.mockResolvedValue(doc);

      const result = await sreErrorTrackingRepository.claimRevision('doc-1', 2);

      expect(result).toEqual({
        id: 'doc-1',
        status: 'revision_requested',
        revisionCount: 1,
      });
    });

    it('returns null when claim fails (status not fixed)', async () => {
      mockFindOneAndUpdate.mockResolvedValue(null);

      const result = await sreErrorTrackingRepository.claimRevision('doc-1', 2);

      expect(result).toBeNull();
    });

    it('returns null when revision cap is reached', async () => {
      mockFindOneAndUpdate.mockResolvedValue(null);

      const result = await sreErrorTrackingRepository.claimRevision('doc-1', 2);

      // The $lt filter in the query prevents matching when revisionCount >= 2
      expect(result).toBeNull();
    });

    it('resets githubRunDispatched in the update', async () => {
      mockFindOneAndUpdate.mockResolvedValue(null);

      await sreErrorTrackingRepository.claimRevision('doc-1', 3);

      const updateArg = mockFindOneAndUpdate.mock.calls[0][1];
      expect(updateArg.$set.githubRunDispatched).toBe(false);
    });

    it('increments revisionCount atomically', async () => {
      mockFindOneAndUpdate.mockResolvedValue(null);

      await sreErrorTrackingRepository.claimRevision('doc-1', 3);

      const updateArg = mockFindOneAndUpdate.mock.calls[0][1];
      expect(updateArg.$inc.revisionCount).toBe(1);
    });

    it('respects different maxRevisions values', async () => {
      mockFindOneAndUpdate.mockResolvedValue(null);

      await sreErrorTrackingRepository.claimRevision('doc-1', 5);

      const filterArg = mockFindOneAndUpdate.mock.calls[0][0];
      expect(filterArg.revisionCount.$lt).toBe(5);
    });
  });

  describe('countConsecutiveFailures', () => {
    let mockFind: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      const mockChain = {
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        lean: vi.fn(),
      };
      mockFind = vi.fn().mockReturnValue(mockChain);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sreErrorTrackingRepository as any).model.find = mockFind;
      // Store chain reference for easy access in tests
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sreErrorTrackingRepository as any)._mockChain = mockChain;
    });

    it('skips revision_requested without resetting counter', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain = (sreErrorTrackingRepository as any)._mockChain;
      chain.lean.mockResolvedValue([
        { status: 'failed' },
        { status: 'revision_requested' },
        { status: 'failed' },
        { status: 'fixed' },
      ]);

      const count = await sreErrorTrackingRepository.countConsecutiveFailures();

      // Two consecutive failures with revision_requested skipped in between
      expect(count).toBe(2);
    });

    it('skips already_fixed without resetting counter', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain = (sreErrorTrackingRepository as any)._mockChain;
      chain.lean.mockResolvedValue([
        { status: 'failed' },
        { status: 'already_fixed' },
        { status: 'failed' },
        { status: 'fixed' },
      ]);

      const count = await sreErrorTrackingRepository.countConsecutiveFailures();

      // already_fixed is an idempotency skip, not a system failure - must not reset the streak
      expect(count).toBe(2);
    });

    it('skips scope_blocked and approval_expired without resetting counter', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain = (sreErrorTrackingRepository as any)._mockChain;
      chain.lean.mockResolvedValue([
        { status: 'failed' },
        { status: 'scope_blocked' },
        { status: 'approval_expired' },
        { status: 'dispatch_failed' },
        { status: 'fixed' },
      ]);

      const count = await sreErrorTrackingRepository.countConsecutiveFailures();

      expect(count).toBe(2); // failed + dispatch_failed (scope_blocked and approval_expired skipped)
    });

    it('stops counting at non-failure, non-skip statuses', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain = (sreErrorTrackingRepository as any)._mockChain;
      chain.lean.mockResolvedValue([{ status: 'fixed' }, { status: 'failed' }]);

      const count = await sreErrorTrackingRepository.countConsecutiveFailures();

      expect(count).toBe(0); // 'fixed' breaks the streak
    });

    it('skips low_confidence without resetting counter', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain = (sreErrorTrackingRepository as any)._mockChain;
      chain.lean.mockResolvedValue([
        { status: 'failed' },
        { status: 'low_confidence' },
        { status: 'dispatch_failed' },
        { status: 'fixed' },
      ]);

      const count = await sreErrorTrackingRepository.countConsecutiveFailures();

      // low_confidence is an agent limitation, not a system failure - must not reset the streak
      expect(count).toBe(2); // failed + dispatch_failed (low_confidence skipped)
    });

    it('skips rate_limited without resetting counter', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain = (sreErrorTrackingRepository as any)._mockChain;
      chain.lean.mockResolvedValue([
        { status: 'failed' },
        { status: 'rate_limited' },
        { status: 'failed' },
        { status: 'fixed' },
      ]);

      const count = await sreErrorTrackingRepository.countConsecutiveFailures();

      // rate_limited is an operational throttle, not a system failure - must not reset the streak
      expect(count).toBe(2); // failed + failed (rate_limited skipped)
    });
  });
});
