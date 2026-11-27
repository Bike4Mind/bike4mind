import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';

const h = vi.hoisted(() => ({
  publish: vi.fn(),
  smtpSendEmail: vi.fn(),
  findLake: vi.fn(),
  listGrants: vi.fn(),
  findOrganization: vi.fn(),
  findActiveEmailsByIds: vi.fn(),
  claimNotification: vi.fn(),
  markDelivered: vi.fn(),
  deleteClaim: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { findById: h.findLake },
  dataLakeAccessGrantRepository: { listByLake: h.listGrants },
  organizationRepository: { findById: h.findOrganization },
  userRepository: { findActiveEmailsByIds: h.findActiveEmailsByIds },
  dataLakeSpendNotificationRepository: {
    claimNotification: h.claimNotification,
    markDelivered: h.markDelivered,
    delete: h.deleteClaim,
  },
}));
// The real queuedMailer runs: the event bus is the seam, and the SMTP mailer must stay untouched.
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));
vi.mock('@bike4mind/server-utils/utils/mailer/index', () => ({ default: { sendEmail: h.smtpSendEmail } }));

import { makeDataLakeSpendNotifier } from './dataLakeSpendNotifier';

const event = {
  dataLakeId: 'lake-1',
  kind: 'budget_exhausted' as const,
  scope: 'lake' as const,
  periodKey: 'lake:100000000',
  detail: { spentMicroUsd: 5_000_000, budgetMicroUsd: 5_000_000 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('B4M_SELF_HOST', 'false');
  h.findLake.mockResolvedValue({
    id: 'lake-1',
    name: 'Research Lake',
    createdByUserId: 'owner-1',
    organizationId: null,
  });
  h.listGrants.mockResolvedValue([]);
  h.findOrganization.mockResolvedValue(null);
  h.findActiveEmailsByIds.mockResolvedValue([{ id: 'owner-1', email: 'owner@example.org' }]);
  h.claimNotification.mockResolvedValue({ claimed: true, id: 'claim-1' });
  h.markDelivered.mockResolvedValue(undefined);
  h.deleteClaim.mockResolvedValue(undefined);
  h.publish.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'event-1' }] });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('makeDataLakeSpendNotifier', () => {
  it('publishes the spend alert for the lake owner as an email.send event', async () => {
    await expect(makeDataLakeSpendNotifier()(event)).resolves.toBe('sent');

    expect(h.publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: 'owner@example.org',
        subject: '"Research Lake" has reached its embedding budget',
        body: expect.stringContaining('Research Lake'),
      })
    );
    expect(h.smtpSendEmail).not.toHaveBeenCalled();
    expect(h.markDelivered).toHaveBeenCalledWith('claim-1', {
      recipientUserIds: ['owner-1'],
      deliveredCount: 1,
      deliveryFailed: false,
    });
  });

  it('publishes one event per recipient so no address is shared', async () => {
    h.findLake.mockResolvedValue({
      id: 'lake-1',
      name: 'Research Lake',
      createdByUserId: 'owner-1',
      organizationId: 'org-1',
    });
    h.findOrganization.mockResolvedValue({ userId: 'org-owner', adminUserIds: ['admin-2'] });
    h.findActiveEmailsByIds.mockResolvedValue([
      { id: 'owner-1', email: 'owner@example.org' },
      { id: 'org-owner', email: 'billing@example.org' },
      { id: 'admin-2', email: 'admin@example.org' },
    ]);

    await expect(makeDataLakeSpendNotifier()(event)).resolves.toBe('sent');

    expect(h.publish.mock.calls.map(([detail]) => detail.to).sort()).toEqual([
      'admin@example.org',
      'billing@example.org',
      'owner@example.org',
    ]);
  });

  it('publishes nothing when the lake was already notified this period', async () => {
    h.claimNotification.mockResolvedValue({ claimed: false });

    await expect(makeDataLakeSpendNotifier()(event)).resolves.toBe('deduped');

    expect(h.publish).not.toHaveBeenCalled();
  });

  it('reports the notification failed when the event cannot be queued', async () => {
    h.publish.mockRejectedValue(new Error('bus unreachable'));
    vi.spyOn(Logger, 'error').mockImplementation(() => {});

    await expect(makeDataLakeSpendNotifier()(event)).resolves.toBe('failed');

    expect(h.smtpSendEmail).not.toHaveBeenCalled();
    expect(h.markDelivered).toHaveBeenCalledWith('claim-1', {
      recipientUserIds: ['owner-1'],
      deliveredCount: 0,
      deliveryFailed: true,
    });
  });
});
