import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_ACTION_COUNT_CAP, ADMIN_ACTION_COUNT_KEYS } from '@client/app/components/admin/adminActionCounts';

const m = vi.hoisted(() => ({
  countWaiting: vi.fn(),
  countUnreviewed: vi.fn(),
  countPendingReview: vi.fn(),
  countHeld: vi.fn(),
  countPendingHolds: vi.fn(),
  countPendingRiskReviews: vi.fn(),
  countDecidable: vi.fn(),
  countReported: vi.fn(),
  countAdminResolvable: vi.fn(),
  countPendingSuggestions: vi.fn(),
  countOverdue: vi.fn(),
  countFailed: vi.fn(),
  countNewFeedback: vi.fn(),
  getQueueAttributes: vi.fn(),
  getDlqRegistry: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  subscriberRepository: { countWaiting: m.countWaiting },
  adminAuditLogRepository: { countUnreviewed: m.countUnreviewed },
  imageModerationIncidentRepository: { countPendingReview: m.countPendingReview },
  signupGrantReleaseRepository: { countHeld: m.countHeld },
  signupDomainHoldListRepository: { countPending: m.countPendingHolds },
  userRepository: { countPendingRiskReviews: m.countPendingRiskReviews },
  adminApprovalRepository: { countDecidable: m.countDecidable },
  publishedArtifactRepository: { countReported: m.countReported },
  stripeDisputeRepository: { countAdminResolvable: m.countAdminResolvable },
  modelDiscoveryStateRepository: { countPendingSuggestions: m.countPendingSuggestions },
  sreErrorTrackingRepository: { countFailed: m.countFailed },
  countNewFeedback: m.countNewFeedback,
}));
vi.mock('@bike4mind/database/infra', () => ({ secretRotationRepository: { countOverdue: m.countOverdue } }));
vi.mock('@bike4mind/observability', () => ({ Logger: { error: m.loggerError } }));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getDlqRegistry: m.getDlqRegistry,
  getDlqUrl: (label: string) => `https://sqs.test/${label}`,
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ getQueueAttributes: m.getQueueAttributes }));
vi.mock('@bike4mind/server-utils/lib/secretRotation/constants', () => ({
  getSecretRotationConfig: () => ({ JWT_SECRET: {}, OTHER_SECRET: {} }),
}));

import { computeAdminActionCounts, resetDeadLetterCountCacheForTests } from './actionCounts';

const NOW = new Date('2026-11-09T12:00:00.000Z');
const fullAdmin = { id: 'admin', isAdmin: true };

beforeEach(() => {
  vi.clearAllMocks();
  resetDeadLetterCountCacheForTests();
  for (const fn of [
    m.countWaiting,
    m.countPendingReview,
    m.countHeld,
    m.countPendingHolds,
    m.countPendingRiskReviews,
    m.countDecidable,
    m.countReported,
    m.countAdminResolvable,
    m.countPendingSuggestions,
    m.countOverdue,
    m.countFailed,
    m.countNewFeedback,
  ]) {
    fn.mockResolvedValue(1);
  }
  m.countUnreviewed.mockResolvedValue(1);
  m.getDlqRegistry.mockReturnValue([{ label: 'a' }, { label: 'b' }, { label: 'c' }]);
  m.getQueueAttributes.mockResolvedValue({ approximateMessageCount: 1, approximateNotVisibleCount: 5 });
});

describe('computeAdminActionCounts access gating', () => {
  it('gives a full admin every key', async () => {
    const counts = await computeAdminActionCounts(fullAdmin, 'admin', NOW);

    expect(Object.keys(counts).sort()).toEqual([...ADMIN_ACTION_COUNT_KEYS].sort());
  });

  it('gives a support:read delegate only the queues support:read acts on', async () => {
    const counts = await computeAdminActionCounts(
      { id: 'd', isAdmin: false, adminPermissions: ['support:read'] },
      'd',
      NOW
    );

    expect(Object.keys(counts).sort()).toEqual(['approvals', 'unreviewedAudit']);
  });

  it('gives a settings:manage and users:moderate delegate exactly those queues', async () => {
    const counts = await computeAdminActionCounts(
      { id: 'd', isAdmin: false, adminPermissions: ['settings:manage', 'users:moderate', 'credits:adjust'] },
      'd',
      NOW
    );

    expect(Object.keys(counts).sort()).toEqual(
      ['deadLetters', 'modelLifecycle', 'sreAgent', 'stripeDisputes', 'waitingSubscribers'].sort()
    );
  });

  it('gives a non-admin nothing and runs no counter', async () => {
    const counts = await computeAdminActionCounts({ id: 'u', isAdmin: false, adminPermissions: [] }, 'u', NOW);

    expect(counts).toEqual({});
    expect(m.countWaiting).not.toHaveBeenCalled();
    expect(m.getQueueAttributes).not.toHaveBeenCalled();
  });
});

describe('computeAdminActionCounts failures and caps', () => {
  it('reports a rejected counter as null and logs it, while the others resolve', async () => {
    m.countFailed.mockRejectedValue(new Error('mongo down'));

    const counts = await computeAdminActionCounts(fullAdmin, 'admin', NOW);

    expect(counts.sreAgent).toBeNull();
    expect(counts.feedback).toBe(1);
    expect(m.loggerError).toHaveBeenCalledWith(
      '[Admin] Action count failed',
      expect.objectContaining({ key: 'sreAgent', error: 'mongo down' })
    );
  });

  it('passes the cap to every capped query', async () => {
    await computeAdminActionCounts(fullAdmin, 'admin', NOW);

    const limit = { limit: ADMIN_ACTION_COUNT_CAP };
    expect(m.countWaiting).toHaveBeenCalledWith(limit);
    expect(m.countPendingReview).toHaveBeenCalledWith(limit);
    expect(m.countHeld).toHaveBeenCalledWith(undefined, limit);
    expect(m.countPendingHolds).toHaveBeenCalledWith(limit);
    expect(m.countPendingRiskReviews).toHaveBeenCalledWith(limit);
    expect(m.countReported).toHaveBeenCalledWith(limit);
    expect(m.countAdminResolvable).toHaveBeenCalledWith(limit);
    expect(m.countPendingSuggestions).toHaveBeenCalledWith(limit);
    expect(m.countFailed).toHaveBeenCalledWith(limit);
    expect(m.countNewFeedback).toHaveBeenCalledWith(limit);
    expect(m.countOverdue).toHaveBeenCalledWith({
      now: NOW,
      keyNames: ['JWT_SECRET', 'OTHER_SECRET'],
      limit: ADMIN_ACTION_COUNT_CAP,
    });
  });

  it('uses the capped unreviewed audit count', async () => {
    m.countUnreviewed.mockResolvedValue(ADMIN_ACTION_COUNT_CAP);

    const counts = await computeAdminActionCounts(fullAdmin, 'admin', NOW);

    expect(counts.unreviewedAudit).toBe(ADMIN_ACTION_COUNT_CAP);
    expect(m.countUnreviewed).toHaveBeenCalledWith({ viewerUserId: 'admin' }, { limit: ADMIN_ACTION_COUNT_CAP });
  });
});

describe('approvals count', () => {
  it('asks for rows decidable under the delegate permissions, excluding the viewer and impersonator', async () => {
    await computeAdminActionCounts(
      { id: 'target', isAdmin: false, adminPermissions: ['support:read', 'credits:adjust'] },
      'real-admin',
      NOW
    );

    expect(m.countDecidable).toHaveBeenCalledWith({
      now: NOW,
      viewerIds: ['target', 'real-admin'],
      permissions: ['support:read', 'credits:adjust'],
      fullAdmin: false,
      limit: ADMIN_ACTION_COUNT_CAP,
    });
  });

  it('lets a full admin decide every permission and full-admin-only rows', async () => {
    await computeAdminActionCounts(fullAdmin, 'admin', NOW);

    expect(m.countDecidable.mock.calls[0]?.[0]).toMatchObject({ viewerIds: ['admin'], fullAdmin: true });
    expect(m.countDecidable.mock.calls[0]?.[0].permissions).toContain('users:delete');
  });
});

describe('dead letters count', () => {
  const settingsManager = { id: 's', isAdmin: false, adminPermissions: ['settings:manage'] };

  it('sums visible messages, skipping a queue that failed or reported -1', async () => {
    m.getQueueAttributes
      .mockResolvedValueOnce({ approximateMessageCount: 3, approximateNotVisibleCount: 9 })
      .mockRejectedValueOnce(new Error('no queue'))
      .mockResolvedValueOnce({ approximateMessageCount: -1, approximateNotVisibleCount: 0 });

    const counts = await computeAdminActionCounts(settingsManager, 's', NOW);

    expect(counts.deadLetters).toBe(3);
  });

  it('is null when no queue answers', async () => {
    m.getQueueAttributes.mockRejectedValue(new Error('SQS unreachable'));

    const counts = await computeAdminActionCounts(settingsManager, 's', NOW);

    expect(counts.deadLetters).toBeNull();
  });

  it('caches the total for a minute and caps it', async () => {
    m.getQueueAttributes.mockResolvedValue({ approximateMessageCount: 80, approximateNotVisibleCount: 0 });

    const first = await computeAdminActionCounts(settingsManager, 's', NOW);
    const withinMinute = await computeAdminActionCounts(settingsManager, 's', new Date(NOW.getTime() + 59_000));
    expect(first.deadLetters).toBe(ADMIN_ACTION_COUNT_CAP);
    expect(withinMinute.deadLetters).toBe(ADMIN_ACTION_COUNT_CAP);
    expect(m.getQueueAttributes).toHaveBeenCalledTimes(3);

    await computeAdminActionCounts(settingsManager, 's', new Date(NOW.getTime() + 60_000));
    expect(m.getQueueAttributes).toHaveBeenCalledTimes(6);
  });
});
