import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import SreErrorTrackingModel, { sreErrorTrackingRepository } from '../SreErrorTrackingModel';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../../__test__/createMongoServer';

describe('SreErrorTrackingModel — recurrence queries', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await SreErrorTrackingModel.createIndexes();
  }, 30000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  }, 30000);

  beforeEach(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
  });

  describe('claimForAnalysis — recurrence alert-fatigue prevention', () => {
    it('returns null for a second occurrence when prior doc is already in recurrence_detected state', async () => {
      const fingerprint = 'fp-escalated';
      await SreErrorTrackingModel.create({
        errorFingerprint: fingerprint,
        source: 'CLOUDWATCH',
        sourceRef: 'log-group',
        status: 'recurrence_detected',
      });

      const result = await sreErrorTrackingRepository.claimForAnalysis(fingerprint, 'MillionOnMars/lumina5', {
        source: 'CLOUDWATCH',
        sourceRef: 'log-group',
      });

      expect(result).toBeNull();
    });
  });

  describe('findMergedFixesForFingerprint', () => {
    it('returns empty when no prior fixes exist', async () => {
      const results = await sreErrorTrackingRepository.findMergedFixesForFingerprint('fp-new', 14);
      expect(results).toEqual([]);
    });

    it('excludes fixes merged before the window', async () => {
      const fingerprint = 'fp-old';
      await SreErrorTrackingModel.create({
        errorFingerprint: fingerprint,
        source: 'CLOUDWATCH',
        sourceRef: 'log-group',
        status: 'fixed',
        fixPrNumber: 1000,
        fixMergedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      });
      const results = await sreErrorTrackingRepository.findMergedFixesForFingerprint(fingerprint, 14);
      expect(results).toHaveLength(0);
    });

    it('excludes documents not in fixed status', async () => {
      const fingerprint = 'fp-mixed';
      await SreErrorTrackingModel.create({
        errorFingerprint: fingerprint,
        source: 'CLOUDWATCH',
        sourceRef: 'log-group',
        status: 'analyzing',
        fixPrNumber: 5000,
        fixMergedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      });
      await SreErrorTrackingModel.create({
        errorFingerprint: fingerprint,
        source: 'CLOUDWATCH',
        sourceRef: 'log-group',
        status: 'failed',
        fixPrNumber: 5001,
        fixMergedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      });
      const results = await sreErrorTrackingRepository.findMergedFixesForFingerprint(fingerprint, 14);
      expect(results).toHaveLength(0);
    });

    it('excludes fixed documents without fixMergedAt', async () => {
      const fingerprint = 'fp-pending';
      await SreErrorTrackingModel.create({
        errorFingerprint: fingerprint,
        source: 'CLOUDWATCH',
        sourceRef: 'log-group',
        status: 'fixed',
        fixPrNumber: 6000,
      });
      const results = await sreErrorTrackingRepository.findMergedFixesForFingerprint(fingerprint, 14);
      expect(results).toHaveLength(0);
    });

    it('returns diagnosisResult + PR metadata for Layer 2 prompt injection', async () => {
      const fingerprint = 'fp-history';
      const now = Date.now();
      await SreErrorTrackingModel.create({
        errorFingerprint: fingerprint,
        source: 'CLOUDWATCH',
        sourceRef: 'log-group',
        status: 'fixed',
        fixPrNumber: 7769,
        fixMergedAt: new Date(now - 7 * 24 * 60 * 60 * 1000),
        diagnosisResult: {
          rootCause: 'Concurrency semaphore leak',
          proposedFix: 'Reduce limit 15 → 5',
          confidence: 80,
          riskAssessment: 'low',
          affectedFiles: [],
        },
      });

      const results = await sreErrorTrackingRepository.findMergedFixesForFingerprint(fingerprint, 14);
      expect(results).toHaveLength(1);
      expect(results[0].fixPrNumber).toBe(7769);
      expect(results[0].diagnosisResult?.proposedFix).toBe('Reduce limit 15 → 5');
    });
  });

  describe('countConsecutiveFailures', () => {
    // Helper: create a tracking doc and explicitly set updatedAt bypassing Mongoose
    // auto-timestamps. Needed because `timestamps: true` overrides any updatedAt
    // passed to create(), which breaks sort-order and cooldown-window assertions.
    async function createWithUpdatedAt(fingerprint: string, status: string, updatedAt: Date): Promise<void> {
      const doc = await SreErrorTrackingModel.create({
        errorFingerprint: fingerprint,
        source: 'CLOUDWATCH',
        sourceRef: 'log',
        status: status as never,
      });
      await SreErrorTrackingModel.updateOne({ _id: doc._id }, { $set: { updatedAt } }, { timestamps: false });
    }

    it('treats dismissed as neutral (skipped without resetting counter)', async () => {
      // Create docs in chronological order: [fixed, failed, dismissed, failed]
      // With updatedAt desc sort: [failed, dismissed, failed, fixed]
      // Expected: count=2 (dismissed skipped, chain broken at fixed)
      const base = Date.now();
      await createWithUpdatedAt('fp-a', 'fixed', new Date(base - 40_000));
      await createWithUpdatedAt('fp-b', 'failed', new Date(base - 30_000));
      await createWithUpdatedAt('fp-c', 'dismissed', new Date(base - 20_000));
      await createWithUpdatedAt('fp-d', 'failed', new Date(base - 10_000));

      const count = await sreErrorTrackingRepository.countConsecutiveFailures();
      expect(count).toBe(2);
    });

    it('treats wont_fix as a chain-breaker (stops counter)', async () => {
      // Sequence (updatedAt desc): [failed, wont_fix, failed]
      // wont_fix is a success-like outcome that breaks the consecutive-failure chain
      const base = Date.now();
      await createWithUpdatedAt('fp-wf-a', 'failed', new Date(base - 20_000));
      await createWithUpdatedAt('fp-wf-b', 'wont_fix', new Date(base - 10_000));
      await createWithUpdatedAt('fp-wf-c', 'failed', new Date(base - 5_000));

      const count = await sreErrorTrackingRepository.countConsecutiveFailures();
      // wont_fix breaks the chain: only the most-recent failed doc counts
      expect(count).toBe(1);
    });

    it('treats low_confidence and rate_limited as neutral (skipped without resetting counter)', async () => {
      // Sequence (updatedAt desc): [failed, rate_limited, low_confidence, failed]
      // Expected: count=2 - both neutral statuses skipped, chain broken at nothing
      const base = Date.now();
      await createWithUpdatedAt('fp-lc-a', 'failed', new Date(base - 40_000));
      await createWithUpdatedAt('fp-lc-b', 'failed', new Date(base - 30_000));
      await createWithUpdatedAt('fp-lc-c', 'low_confidence', new Date(base - 20_000));
      await createWithUpdatedAt('fp-lc-d', 'rate_limited', new Date(base - 10_000));

      const count = await sreErrorTrackingRepository.countConsecutiveFailures();
      // low_confidence and rate_limited are skipped; both failed docs count
      expect(count).toBe(2);
    });

    it('treats already_fixed as neutral (skipped without resetting counter)', async () => {
      // Sequence (updatedAt desc): [failed, already_fixed, failed]
      // Expected: count=2 - already_fixed skipped, chain unbroken
      const base = Date.now();
      await createWithUpdatedAt('fp-af-a', 'failed', new Date(base - 20_000));
      await createWithUpdatedAt('fp-af-b', 'already_fixed', new Date(base - 10_000));
      await createWithUpdatedAt('fp-af-c', 'failed', new Date(base - 5_000));

      const count = await sreErrorTrackingRepository.countConsecutiveFailures();
      expect(count).toBe(2);
    });

    it('counts dispatch_failed as a failure (increments counter)', async () => {
      // Sequence (updatedAt desc): [dispatch_failed, dispatch_failed, fixed]
      // Expected: count=2 - dispatch_failed docs count, chain broken at fixed
      const base = Date.now();
      await createWithUpdatedAt('fp-df-a', 'fixed', new Date(base - 30_000));
      await createWithUpdatedAt('fp-df-b', 'dispatch_failed', new Date(base - 20_000));
      await createWithUpdatedAt('fp-df-c', 'dispatch_failed', new Date(base - 10_000));

      const count = await sreErrorTrackingRepository.countConsecutiveFailures();
      expect(count).toBe(2);
    });

    it('ignores docs outside the cooldownMinutes window', async () => {
      const base = Date.now();
      // Two failures within the window
      await createWithUpdatedAt('fp-recent-1', 'failed', new Date(base - 5 * 60_000));
      await createWithUpdatedAt('fp-recent-2', 'failed', new Date(base - 10 * 60_000));
      // One failure outside the window
      await createWithUpdatedAt('fp-old', 'failed', new Date(base - 60 * 60_000));

      // Without cooldown: counts all 3
      expect(await sreErrorTrackingRepository.countConsecutiveFailures()).toBe(3);
      // With 30-min cooldown: only counts the 2 recent ones
      expect(await sreErrorTrackingRepository.countConsecutiveFailures(undefined, 30)).toBe(2);
    });
  });

  describe('dismiss', () => {
    it('transitions failed → dismissed with audit fields', async () => {
      const doc = await SreErrorTrackingModel.create({
        errorFingerprint: 'fp-dismiss',
        source: 'CLOUDWATCH',
        sourceRef: 'log',
        status: 'failed',
      });

      const result = await sreErrorTrackingRepository.dismiss(doc.id, 'Test reason', 'user-123');
      expect(result).not.toBeNull();
      expect(result?.status).toBe('dismissed');
      expect(result?.dismissalReason).toBe('Test reason');
      expect(result?.dismissedByUserId).toBe('user-123');
      expect(result?.dismissedAt).toBeInstanceOf(Date);
    });

    it('returns null when trying to dismiss from non-dismissable status', async () => {
      const doc = await SreErrorTrackingModel.create({
        errorFingerprint: 'fp-fixed',
        source: 'CLOUDWATCH',
        sourceRef: 'log',
        status: 'fixed',
      });

      const result = await sreErrorTrackingRepository.dismiss(doc.id, 'Test', 'user-123');
      expect(result).toBeNull();
    });

    it('returns null for analyzing and fixing (active states must not be dismissable)', async () => {
      for (const status of ['analyzing', 'fixing'] as const) {
        const doc = await SreErrorTrackingModel.create({
          errorFingerprint: `fp-active-${status}`,
          source: 'CLOUDWATCH',
          sourceRef: 'log',
          status,
        });
        const result = await sreErrorTrackingRepository.dismiss(doc.id, 'Test', 'u1');
        expect(result, `should not dismiss from ${status}`).toBeNull();
      }
    });

    it('allows dismissal from all terminal-ish states', async () => {
      const states: Array<
        | 'failed'
        | 'dispatch_failed'
        | 'wont_fix'
        | 'scope_blocked'
        | 'approval_expired'
        | 'recurrence_detected'
        | 'low_confidence'
        | 'rate_limited'
      > = [
        'failed',
        'dispatch_failed',
        'wont_fix',
        'scope_blocked',
        'approval_expired',
        'recurrence_detected',
        'low_confidence',
        'rate_limited',
      ];
      for (const status of states) {
        const doc = await SreErrorTrackingModel.create({
          errorFingerprint: `fp-${status}`,
          source: 'CLOUDWATCH',
          sourceRef: 'log',
          status,
        });
        const result = await sreErrorTrackingRepository.dismiss(doc.id, 'Test', 'u1');
        expect(result, `should dismiss from ${status}`).not.toBeNull();
      }
    });

    it('returns null when already dismissed (idempotent)', async () => {
      const doc = await SreErrorTrackingModel.create({
        errorFingerprint: 'fp-already',
        source: 'CLOUDWATCH',
        sourceRef: 'log',
        status: 'dismissed',
      });

      const result = await sreErrorTrackingRepository.dismiss(doc.id, 'Test', 'u1');
      expect(result).toBeNull();
    });
  });

  describe('claimForAnalysis — dismissed doc handling', () => {
    it('creates a new analyzing doc when a dismissed doc exists for the same fingerprint', async () => {
      const fingerprint = 'fp-rerun';
      // Seed a dismissed doc
      const dismissedDoc = await SreErrorTrackingModel.create({
        errorFingerprint: fingerprint,
        source: 'CLOUDWATCH',
        sourceRef: 'log',
        status: 'dismissed',
        dismissalReason: 'Test',
        dismissedAt: new Date(),
        dismissedByUserId: 'user-1',
      });

      // Claim for analysis should succeed (create a new doc) instead of blocking
      const claimed = await sreErrorTrackingRepository.claimForAnalysis(fingerprint, 'MillionOnMars/lumina5', {
        source: 'CLOUDWATCH',
        sourceRef: 'log',
      });

      expect(claimed).not.toBeNull();
      expect(claimed?.status).toBe('analyzing');
      // Dismissed doc is preserved
      const preserved = await SreErrorTrackingModel.findById(dismissedDoc._id).lean();
      expect(preserved?.status).toBe('dismissed');
      // New doc is linked back to the dismissed predecessor (ObjectId, compare as strings)
      expect(String(claimed?.originatingFromDismissedDocId)).toBe(String(dismissedDoc._id));

      // Both docs coexist for the same fingerprint
      const allDocs = await SreErrorTrackingModel.find({ errorFingerprint: fingerprint }).lean();
      expect(allDocs).toHaveLength(2);
    });

    it('still blocks when a failed doc exists for the same fingerprint (regression guard)', async () => {
      const fingerprint = 'fp-failed';
      // Use raw collection insert to set createdAt in the past. Mongoose's
      // timestamps: true auto-manages createdAt on create/insert and may not
      // honor $set overrides. Raw insert bypasses this entirely.
      // claimForAnalysis uses Math.abs(createdAt - now) < 1000ms to detect
      // newly-upserted docs. Without backdating, both seed and claim happen
      // within the same millisecond -> false positive (returned as "new").
      const pastDate = new Date(Date.now() - 5000);
      await SreErrorTrackingModel.collection.insertOne({
        errorFingerprint: fingerprint,
        repoSlug: 'MillionOnMars/lumina5',
        source: 'CLOUDWATCH',
        sourceRef: 'log',
        status: 'failed',
        affectedUserIds: [],
        createdAt: pastDate,
        updatedAt: pastDate,
      });

      const claimed = await sreErrorTrackingRepository.claimForAnalysis(fingerprint, 'MillionOnMars/lumina5', {
        source: 'CLOUDWATCH',
        sourceRef: 'log',
      });

      // Failed doc blocks: behavior unchanged
      expect(claimed).toBeNull();
    });
  });

  describe('claimRevision', () => {
    function makeTrackingDoc(overrides: Record<string, unknown> = {}) {
      return SreErrorTrackingModel.create({
        errorFingerprint: 'fp-revision',
        source: 'GITHUB_ISSUE',
        sourceRef: 'https://github.com/owner/repo/issues/1',
        status: 'fixed',
        fixPrNumber: 8295,
        revisionCount: 0,
        diagnosisResult: {
          rootCause: 'NPE in handler',
          proposedFix: 'Add null check',
          confidence: 90,
          riskAssessment: 'low',
          affectedFiles: [],
        },
        ...overrides,
      });
    }

    it('claims from wont_fix status and increments revisionCount', async () => {
      const doc = await makeTrackingDoc({ status: 'wont_fix' });
      const result = await sreErrorTrackingRepository.claimRevision(doc.id, 3);
      expect(result).not.toBeNull();
      expect(result?.status).toBe('revision_requested');
      expect(result?.revisionCount).toBe(1);
    });

    it('claims from fixed status (normal flow)', async () => {
      const doc = await makeTrackingDoc({ status: 'fixed' });
      const result = await sreErrorTrackingRepository.claimRevision(doc.id, 3);
      expect(result).not.toBeNull();
      expect(result?.status).toBe('revision_requested');
      expect(result?.revisionCount).toBe(1);
    });

    it('returns null when wont_fix doc has reached revisionCount cap', async () => {
      const doc = await makeTrackingDoc({ status: 'wont_fix', revisionCount: 3 });
      const result = await sreErrorTrackingRepository.claimRevision(doc.id, 3);
      expect(result).toBeNull();
    });

    it('returns null when fixMergedAt is set (PR already merged)', async () => {
      const doc = await makeTrackingDoc({ status: 'fixed', fixMergedAt: new Date() });
      const result = await sreErrorTrackingRepository.claimRevision(doc.id, 3);
      expect(result).toBeNull();
    });

    it('returns null for non-claimable statuses', async () => {
      for (const status of ['analyzing', 'fixing', 'revision_requested', 'dismissed'] as const) {
        const doc = await makeTrackingDoc({ status, errorFingerprint: `fp-${status}` });
        const result = await sreErrorTrackingRepository.claimRevision(doc.id, 3);
        expect(result, `should not claim from ${status}`).toBeNull();
      }
    });
  });

  describe('setFixVerdict (#271)', () => {
    function makeFixDoc(overrides: Record<string, unknown> = {}) {
      return SreErrorTrackingModel.create({
        errorFingerprint: 'fp-verdict',
        source: 'GITHUB_ISSUE',
        sourceRef: 'https://github.com/owner/repo/issues/9',
        status: 'fixed',
        fixPrNumber: 8300,
        fixMergedAt: new Date(),
        ...overrides,
      });
    }

    it('persists a verdict against the tracking doc matched by fixPrNumber', async () => {
      await makeFixDoc({ fixPrNumber: 8300 });
      const at = new Date();

      const updated = await sreErrorTrackingRepository.setFixVerdict(8300, { value: 'correct', by: 'alice', at });

      expect(updated).not.toBeNull();
      expect(updated?.fixVerdict?.value).toBe('correct');
      expect(updated?.fixVerdict?.by).toBe('alice');
      expect(updated?.fixVerdict?.at?.getTime()).toBe(at.getTime());
    });

    it('overrides a prior verdict when the opposite label is applied (last-write-wins)', async () => {
      await makeFixDoc({ fixPrNumber: 8301 });

      await sreErrorTrackingRepository.setFixVerdict(8301, { value: 'correct', by: 'alice', at: new Date() });
      const updated = await sreErrorTrackingRepository.setFixVerdict(8301, {
        value: 'incorrect',
        by: 'bob',
        at: new Date(),
      });

      expect(updated?.fixVerdict?.value).toBe('incorrect');
      expect(updated?.fixVerdict?.by).toBe('bob');
    });

    it('returns null when no tracking doc exists for the PR (non-SRE PR ignored)', async () => {
      const updated = await sreErrorTrackingRepository.setFixVerdict(99999, {
        value: 'correct',
        by: 'alice',
        at: new Date(),
      });
      expect(updated).toBeNull();
    });

    it('is queryable by verdict value', async () => {
      await makeFixDoc({ fixPrNumber: 8302, errorFingerprint: 'fp-verdict-a' });
      await makeFixDoc({ fixPrNumber: 8303, errorFingerprint: 'fp-verdict-b' });
      await sreErrorTrackingRepository.setFixVerdict(8302, { value: 'incorrect', by: 'alice', at: new Date() });
      await sreErrorTrackingRepository.setFixVerdict(8303, { value: 'correct', by: 'bob', at: new Date() });

      const incorrect = await SreErrorTrackingModel.find({ 'fixVerdict.value': 'incorrect' }).lean();
      expect(incorrect).toHaveLength(1);
      expect(incorrect[0].fixPrNumber).toBe(8302);
    });
  });
});
