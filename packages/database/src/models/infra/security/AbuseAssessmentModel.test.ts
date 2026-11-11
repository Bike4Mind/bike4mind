import { describe, it, expect, beforeEach } from 'vitest';
import { setupMongoTest } from '../../../__test__/utils';
import { AbuseAssessmentModel, abuseAssessmentRepository, type SaveAbuseAssessmentInput } from './AbuseAssessmentModel';

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

  it('normalizes the missing reasons on an older stored assessment', async () => {
    await insert('legacy', 'abuse', '2026-11-01T00:00:00Z');
    const rows = await abuseAssessmentRepository.listForDetection('legacy');
    expect(rows).toHaveLength(1);
    expect(rows[0].reasons).toEqual([]);
  });

  it('reads nothing for no detections', async () => {
    await expect(abuseAssessmentRepository.findLatestJudgedForDetections([])).resolves.toEqual([]);
  });
});

describe('abuseAssessmentRepository.save', () => {
  setupMongoTest();

  beforeEach(async () => {
    await AbuseAssessmentModel.deleteMany({});
  });

  it('leaves out summary fields the builder left undefined instead of storing null', async () => {
    // Only the shape matters here: the builder omits optional evidence by leaving it undefined.
    const featureSummary = {
      detection: { source: 'signupNetworkBurst', campaign: undefined },
      completionSequence: undefined,
      accounts: [{ ref: 'acct_1', profile: undefined }],
    } as unknown as SaveAbuseAssessmentInput['featureSummary'];
    await abuseAssessmentRepository.save({
      cacheKey: 'k1',
      detectionId: 'd1',
      result: 'unknown',
      probabilities: [],
      confidence: null,
      reasons: [],
      model: 'test-decisions',
      modelVersion: null,
      policyVersion: 1,
      evidenceVersion: 2,
      evidenceHash: 'h',
      featureSummary,
      failure: null,
      costUsd: 0,
      trigger: 'admin',
      requestedBy: null,
      assessedAt: new Date('2026-11-01T00:00:00Z'),
    });

    const stored = await abuseAssessmentRepository.findByCacheKey('k1');
    expect(stored?.featureSummary).toEqual({
      detection: { source: 'signupNetworkBurst' },
      accounts: [{ ref: 'acct_1' }],
    });
    expect(JSON.stringify(stored?.featureSummary)).not.toContain('null');
  });
});
