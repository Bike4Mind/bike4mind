/**
 * processOrgWebhook delivery-status classification tests.
 *
 * Pins down the 5-way priority chain for delivery-status classification.
 * Each branch must produce the correct WebhookDeliveryStatus:
 *   1. handler threw                  -> Failed (handler-wide)
 *   2. per-user notification failure  -> Failed (specific user)
 *   3. notified successfully          -> Success
 *   4. notification dispatch error    -> Failed (unclassified valid subscribers)
 *   5. fell through                   -> Skipped (not a target)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockFindByOrgAndRepo,
  mockFindByDeliveryAndSubscription,
  mockCreateIfNotExists,
  mockFindOrgById,
  mockUpdateAuditLogByDeliveryId,
  mockHandle,
  mockGetHandler,
  mockDispatchReviewToSreRevision,
  mockEmitWebhookDeliveryMetric,
} = vi.hoisted(() => ({
  mockFindByOrgAndRepo: vi.fn(),
  mockFindByDeliveryAndSubscription: vi.fn(),
  mockCreateIfNotExists: vi.fn(),
  mockFindOrgById: vi.fn(),
  mockUpdateAuditLogByDeliveryId: vi.fn(),
  mockHandle: vi.fn(),
  mockGetHandler: vi.fn(),
  mockDispatchReviewToSreRevision: vi.fn(),
  mockEmitWebhookDeliveryMetric: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  webhookSubscriptionRepository: {
    findByOrgAndRepo: mockFindByOrgAndRepo,
  },
  webhookDeliveryRepository: {
    findByDeliveryAndSubscription: mockFindByDeliveryAndSubscription,
    createIfNotExists: mockCreateIfNotExists,
  },
  organizationRepository: {
    findById: mockFindOrgById,
  },
  webhookAuditLogRepository: {
    updateByDeliveryId: mockUpdateAuditLogByDeliveryId,
  },
  mcpServerRepository: { findById: vi.fn() },
  cacheRepository: { findByKey: vi.fn(), createOrUpdate: vi.fn() },
}));

vi.mock('@server/integrations/github/handlers', () => ({
  createHandlerRegistry: vi.fn().mockReturnValue({}),
  getHandler: mockGetHandler,
}));

vi.mock('@server/integrations/github/sreRevisionDispatch', () => ({
  dispatchReviewToSreRevision: mockDispatchReviewToSreRevision,
}));

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger:
    (fn: (event: unknown, ctx: unknown, logger: unknown) => unknown) =>
    (event: unknown, ctx: unknown, logger: unknown) =>
      fn(event, ctx, logger),
}));

vi.mock('@server/utils/cloudwatch', () => ({
  emitWebhookDeliveryMetric: mockEmitWebhookDeliveryMetric,
  WebhookMetrics: {
    DELIVERY_ATTEMPTED: 'DeliveryAttempted',
    DELIVERY_SUCCEEDED: 'DeliverySucceeded',
    DELIVERY_FAILED: 'DeliveryFailed',
    DELIVERY_SKIPPED: 'DeliverySkipped',
  },
}));

import { dispatch } from './githubWebhook';
import { WebhookDeliveryStatus } from '@bike4mind/common';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  updateMetadata: vi.fn(),
} as never;

const mockContext = {} as never;

function makeSqsEvent(body: Record<string, unknown>) {
  return { Records: [{ body: JSON.stringify(body) }] } as never;
}

function makeOrgMessage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    deliveryId: 'delivery-1',
    eventType: 'pull_request_review',
    payload: { repository: { full_name: 'owner/repo' } },
    orgId: 'org-1',
    isOrgWebhook: true as const,
    receivedAt: new Date().toISOString(),
    correlationId: 'corr-1',
    ...overrides,
  };
}

function makeSubscriber(userId: string, idSuffix: string = userId) {
  return {
    id: `sub-${idSuffix}`,
    userId,
    events: [],
  };
}

const mockOrg = {
  userId: 'org-owner',
  managerId: 'org-manager',
  users: [{ userId: 'user-a' }, { userId: 'user-b' }, { userId: 'user-c' }],
};

describe('processOrgWebhook — delivery-status priority chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOrgById.mockResolvedValue(mockOrg);
    mockFindByDeliveryAndSubscription.mockResolvedValue(null); // no prior delivery
    mockCreateIfNotExists.mockResolvedValue(undefined);
    mockUpdateAuditLogByDeliveryId.mockResolvedValue(undefined);
    mockDispatchReviewToSreRevision.mockResolvedValue(undefined);
    mockGetHandler.mockReturnValue({ handle: mockHandle });
    mockHandle.mockResolvedValue({ notifiedUserIds: [], failedNotifications: [] });
    mockEmitWebhookDeliveryMetric.mockResolvedValue(undefined);
  });

  function deliveryStatusFor(userId: string): WebhookDeliveryStatus | undefined {
    const call = mockCreateIfNotExists.mock.calls.find(c => (c[0] as { userId: string }).userId === userId);
    return call ? (call[0] as { status: WebhookDeliveryStatus }).status : undefined;
  }

  function deliveryErrorFor(userId: string): string | undefined {
    const call = mockCreateIfNotExists.mock.calls.find(c => (c[0] as { userId: string }).userId === userId);
    return call ? (call[0] as { errorMessage?: string }).errorMessage : undefined;
  }

  describe('priority 1: handler throws', () => {
    it('marks all valid subscribers Failed with the handler error', async () => {
      mockFindByOrgAndRepo.mockResolvedValue([makeSubscriber('user-a'), makeSubscriber('user-b')]);
      mockHandle.mockRejectedValue(new Error('boom'));

      await dispatch(makeSqsEvent(makeOrgMessage()), mockContext, mockLogger);

      expect(deliveryStatusFor('user-a')).toBe(WebhookDeliveryStatus.Failed);
      // Raw handler error is sanitized to a generic label for the DLQ dashboard;
      // the full message remains in structured logs.
      expect(deliveryErrorFor('user-a')).toBe('Handler failed to process event');
      expect(deliveryStatusFor('user-b')).toBe(WebhookDeliveryStatus.Failed);
      expect(deliveryErrorFor('user-b')).toBe('Handler failed to process event');
    });
  });

  describe('priority 2: per-user notification failure', () => {
    it('surfaces known Slack error codes verbatim, leaves non-targets as Skipped', async () => {
      mockFindByOrgAndRepo.mockResolvedValue([makeSubscriber('user-a'), makeSubscriber('user-b')]);
      mockHandle.mockResolvedValue({
        notifiedUserIds: [],
        failedNotifications: [{ userId: 'user-a', error: 'channel_not_found' }],
      });

      await dispatch(makeSqsEvent(makeOrgMessage()), mockContext, mockLogger);

      expect(deliveryStatusFor('user-a')).toBe(WebhookDeliveryStatus.Failed);
      // Slack API codes are known-safe and pass through the sanitizer.
      expect(deliveryErrorFor('user-a')).toBe('Slack delivery failed: channel_not_found');
      // user-b was not a target -> Skipped, not Failed (no dispatch error in this scenario)
      expect(deliveryStatusFor('user-b')).toBe(WebhookDeliveryStatus.Skipped);
    });

    it('collapses unknown per-user errors to a generic label', async () => {
      // Defensive: contradictory result with same userId in both sets - Failed wins.
      // Unknown error strings (no Slack code) are sanitized to avoid leaking infra details.
      mockFindByOrgAndRepo.mockResolvedValue([makeSubscriber('user-a')]);
      mockHandle.mockResolvedValue({
        notifiedUserIds: ['user-a'],
        failedNotifications: [{ userId: 'user-a', error: 'late retry failed' }],
      });

      await dispatch(makeSqsEvent(makeOrgMessage()), mockContext, mockLogger);

      expect(deliveryStatusFor('user-a')).toBe(WebhookDeliveryStatus.Failed);
      expect(deliveryErrorFor('user-a')).toBe('Slack delivery failed');
    });
  });

  describe('priority 3: notified successfully', () => {
    it('marks the notified subscriber Success', async () => {
      mockFindByOrgAndRepo.mockResolvedValue([makeSubscriber('user-a'), makeSubscriber('user-b')]);
      mockHandle.mockResolvedValue({
        notifiedUserIds: ['user-a'],
        failedNotifications: [],
      });

      await dispatch(makeSqsEvent(makeOrgMessage()), mockContext, mockLogger);

      expect(deliveryStatusFor('user-a')).toBe(WebhookDeliveryStatus.Success);
      expect(deliveryStatusFor('user-b')).toBe(WebhookDeliveryStatus.Skipped);
    });
  });

  describe('priority 4: dispatch error', () => {
    it('marks all unclassified valid subscribers Failed with the dispatch error', async () => {
      mockFindByOrgAndRepo.mockResolvedValue([
        makeSubscriber('user-a'),
        makeSubscriber('user-b'),
        makeSubscriber('user-c'),
      ]);
      mockHandle.mockResolvedValue({
        notifiedUserIds: [],
        failedNotifications: [],
        notificationDispatchError: 'No active Slack workspace with bot token',
      });

      await dispatch(makeSqsEvent(makeOrgMessage()), mockContext, mockLogger);

      for (const userId of ['user-a', 'user-b', 'user-c']) {
        expect(deliveryStatusFor(userId)).toBe(WebhookDeliveryStatus.Failed);
        // The already-safe sentinel string passes through the sanitizer.
        expect(deliveryErrorFor(userId)).toBe('No active Slack workspace with bot token');
      }
    });

    it('still uses per-user failure (priority 2) when both per-user and dispatch errors are present', async () => {
      mockFindByOrgAndRepo.mockResolvedValue([makeSubscriber('user-a'), makeSubscriber('user-b')]);
      mockHandle.mockResolvedValue({
        notifiedUserIds: [],
        failedNotifications: [{ userId: 'user-a', error: 'specific Slack 500' }],
        notificationDispatchError: 'partial dispatch failure',
      });

      await dispatch(makeSqsEvent(makeOrgMessage()), mockContext, mockLogger);

      // Unknown per-user error -> generic label.
      expect(deliveryErrorFor('user-a')).toBe('Slack delivery failed');
      // user-b falls through to the dispatch-error branch; unknown prefix -> generic label.
      expect(deliveryStatusFor('user-b')).toBe(WebhookDeliveryStatus.Failed);
      expect(deliveryErrorFor('user-b')).toBe('Notification dispatch failed');
    });

    it('still uses notifiedSet (priority 3) for users actually notified, even with dispatch error', async () => {
      // Edge case: dispatch error fires for some downstream reason but a user was already notified.
      mockFindByOrgAndRepo.mockResolvedValue([makeSubscriber('user-a'), makeSubscriber('user-b')]);
      mockHandle.mockResolvedValue({
        notifiedUserIds: ['user-a'],
        failedNotifications: [],
        notificationDispatchError: 'something else broke',
      });

      await dispatch(makeSqsEvent(makeOrgMessage()), mockContext, mockLogger);

      expect(deliveryStatusFor('user-a')).toBe(WebhookDeliveryStatus.Success);
      expect(deliveryStatusFor('user-b')).toBe(WebhookDeliveryStatus.Failed);
    });
  });

  describe('priority 5: not a target', () => {
    it('marks valid subscribers Skipped when handler succeeds but they were not targets', async () => {
      // This scenario used to be the *only* outcome because notification failures
      // were silently dropped. Now it should only fire when notification truly
      // didn't apply to this subscriber.
      mockFindByOrgAndRepo.mockResolvedValue([makeSubscriber('user-a'), makeSubscriber('user-b')]);
      mockHandle.mockResolvedValue({
        notifiedUserIds: ['user-a'],
        failedNotifications: [],
      });

      await dispatch(makeSqsEvent(makeOrgMessage()), mockContext, mockLogger);

      expect(deliveryStatusFor('user-b')).toBe(WebhookDeliveryStatus.Skipped);
      expect(deliveryErrorFor('user-b')).toBe('Event processed but user was not a notification target');
    });
  });

  describe('CloudWatch DeliveryFailed metric emission', () => {
    it('emits DeliveryFailed=count when the handler throws (errorType=handler_threw)', async () => {
      mockFindByOrgAndRepo.mockResolvedValue([
        makeSubscriber('user-a'),
        makeSubscriber('user-b'),
        makeSubscriber('user-c'),
      ]);
      mockHandle.mockRejectedValue(new Error('boom'));

      await dispatch(makeSqsEvent(makeOrgMessage()), mockContext, mockLogger);

      const calls = mockEmitWebhookDeliveryMetric.mock.calls;
      const handlerCall = calls.find(c => (c[2] as { errorType?: string }).errorType === 'handler_threw');
      expect(handlerCall).toBeDefined();
      expect(handlerCall![0]).toBe('DeliveryFailed');
      expect(handlerCall![1]).toBe(3); // all valid subscribers
    });

    it('emits DeliveryFailed=count for per-user failures (errorType=per_user_notification)', async () => {
      mockFindByOrgAndRepo.mockResolvedValue([makeSubscriber('user-a'), makeSubscriber('user-b')]);
      mockHandle.mockResolvedValue({
        notifiedUserIds: [],
        failedNotifications: [
          { userId: 'user-a', error: 'channel_not_found' },
          { userId: 'user-b', error: 'account_inactive' },
        ],
      });

      await dispatch(makeSqsEvent(makeOrgMessage()), mockContext, mockLogger);

      const perUserCall = mockEmitWebhookDeliveryMetric.mock.calls.find(
        c => (c[2] as { errorType?: string }).errorType === 'per_user_notification'
      );
      expect(perUserCall).toBeDefined();
      expect(perUserCall![1]).toBe(2);
    });

    it('emits DeliveryFailed for unclassified subscribers on dispatch error (errorType=notification_dispatch)', async () => {
      mockFindByOrgAndRepo.mockResolvedValue([
        makeSubscriber('user-a'),
        makeSubscriber('user-b'),
        makeSubscriber('user-c'),
      ]);
      mockHandle.mockResolvedValue({
        notifiedUserIds: ['user-a'],
        failedNotifications: [],
        notificationDispatchError: 'No active Slack workspace with bot token',
      });

      await dispatch(makeSqsEvent(makeOrgMessage()), mockContext, mockLogger);

      const dispatchCall = mockEmitWebhookDeliveryMetric.mock.calls.find(
        c => (c[2] as { errorType?: string }).errorType === 'notification_dispatch'
      );
      expect(dispatchCall).toBeDefined();
      expect(dispatchCall![1]).toBe(2); // user-b and user-c, user-a was notified
    });

    it('does not emit DeliveryFailed on the happy path', async () => {
      mockFindByOrgAndRepo.mockResolvedValue([makeSubscriber('user-a')]);
      mockHandle.mockResolvedValue({
        notifiedUserIds: ['user-a'],
        failedNotifications: [],
      });

      await dispatch(makeSqsEvent(makeOrgMessage()), mockContext, mockLogger);

      const failedCalls = mockEmitWebhookDeliveryMetric.mock.calls.filter(c => c[0] === 'DeliveryFailed');
      expect(failedCalls).toHaveLength(0);
    });
  });
});
