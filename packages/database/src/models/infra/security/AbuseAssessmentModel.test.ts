import { describe, it, expect, beforeEach } from 'vitest';
import { setupMongoTest } from '../../../__test__/utils';
import { AbuseAssessmentModel, abuseAssessmentRepository } from './AbuseAssessmentModel';

// Raw inserts: the query under test reads only these fields, and save() needs a full feature summary.
const insert = (detectionId: string, result: string, assessedAt: string) =>
  AbuseAssessmentModel.collection.insertOne({
    detectionId,
    result,
    probabilities: [],
    confidence: result === 'unknown' ? null : 0.6,
    assessedAt: new Date(assessedAt),
  });

describe('abuseAssessmentRepository.findLatestJudgedForDetections', () => {
  setupMongoTest();

  beforeEach(async () => {
    await AbuseAssessmentModel.deleteMany({});
  });

  it('returns the newest judged assessment per detection, skipping unknown results', async () => {
    await insert('d1', 'abuse', '2026-11-01T00:00:00Z');
    await insert('d1', 'insufficient_evidence', '2026-11-02T00:00:00Z');
    await insert('d1', 'unknown', '2026-11-03T00:00:00Z');
    await insert('d2', 'unknown', '2026-11-01T00:00:00Z');
    await insert('d3', 'legitimate_automation', '2026-11-01T00:00:00Z');

    const found = await abuseAssessmentRepository.findLatestJudgedForDetections(['d1', 'd2']);

    expect(found.map(({ detectionId, result, assessedAt }) => ({ detectionId, result, assessedAt }))).toEqual([
      { detectionId: 'd1', result: 'insufficient_evidence', assessedAt: new Date('2026-11-02T00:00:00Z') },
    ]);
  });

  it('reads nothing for no detections', async () => {
    await expect(abuseAssessmentRepository.findLatestJudgedForDetections([])).resolves.toEqual([]);
  });
});
