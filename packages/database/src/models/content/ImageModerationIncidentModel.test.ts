import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { ImageModerationIncident, imageModerationIncidentRepository } from './ImageModerationIncidentModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const baseIncident = () => ({
  userId: 'u1',
  provider: 'aws-rekognition',
  model: 'upload',
  labels: [{ name: 'Explicit Nudity', parentName: 'Explicit', confidence: 0.98 }],
});

describe('ImageModerationIncidentRepository', () => {
  beforeEach(async () => {
    await ImageModerationIncident.deleteMany({});
  });

  describe('surface', () => {
    it('round-trips each surface', async () => {
      for (const surface of ['generation', 'edit', 'upload'] as const) {
        const inc = await imageModerationIncidentRepository.record({ ...baseIncident(), surface });
        expect((await ImageModerationIncident.findById(inc._id).lean())?.surface).toBe(surface);
      }
    });

    it('rejects a value outside the enum', async () => {
      await expect(
        imageModerationIncidentRepository.record({ ...baseIncident(), surface: 'other' as 'upload' })
      ).rejects.toThrow(/surface/);
    });
  });

  describe('markAlerted', () => {
    it('stamps alertedAt on the incident and leaves it absent until then', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      expect((await ImageModerationIncident.findById(inc._id).lean())?.alertedAt).toBeUndefined();

      const at = new Date('2026-10-19T12:00:00.000Z');
      await imageModerationIncidentRepository.markAlerted(inc.id, at);

      expect((await ImageModerationIncident.findById(inc._id).lean())?.alertedAt).toEqual(at);
    });
  });

  describe('review sweep queries', () => {
    const NOW = new Date('2026-10-20T12:00:00.000Z');
    const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
    const seed = async (fields: Record<string, unknown>) => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      await ImageModerationIncident.collection.updateOne({ _id: inc._id }, { $set: fields });
      return String(inc._id);
    };

    it('markReminded stamps lastReminderAt on every given incident and leaves the others absent', async () => {
      const first = await imageModerationIncidentRepository.record(baseIncident());
      const second = await imageModerationIncidentRepository.record(baseIncident());
      const untouched = await imageModerationIncidentRepository.record(baseIncident());

      await imageModerationIncidentRepository.markReminded([first.id, second.id], NOW);
      await imageModerationIncidentRepository.markReminded([], NOW);

      expect((await ImageModerationIncident.findById(first._id).lean())?.lastReminderAt).toEqual(NOW);
      expect((await ImageModerationIncident.findById(second._id).lean())?.lastReminderAt).toEqual(NOW);
      expect((await ImageModerationIncident.findById(untouched._id).lean())?.lastReminderAt).toBeUndefined();
    });

    it('countPendingReview counts absent and pending_review incidents only', async () => {
      await seed({});
      await seed({ reviewStatus: 'pending_review' });
      await seed({ reviewStatus: 'reported' });
      await seed({ reviewStatus: 'false_positive' });
      await seed({ reviewStatus: 'no_action' });

      expect(await imageModerationIncidentRepository.countPendingReview()).toBe(2);
    });

    it('findUnalerted returns old-enough unreviewed incidents with no alert, oldest first', async () => {
      const newer = await seed({ createdAt: hoursAgo(2) });
      const older = await seed({ createdAt: hoursAgo(3), reviewStatus: 'pending_review' });
      await seed({ createdAt: hoursAgo(0.1) });
      await seed({ createdAt: hoursAgo(5), alertedAt: hoursAgo(4) });
      await seed({ createdAt: hoursAgo(6), reviewStatus: 'reported' });
      await seed({ createdAt: hoursAgo(7), reviewStatus: 'false_positive' });
      await seed({ createdAt: hoursAgo(8), reviewStatus: 'no_action' });

      const found = await imageModerationIncidentRepository.findUnalerted(hoursAgo(0.25), 10);

      expect(found.map(incident => String(incident._id))).toEqual([older, newer]);
      expect(await imageModerationIncidentRepository.findUnalerted(hoursAgo(0.25), 1)).toHaveLength(1);
    });

    it('findDueForReminder returns alerted unreviewed incidents whose last notice is a day old', async () => {
      const neverReminded = await seed({ createdAt: hoursAgo(50), alertedAt: hoursAgo(30) });
      const remindedLongAgo = await seed({
        createdAt: hoursAgo(80),
        alertedAt: hoursAgo(70),
        lastReminderAt: hoursAgo(25),
      });
      await seed({ createdAt: hoursAgo(40), alertedAt: hoursAgo(20) });
      await seed({ createdAt: hoursAgo(90), alertedAt: hoursAgo(80), lastReminderAt: hoursAgo(2) });
      await seed({ createdAt: hoursAgo(60) });
      await seed({ createdAt: hoursAgo(60), alertedAt: hoursAgo(50), reviewStatus: 'reported' });
      await seed({ createdAt: hoursAgo(60), alertedAt: hoursAgo(50), reviewStatus: 'no_action' });

      const found = await imageModerationIncidentRepository.findDueForReminder(hoursAgo(24), 10);

      expect(found.map(incident => String(incident._id))).toEqual([remindedLongAgo, neverReminded]);
    });
  });

  describe('findPendingReview', () => {
    it('returns incidents with absent reviewStatus', async () => {
      await imageModerationIncidentRepository.record(baseIncident());
      const results = await imageModerationIncidentRepository.findPendingReview(10);
      expect(results).toHaveLength(1);
    });

    it('returns incidents with reviewStatus pending_review', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      await ImageModerationIncident.findByIdAndUpdate(inc._id, { $set: { reviewStatus: 'pending_review' } });
      const results = await imageModerationIncidentRepository.findPendingReview(10);
      expect(results).toHaveLength(1);
    });

    it('excludes confirmed_csam, false_positive, and reported incidents', async () => {
      const a = await imageModerationIncidentRepository.record(baseIncident());
      const b = await imageModerationIncidentRepository.record(baseIncident());
      const c = await imageModerationIncidentRepository.record(baseIncident());
      await ImageModerationIncident.findByIdAndUpdate(a._id, { $set: { reviewStatus: 'confirmed_csam' } });
      await ImageModerationIncident.findByIdAndUpdate(b._id, { $set: { reviewStatus: 'false_positive' } });
      await ImageModerationIncident.findByIdAndUpdate(c._id, { $set: { reviewStatus: 'reported' } });
      const results = await imageModerationIncidentRepository.findPendingReview(10);
      expect(results).toHaveLength(0);
    });

    it('respects the limit', async () => {
      await Promise.all([1, 2, 3].map(() => imageModerationIncidentRepository.record(baseIncident())));
      const results = await imageModerationIncidentRepository.findPendingReview(2);
      expect(results).toHaveLength(2);
    });

    it('returns oldest first (ascending createdAt)', async () => {
      const a = await imageModerationIncidentRepository.record({ ...baseIncident(), userId: 'u1' });
      const b = await imageModerationIncidentRepository.record({ ...baseIncident(), userId: 'u2' });
      const results = await imageModerationIncidentRepository.findPendingReview(10);
      expect(String(results[0]._id)).toBe(String(a._id));
      expect(String(results[1]._id)).toBe(String(b._id));
    });
  });

  describe('claimForNcmecSubmission', () => {
    it('transitions absent reviewStatus -> confirmed_csam', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      const claimed = await imageModerationIncidentRepository.claimForNcmecSubmission(String(inc._id));
      expect(claimed?.reviewStatus).toBe('confirmed_csam');
    });

    it('transitions pending_review -> confirmed_csam', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      await ImageModerationIncident.findByIdAndUpdate(inc._id, { $set: { reviewStatus: 'pending_review' } });
      const claimed = await imageModerationIncidentRepository.claimForNcmecSubmission(String(inc._id));
      expect(claimed?.reviewStatus).toBe('confirmed_csam');
    });

    it('returns null when incident is already confirmed_csam (concurrent claim loses)', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      await imageModerationIncidentRepository.claimForNcmecSubmission(String(inc._id));
      const second = await imageModerationIncidentRepository.claimForNcmecSubmission(String(inc._id));
      expect(second).toBeNull();
    });

    it('returns null when incident is already reported', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      await ImageModerationIncident.findByIdAndUpdate(inc._id, {
        $set: { reviewStatus: 'reported', ncmecReportId: 'rpt-1' },
      });
      const claimed = await imageModerationIncidentRepository.claimForNcmecSubmission(String(inc._id));
      expect(claimed).toBeNull();
    });
  });

  describe('updateReviewStatus', () => {
    it('sets the status and returns the updated doc', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      const updated = await imageModerationIncidentRepository.updateReviewStatus(String(inc._id), 'false_positive');
      expect(updated?.reviewStatus).toBe('false_positive');
    });

    it('persists ncmecReportId when provided', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      const updated = await imageModerationIncidentRepository.updateReviewStatus(
        String(inc._id),
        'reported',
        'rpt-42',
        'admin-1'
      );
      expect(updated?.reviewStatus).toBe('reported');
      expect(updated?.ncmecReportId).toBe('rpt-42');
      expect(updated?.reportedBy).toBe('admin-1');
      expect(updated?.reportedAt).toBeInstanceOf(Date);
    });

    it('does not set reportedAt for a non-reported status', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      const updated = await imageModerationIncidentRepository.updateReviewStatus(String(inc._id), 'false_positive');
      expect(updated?.reportedAt).toBeUndefined();
    });

    it('returns null when incident is already reported (idempotency guard)', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      await imageModerationIncidentRepository.updateReviewStatus(String(inc._id), 'reported', 'rpt-1');
      const second = await imageModerationIncidentRepository.updateReviewStatus(String(inc._id), 'reported', 'rpt-2');
      expect(second).toBeNull();
      // The original reportId is preserved.
      const reloaded = await ImageModerationIncident.findById(inc._id);
      expect(reloaded?.ncmecReportId).toBe('rpt-1');
    });

    it('returns null for false_positive when incident is in confirmed_csam (in-flight NCMEC guard)', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      await imageModerationIncidentRepository.claimForNcmecSubmission(String(inc._id));
      const fp = await imageModerationIncidentRepository.updateReviewStatus(String(inc._id), 'false_positive');
      expect(fp).toBeNull();
      // The claim holds; incident stays confirmed_csam.
      const reloaded = await ImageModerationIncident.findById(inc._id);
      expect(reloaded?.reviewStatus).toBe('confirmed_csam');
    });

    it('allows reported to be set from confirmed_csam (normal NCMEC submission path)', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      await imageModerationIncidentRepository.claimForNcmecSubmission(String(inc._id));
      const updated = await imageModerationIncidentRepository.updateReviewStatus(
        String(inc._id),
        'reported',
        'rpt-flow'
      );
      expect(updated?.reviewStatus).toBe('reported');
      expect(updated?.ncmecReportId).toBe('rpt-flow');
    });

    it('allows pending_review to be set from confirmed_csam (NCMEC failure rollback path)', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      await imageModerationIncidentRepository.claimForNcmecSubmission(String(inc._id));
      const rolled = await imageModerationIncidentRepository.updateReviewStatus(String(inc._id), 'pending_review');
      expect(rolled?.reviewStatus).toBe('pending_review');
      // After rollback the incident is claimable again.
      const reclaimed = await imageModerationIncidentRepository.claimForNcmecSubmission(String(inc._id));
      expect(reclaimed?.reviewStatus).toBe('confirmed_csam');
    });
  });

  describe('resolveConfirmedCsam', () => {
    const STALE = new Date(Date.now() - 11 * 60 * 1000);
    // updatedAt is managed by timestamps; bypass it to backdate a claim.
    const backdate = (id: string) =>
      ImageModerationIncident.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(id) },
        { $set: { updatedAt: STALE } }
      );
    const claimed = async (stale: boolean) => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      const id = String(inc._id);
      await imageModerationIncidentRepository.claimForNcmecSubmission(id);
      if (stale) await backdate(id);
      return id;
    };

    it('marks a stale confirmed_csam claim reported with the operator-supplied reportId', async () => {
      const id = await claimed(true);
      const out = await imageModerationIncidentRepository.resolveConfirmedCsam(id, {
        status: 'reported',
        ncmecReportId: 'RPT-M',
        reportedBy: 'admin-1',
      });
      expect(out?.reviewStatus).toBe('reported');
      expect(out?.ncmecReportId).toBe('RPT-M');
      expect(out?.reportedBy).toBe('admin-1');
      expect(out?.reportedAt).toBeInstanceOf(Date);
    });

    it('requeues a stale confirmed_csam claim with no stored reportId', async () => {
      const id = await claimed(true);
      const out = await imageModerationIncidentRepository.resolveConfirmedCsam(id, { status: 'pending_review' });
      expect(out?.reviewStatus).toBe('pending_review');
    });

    it('refuses both verdicts on a fresh (in-flight) claim', async () => {
      const id = await claimed(false);
      expect(await imageModerationIncidentRepository.resolveConfirmedCsam(id, { status: 'pending_review' })).toBeNull();
      expect(
        await imageModerationIncidentRepository.resolveConfirmedCsam(id, {
          status: 'reported',
          ncmecReportId: 'X',
          reportedBy: 'admin-1',
        })
      ).toBeNull();
      expect((await ImageModerationIncident.findById(id))?.reviewStatus).toBe('confirmed_csam');
    });

    it('refuses requeue but allows mark_reported when an unfinished reportId is stored', async () => {
      const id = await claimed(false);
      await imageModerationIncidentRepository.setNcmecReportId(id, 'RPT-UNFINISHED');
      await backdate(id);
      expect(await imageModerationIncidentRepository.resolveConfirmedCsam(id, { status: 'pending_review' })).toBeNull();
      const out = await imageModerationIncidentRepository.resolveConfirmedCsam(id, {
        status: 'reported',
        ncmecReportId: 'RPT-UNFINISHED',
        reportedBy: 'admin-1',
      });
      expect(out?.reviewStatus).toBe('reported');
    });

    it('returns null when the incident is not confirmed_csam', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      const id = String(inc._id);
      await backdate(id);
      expect(await imageModerationIncidentRepository.resolveConfirmedCsam(id, { status: 'pending_review' })).toBeNull();
    });
  });

  describe('recordManualReport', () => {
    const report = { ncmecReportId: '123456', reportedBy: 'admin-1' };

    it('moves an unreviewed incident straight to reported with channel and admin', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      const out = await imageModerationIncidentRepository.recordManualReport(String(inc._id), report);
      expect(out?.reviewStatus).toBe('reported');
      expect(out?.ncmecReportId).toBe('123456');
      expect(out?.reportChannel).toBe('manual');
      expect(out?.reportedBy).toBe('admin-1');
      expect(out?.reportedAt).toBeInstanceOf(Date);
    });

    it('accepts pending_review', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      await ImageModerationIncident.findByIdAndUpdate(inc._id, { $set: { reviewStatus: 'pending_review' } });
      const out = await imageModerationIncidentRepository.recordManualReport(String(inc._id), report);
      expect(out?.reviewStatus).toBe('reported');
    });

    it('loses to an API claim that landed first, leaving the claim intact', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      const id = String(inc._id);
      await imageModerationIncidentRepository.claimForNcmecSubmission(id);
      expect(await imageModerationIncidentRepository.recordManualReport(id, report)).toBeNull();
      const doc = await ImageModerationIncident.findById(id);
      expect(doc?.reviewStatus).toBe('confirmed_csam');
      expect(doc?.ncmecReportId).toBeUndefined();
    });

    it('blocks a later API claim once recorded', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      const id = String(inc._id);
      await imageModerationIncidentRepository.recordManualReport(id, report);
      expect(await imageModerationIncidentRepository.claimForNcmecSubmission(id)).toBeNull();
    });

    it('refuses a reported incident without overwriting it', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      await imageModerationIncidentRepository.updateReviewStatus(String(inc._id), 'reported', 'rpt-api');
      expect(await imageModerationIncidentRepository.recordManualReport(String(inc._id), report)).toBeNull();
      const doc = await ImageModerationIncident.findById(inc._id);
      expect(doc?.ncmecReportId).toBe('rpt-api');
      expect(doc?.reportChannel).toBeUndefined();
    });

    it('overrides a false_positive verdict and keeps it as previousReviewStatus', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      await imageModerationIncidentRepository.updateReviewStatus(String(inc._id), 'false_positive');
      const out = await imageModerationIncidentRepository.recordManualReport(String(inc._id), report);
      expect(out?.reviewStatus).toBe('reported');
      expect(out?.ncmecReportId).toBe('123456');
      expect(out?.reportChannel).toBe('manual');
      expect(out?.reportedBy).toBe('admin-1');
      expect(out?.reportedAt).toBeInstanceOf(Date);
      expect(out?.previousReviewStatus).toBe('false_positive');
    });

    it('leaves previousReviewStatus unset when recording an unreviewed incident', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      const out = await imageModerationIncidentRepository.recordManualReport(String(inc._id), report);
      expect(out?.previousReviewStatus).toBeUndefined();
    });

    it('lets exactly one of two concurrent manual reports win over a false_positive verdict', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      const id = String(inc._id);
      await imageModerationIncidentRepository.updateReviewStatus(id, 'false_positive');
      const results = await Promise.all([
        imageModerationIncidentRepository.recordManualReport(id, { ncmecReportId: 'TIP-A', reportedBy: 'admin-1' }),
        imageModerationIncidentRepository.recordManualReport(id, { ncmecReportId: 'TIP-B', reportedBy: 'admin-2' }),
      ]);
      const winners = results.filter(r => r !== null);
      expect(winners).toHaveLength(1);
      expect((await ImageModerationIncident.findById(id))?.ncmecReportId).toBe(winners[0]?.ncmecReportId);
    });

    it('keeps who marked it false_positive, and when, through the override', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      const id = String(inc._id);
      const fp = await imageModerationIncidentRepository.updateReviewStatus(
        id,
        'false_positive',
        undefined,
        'admin-fp'
      );
      expect(fp?.falsePositiveBy).toBe('admin-fp');
      expect(fp?.falsePositiveAt).toBeInstanceOf(Date);
      const out = await imageModerationIncidentRepository.recordManualReport(id, report);
      expect(out?.falsePositiveBy).toBe('admin-fp');
      expect(out?.falsePositiveAt).toEqual(fp?.falsePositiveAt);
      expect(out?.reportedBy).toBe('admin-1');
    });

    it('overrides a no_action verdict and keeps who closed it, and when', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      const id = String(inc._id);
      const closed = await imageModerationIncidentRepository.markNoAction(id, 'admin-na');
      const out = await imageModerationIncidentRepository.recordManualReport(id, report);
      expect(out?.reviewStatus).toBe('reported');
      expect(out?.previousReviewStatus).toBe('no_action');
      expect(out?.noActionBy).toBe('admin-na');
      expect(out?.noActionAt).toEqual(closed?.noActionAt);
      expect(out?.reportedBy).toBe('admin-1');
    });

    it('cannot be flipped back to false_positive once recorded over it', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      const id = String(inc._id);
      await imageModerationIncidentRepository.updateReviewStatus(id, 'false_positive');
      await imageModerationIncidentRepository.recordManualReport(id, report);
      expect(await imageModerationIncidentRepository.updateReviewStatus(id, 'false_positive')).toBeNull();
      expect((await ImageModerationIncident.findById(id))?.reviewStatus).toBe('reported');
    });
  });

  describe('markNoAction', () => {
    it('closes an absent or pending_review incident, attributed to the admin', async () => {
      const absent = await imageModerationIncidentRepository.record(baseIncident());
      const pending = await imageModerationIncidentRepository.record({
        ...baseIncident(),
        reviewStatus: 'pending_review',
      });

      for (const inc of [absent, pending]) {
        const out = await imageModerationIncidentRepository.markNoAction(String(inc._id), 'admin-na');
        expect(out?.reviewStatus).toBe('no_action');
        expect(out?.noActionBy).toBe('admin-na');
        expect(out?.noActionAt).toBeInstanceOf(Date);
      }
    });

    it.each(['false_positive', 'no_action', 'reported', 'confirmed_csam'] as const)(
      'refuses an incident already in %s and leaves it unchanged',
      async reviewStatus => {
        const inc = await imageModerationIncidentRepository.record({ ...baseIncident(), reviewStatus });
        expect(await imageModerationIncidentRepository.markNoAction(String(inc._id), 'admin-na')).toBeNull();
        const stored = await ImageModerationIncident.findById(inc._id).lean();
        expect(stored?.reviewStatus).toBe(reviewStatus);
        expect(stored?.noActionBy).toBeUndefined();
      }
    );

    it('cannot be replaced by a later false_positive verdict', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      const id = String(inc._id);
      await imageModerationIncidentRepository.markNoAction(id, 'admin-na');
      expect(await imageModerationIncidentRepository.updateReviewStatus(id, 'false_positive')).toBeNull();
      expect((await ImageModerationIncident.findById(id))?.reviewStatus).toBe('no_action');
    });
  });

  describe('findClosed', () => {
    it('returns incidents with a final verdict, newest first', async () => {
      const seedAt = async (createdAt: Date, reviewStatus?: string) => {
        const inc = await imageModerationIncidentRepository.record(baseIncident());
        await ImageModerationIncident.collection.updateOne({ _id: inc._id }, { $set: { createdAt, reviewStatus } });
        return String(inc._id);
      };
      const reported = await seedAt(new Date('2026-10-01T00:00:00Z'), 'reported');
      const noAction = await seedAt(new Date('2026-10-03T00:00:00Z'), 'no_action');
      const falsePositive = await seedAt(new Date('2026-10-02T00:00:00Z'), 'false_positive');
      await seedAt(new Date('2026-10-04T00:00:00Z'), 'pending_review');
      await seedAt(new Date('2026-10-05T00:00:00Z'), 'confirmed_csam');

      const found = await imageModerationIncidentRepository.findClosed(10);

      expect(found.map(incident => String(incident._id))).toEqual([noAction, falsePositive, reported]);
      expect(await imageModerationIncidentRepository.findClosed(1)).toHaveLength(1);
      const older = await imageModerationIncidentRepository.findClosed(10, new Date('2026-10-03T00:00:00Z'));
      expect(older.map(incident => String(incident._id))).toEqual([falsePositive, reported]);
    });
  });

  describe('setNcmecReportId', () => {
    it('stores the reportId on a confirmed_csam incident without changing reviewStatus', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      const id = String(inc._id);
      await imageModerationIncidentRepository.claimForNcmecSubmission(id);
      await imageModerationIncidentRepository.setNcmecReportId(id, 'RPT-S');
      const doc = await ImageModerationIncident.findById(id);
      expect(doc?.reviewStatus).toBe('confirmed_csam');
      expect(doc?.ncmecReportId).toBe('RPT-S');
    });

    it('is a no-op when the incident is not confirmed_csam', async () => {
      const inc = await imageModerationIncidentRepository.record(baseIncident());
      await imageModerationIncidentRepository.setNcmecReportId(String(inc._id), 'RPT-S');
      expect((await ImageModerationIncident.findById(inc._id))?.ncmecReportId).toBeUndefined();
    });
  });
});
