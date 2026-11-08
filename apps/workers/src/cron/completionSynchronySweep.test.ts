import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn(), record: vi.fn(), exposure: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  loadCompletionSynchronyEvents: mocks.load,
  loadCompletionCohortExposure: mocks.exposure,
  shadowDetectionRepository: { recordCompletionSynchrony: mocks.record },
}));
import { sweepCompletionSynchrony } from './completionSynchronySweep';
const now = new Date('2026-01-01T12:00:00Z');
const events = [0, 120, 240].flatMap(second =>
  ['account-a', 'account-b', 'account-c'].map((userId, i) => ({
    eventId: `${second}-${i}`,
    userId,
    at: new Date(now.getTime() - 600_000 + second * 1000 + i * 200),
    requestedModel: second === 240 ? 'model-beta' : 'model-alpha',
    outcome: 'daily_cap_rejected' as const,
  }))
);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue({ events, rowsScanned: 9, accountsScanned: 3, legacyRows: 2, truncated: false });
  mocks.record.mockResolvedValue('created');
  mocks.exposure.mockResolvedValue({
    accounts: [{ userId: 'account-a', creditsCharged: 12, grantFundedCredits: 5, unknownFundingCredits: 7 }],
    truncated: false,
  });
});
describe('synchronized completion sweep', () => {
  it('discovers accounts outside existing flags and preserves cap-rejected starts', async () => {
    expect(await sweepCompletionSynchrony({ now })).toMatchObject({
      patterns: 1,
      legacyRows: 2,
      recorded: { created: 1 },
    });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        detector: 'completionSynchrony',
        wouldAction: 'none',
        userIds: ['account-a', 'account-b', 'account-c'],
        completionSynchrony: expect.objectContaining({
          bursts: 3,
          synchronizedModelSwitches: 1,
          completedRequests: 0,
          dailyCapRejectedRequests: 9,
          legacyRows: 2,
          creditExposure: expect.objectContaining({
            creditsCharged: 12,
            grantFundedCredits: 5,
            unknownFundingCredits: 7,
          }),
        }),
      })
    );
    expect(mocks.record.mock.calls[0][0]).not.toHaveProperty('verdict');
  });
  it('keeps timing observations when optional spending evidence is unavailable', async () => {
    mocks.exposure.mockRejectedValueOnce(new Error('Usage evidence unavailable'));
    const onRecordError = vi.fn();
    expect(await sweepCompletionSynchrony({ now, onRecordError })).toMatchObject({
      patterns: 1,
      exposureFailed: true,
      failed: 0,
      recorded: { created: 1 },
    });
    expect(mocks.record.mock.calls[0][0].completionSynchrony.creditExposure).toBeUndefined();
    expect(onRecordError).toHaveBeenCalledTimes(1);
  });

  it('reports capped coverage and storage failures', async () => {
    const onRecordError = vi.fn();
    mocks.load.mockResolvedValue({ events, rowsScanned: 9, accountsScanned: 3, legacyRows: 0, truncated: true });
    mocks.record.mockRejectedValue(new Error('Storage unavailable'));
    expect(await sweepCompletionSynchrony({ now, onRecordError })).toMatchObject({ scanTruncated: true, failed: 1 });
    expect(onRecordError).toHaveBeenCalledTimes(1);
  });
});
