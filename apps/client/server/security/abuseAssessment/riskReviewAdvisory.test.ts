import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findForUsers: vi.fn(),
  findLatestJudged: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  shadowDetectionRepository: { findForUsers: h.findForUsers },
  abuseAssessmentRepository: { findLatestJudgedForDetections: h.findLatestJudged },
}));

import { findRiskReviewAdvisories } from './riskReviewAdvisory';

const USER_A = 'a'.repeat(24);
const USER_B = 'b'.repeat(24);
const OUTSIDER = 'c'.repeat(24);
const logger = { warn: vi.fn() };

const detection = (id: string, userIds: string[]) => ({
  id,
  detector: 'signupNetworkBurst' as const,
  userIds,
  detectedAt: new Date('2026-11-01T00:00:00Z'),
});
const assessment = (detectionId: string, result: string, assessedAt: string, confidence: number | null = 0.7) => ({
  detectionId,
  result,
  confidence,
  assessedAt: new Date(assessedAt),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findRiskReviewAdvisories', () => {
  it('reads nothing more when no detection names the accounts', async () => {
    h.findForUsers.mockResolvedValue([]);

    const advisories = await findRiskReviewAdvisories([USER_A], logger);

    expect(advisories.size).toBe(0);
    expect(h.findLatestJudged).not.toHaveBeenCalled();
  });

  it('maps each listed account to the judgment of a detection naming it, ignoring other accounts', async () => {
    h.findForUsers.mockResolvedValue([detection('d1', [USER_A, OUTSIDER])]);
    h.findLatestJudged.mockResolvedValue([assessment('d1', 'insufficient_evidence', '2026-11-02T00:00:00Z')]);

    const advisories = await findRiskReviewAdvisories([USER_A, USER_B], logger);

    expect(h.findForUsers).toHaveBeenCalledWith([USER_A, USER_B], 1000);
    expect(h.findLatestJudged).toHaveBeenCalledWith(['d1']);
    expect([...advisories.keys()]).toEqual([USER_A]);
    expect(advisories.get(USER_A)).toEqual({
      detectionId: 'd1',
      detector: 'signupNetworkBurst',
      result: 'insufficient_evidence',
      confidence: 0.7,
      assessedAt: new Date('2026-11-02T00:00:00Z'),
      otherVerdicts: 0,
    });
  });

  it('prefers an abuse judgment over a newer non-abuse one', async () => {
    // The winner is listed first, so a "last one wins" merge would fail this.
    h.findForUsers.mockResolvedValue([detection('d1', [USER_A]), detection('d2', [USER_A])]);
    h.findLatestJudged.mockResolvedValue([
      assessment('d1', 'abuse', '2026-11-01T00:00:00Z'),
      assessment('d2', 'legitimate_automation', '2026-11-03T00:00:00Z'),
    ]);

    const advisories = await findRiskReviewAdvisories([USER_A], logger);

    expect(advisories.get(USER_A)).toMatchObject({ detectionId: 'd1', result: 'abuse' });
  });

  it('otherwise takes the newest judgment', async () => {
    h.findForUsers.mockResolvedValue([detection('d2', [USER_A]), detection('d1', [USER_A])]);
    h.findLatestJudged.mockResolvedValue([
      assessment('d2', 'legitimate_automation', '2026-11-03T00:00:00Z'),
      assessment('d1', 'insufficient_evidence', '2026-11-01T00:00:00Z'),
    ]);

    const advisories = await findRiskReviewAdvisories([USER_A], logger);

    expect(advisories.get(USER_A)).toMatchObject({ detectionId: 'd2', result: 'legitimate_automation' });
  });

  it('takes the newest of two abuse judgments', async () => {
    h.findForUsers.mockResolvedValue([detection('d2', [USER_A]), detection('d1', [USER_A])]);
    h.findLatestJudged.mockResolvedValue([
      assessment('d2', 'abuse', '2026-11-03T00:00:00Z'),
      assessment('d1', 'abuse', '2026-11-01T00:00:00Z'),
    ]);

    const advisories = await findRiskReviewAdvisories([USER_A], logger);

    expect(advisories.get(USER_A)).toMatchObject({ detectionId: 'd2' });
  });

  it('drops and logs a stored verdict that no longer fits the response schema', async () => {
    h.findForUsers.mockResolvedValue([{ ...detection('d1', [USER_A]), detector: 'retiredDetector' }]);
    h.findLatestJudged.mockResolvedValue([assessment('d1', 'abuse', '2026-11-01T00:00:00Z')]);

    const advisories = await findRiskReviewAdvisories([USER_A], logger);

    expect(advisories.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith('Signup risk review advisory dropped: stored values no longer match', {
      detectionId: 'd1',
      detector: 'retiredDetector',
      result: 'abuse',
    });
  });

  it('says so when the detection read hits its cap', async () => {
    h.findForUsers.mockResolvedValue(Array.from({ length: 1000 }, (_, i) => detection(`d${i}`, [USER_A])));
    h.findLatestJudged.mockResolvedValue([]);

    await findRiskReviewAdvisories([USER_A], logger);

    expect(logger.warn).toHaveBeenCalledWith('Signup risk review advisories capped; older detections not read', {
      limit: 1000,
    });
  });

  it('skips a detection with no judged assessment', async () => {
    h.findForUsers.mockResolvedValue([detection('d1', [USER_A])]);
    h.findLatestJudged.mockResolvedValue([]);

    const advisories = await findRiskReviewAdvisories([USER_A], logger);

    expect(advisories.size).toBe(0);
  });
});
