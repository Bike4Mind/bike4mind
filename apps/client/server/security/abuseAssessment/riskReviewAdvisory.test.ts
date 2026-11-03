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

    const advisories = await findRiskReviewAdvisories([USER_A]);

    expect(advisories.size).toBe(0);
    expect(h.findLatestJudged).not.toHaveBeenCalled();
  });

  it('maps each listed account to the judgment of a detection naming it, ignoring other accounts', async () => {
    h.findForUsers.mockResolvedValue([detection('d1', [USER_A, OUTSIDER])]);
    h.findLatestJudged.mockResolvedValue([assessment('d1', 'insufficient_evidence', '2026-11-02T00:00:00Z')]);

    const advisories = await findRiskReviewAdvisories([USER_A, USER_B]);

    expect(h.findForUsers).toHaveBeenCalledWith([USER_A, USER_B], 1000);
    expect(h.findLatestJudged).toHaveBeenCalledWith(['d1']);
    expect([...advisories.keys()]).toEqual([USER_A]);
    expect(advisories.get(USER_A)).toEqual({
      detectionId: 'd1',
      detector: 'signupNetworkBurst',
      result: 'insufficient_evidence',
      confidence: 0.7,
      assessedAt: new Date('2026-11-02T00:00:00Z'),
    });
  });

  it('prefers an abuse judgment over a newer non-abuse one', async () => {
    h.findForUsers.mockResolvedValue([detection('d2', [USER_A]), detection('d1', [USER_A])]);
    h.findLatestJudged.mockResolvedValue([
      assessment('d2', 'legitimate_automation', '2026-11-03T00:00:00Z'),
      assessment('d1', 'abuse', '2026-11-01T00:00:00Z'),
    ]);

    const advisories = await findRiskReviewAdvisories([USER_A]);

    expect(advisories.get(USER_A)).toMatchObject({ detectionId: 'd1', result: 'abuse' });
  });

  it('otherwise takes the newest judgment', async () => {
    h.findForUsers.mockResolvedValue([detection('d1', [USER_A]), detection('d2', [USER_A])]);
    h.findLatestJudged.mockResolvedValue([
      assessment('d1', 'insufficient_evidence', '2026-11-01T00:00:00Z'),
      assessment('d2', 'legitimate_automation', '2026-11-03T00:00:00Z'),
    ]);

    const advisories = await findRiskReviewAdvisories([USER_A]);

    expect(advisories.get(USER_A)).toMatchObject({ detectionId: 'd2', result: 'legitimate_automation' });
  });

  it('skips a detection with no judged assessment', async () => {
    h.findForUsers.mockResolvedValue([detection('d1', [USER_A])]);
    h.findLatestJudged.mockResolvedValue([]);

    const advisories = await findRiskReviewAdvisories([USER_A]);

    expect(advisories.size).toBe(0);
  });
});
