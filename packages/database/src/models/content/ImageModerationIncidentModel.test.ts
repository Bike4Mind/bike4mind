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
      await ImageModerationIncident.findByIdAndUpdate(inc._id, { $set: { reviewStatus: 'reported', ncmecReportId: 'rpt-1' } });
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
        'rpt-42'
      );
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
});
