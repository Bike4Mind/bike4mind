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
      const updated = await imageModerationIncidentRepository.updateReviewStatus(String(inc._id), 'reported', 'rpt-42');
      expect(updated?.reviewStatus).toBe('reported');
      expect(updated?.ncmecReportId).toBe('rpt-42');
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
      });
      expect(out?.reviewStatus).toBe('reported');
      expect(out?.ncmecReportId).toBe('RPT-M');
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
        await imageModerationIncidentRepository.resolveConfirmedCsam(id, { status: 'reported', ncmecReportId: 'X' })
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
