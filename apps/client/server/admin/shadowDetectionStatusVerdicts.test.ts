import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import type { ShadowDetectionItem } from '@bike4mind/common';
import { gradeDetectionsForStatusChange, type AccountStatusChange } from './shadowDetectionStatusVerdicts';

const { mockGradeForSuspension, mockGradeForReinstatement, mockRevertSuspensionGrades } = vi.hoisted(() => ({
  mockGradeForSuspension: vi.fn(),
  mockGradeForReinstatement: vi.fn(),
  mockRevertSuspensionGrades: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  shadowDetectionRepository: {
    gradeForSuspension: mockGradeForSuspension,
    gradeForReinstatement: mockGradeForReinstatement,
    revertSuspensionGrades: mockRevertSuspensionGrades,
  },
}));

const USER_ID = 'a'.repeat(24);
const ADMIN_ID = 'b'.repeat(24);

const gradedItem = (verdict: 'confirmed_abuse' | 'legitimate_human' | null): ShadowDetectionItem => ({
  id: 'c'.repeat(24),
  detector: 'signupNetworkBurst',
  policyVersion: 1,
  wouldAction: 'contain',
  summary: '3 signups from one IP in 180 minutes',
  userIds: [USER_ID],
  network: null,
  signals: [],
  windowMinutes: 180,
  group: null,
  payment: null,
  detectedAt: new Date('2026-10-01T00:00:00Z'),
  verdict,
  verdicts: [],
  revision: 1,
});

const writeAudit = vi.fn();
const releaseHolds = vi.fn();
const logger = { error: vi.fn() } as unknown as Logger;

const change = (overrides: Partial<AccountStatusChange>): AccountStatusChange => ({
  userId: USER_ID,
  adminId: ADMIN_ID,
  wasSuspended: false,
  isSuspended: true,
  reason: 'Abuse / automated signups',
  ...overrides,
});

const run = (overrides: Partial<AccountStatusChange>) =>
  gradeDetectionsForStatusChange(change(overrides), { writeAudit, logger, releaseHolds });

describe('gradeDetectionsForStatusChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGradeForSuspension.mockResolvedValue([gradedItem('confirmed_abuse')]);
    mockGradeForReinstatement.mockResolvedValue([gradedItem('legitimate_human')]);
    mockRevertSuspensionGrades.mockResolvedValue([gradedItem(null)]);
    writeAudit.mockResolvedValue(null);
    releaseHolds.mockResolvedValue([]);
  });

  it("releases the reinstated account's automated holds on the detections it grades legitimate", async () => {
    releaseHolds.mockResolvedValue([{ decisionId: 'decision-1', userIds: [USER_ID] }]);
    await run({ wasSuspended: true, isSuspended: false, reason: 'Verified customer' });

    expect(releaseHolds).toHaveBeenCalledExactlyOnceWith(
      'c'.repeat(24),
      expect.objectContaining({ by: ADMIN_ID, userIds: [USER_ID] })
    );
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.intervention_hold.released',
        target: expect.objectContaining({ id: USER_ID }),
      })
    );
  });

  it('releases no hold on a suspension or an undone suspension', async () => {
    await run({});
    await run({ wasSuspended: true, isSuspended: false, undo: true });
    expect(releaseHolds).not.toHaveBeenCalled();
  });

  it('grades the account confirmed abuse when it is suspended for abuse, citing the suspension', async () => {
    const graded = await run({ reason: 'Payment fraud: card testing' });

    expect(graded).toHaveLength(1);
    expect(mockGradeForSuspension).toHaveBeenCalledExactlyOnceWith({
      userId: USER_ID,
      reviewerId: ADMIN_ID,
      reason: 'Account suspended: Payment fraud: card testing',
    });
    expect(mockGradeForReinstatement).not.toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: 'security.detection.reviewed',
        reason: 'Account suspended: Payment fraud: card testing',
        details: expect.objectContaining({ verdict: 'confirmed_abuse', source: 'suspension' }),
      })
    );
  });

  it('leaves detections alone when the suspension reason is not abuse', async () => {
    expect(await run({ reason: 'Customer request' })).toEqual([]);
    expect(mockGradeForSuspension).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('grades the account legitimate human use when it is reinstated', async () => {
    await run({ wasSuspended: true, isSuspended: false, reason: 'Suspended in error' });

    expect(mockGradeForReinstatement).toHaveBeenCalledExactlyOnceWith({
      userId: USER_ID,
      reviewerId: ADMIN_ID,
      reason: 'Account reinstated: Suspended in error',
    });
    expect(mockGradeForSuspension).not.toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ source: 'reinstatement' }) })
    );
  });

  it.each([
    ['the status did not change', { wasSuspended: true, isSuspended: true }],
    ['the change carried no reason', { reason: undefined }],
  ])('does nothing when %s', async (_label, overrides) => {
    expect(await run(overrides)).toEqual([]);
    expect(mockGradeForSuspension).not.toHaveBeenCalled();
    expect(mockGradeForReinstatement).not.toHaveBeenCalled();
  });

  it("removes the suspension's grades instead of grading legitimate when the reinstatement is an undo", async () => {
    const graded = await run({ wasSuspended: true, isSuspended: false, reason: 'Undo: Abuse', undo: true });

    expect(mockRevertSuspensionGrades).toHaveBeenCalledWith({
      userId: USER_ID,
      reviewerId: ADMIN_ID,
      reason: 'Account reinstated: Undo: Abuse',
    });
    expect(mockGradeForReinstatement).not.toHaveBeenCalled();
    expect(graded).toEqual([gradedItem(null)]);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'security.detection.reviewed',
        summary: expect.stringContaining("by undoing the account's suspension"),
        details: expect.objectContaining({ source: 'suspension_undone', verdict: null }),
      })
    );
  });

  it('ignores the undo flag on a suspension', async () => {
    await run({ undo: true });

    expect(mockGradeForSuspension).toHaveBeenCalled();
    expect(mockRevertSuspensionGrades).not.toHaveBeenCalled();
  });

  it('logs instead of throwing when grading or its audit entry fails', async () => {
    mockGradeForSuspension.mockRejectedValueOnce(new Error('db down'));
    await expect(run({})).resolves.toEqual([]);

    writeAudit.mockRejectedValueOnce(new Error('audit down'));
    await expect(run({})).resolves.toHaveLength(1);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});
