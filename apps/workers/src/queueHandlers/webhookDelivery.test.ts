import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Passthrough the wrapper so we drive the raw handler directly.
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  claimDedup: vi.fn(),
  createOrUpdate: vi.fn(),
  createIfNotExists: vi.fn(),
  findSubscription: vi.fn(),
  incrementConsecutiveFailuresAtomic: vi.fn(),
  resetConsecutiveFailures: vi.fn(),
  findByOrganizationId: vi.fn(),
  validateTargetUrl: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  cacheRepository: { claimDedup: h.claimDedup, createOrUpdate: h.createOrUpdate },
  webhookDeliveryRepository: { createIfNotExists: h.createIfNotExists },
  webhookSubscriptionRepository: {
    findById: h.findSubscription,
    incrementConsecutiveFailuresAtomic: h.incrementConsecutiveFailuresAtomic,
    resetConsecutiveFailures: h.resetConsecutiveFailures,
  },
  orgWebhookConfigRepository: { findByOrganizationId: h.findByOrganizationId },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: class {} }));
vi.mock('@bike4mind/server-utils/security/secretEncryption', () => ({ decryptSecret: () => 'plain-secret' }));
vi.mock('@server/utils/ssrfProtection', () => ({ validateTargetUrl: h.validateTargetUrl }));
vi.mock('@server/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'test-key' } }));
vi.mock('@server/utils/cloudwatch', () => ({
  recordWebhookDeliverySuccess: vi.fn(),
  recordWebhookDeliveryFailure: vi.fn(),
  recordWebhookDeliverySkipped: vi.fn(),
}));

import { WebhookDeliveryStatus } from '@bike4mind/common';
import { dispatch } from './webhookDelivery';

const TARGET_URL = 'https://hooks.example.com/endpoint';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };

const sqsEvent = {
  Records: [
    {
      body: JSON.stringify({
        eventId: 'evt-1',
        deliveryId: 'del-1',
        subscriptionId: 'sub-1',
        userId: 'user-1',
        orgId: 'org-1',
        targetUrl: TARGET_URL,
        payload: { action: 'opened' },
        eventType: 'pull_request',
        repository: 'acme/repo',
        attempt: 1,
        correlationId: 'corr-1',
      }),
    },
  ],
};

const runDispatch = () =>
  (dispatch as unknown as (event: unknown, context: unknown, log: unknown) => Promise<void>)(sqsEvent, {}, logger);

describe('webhookDelivery dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.validateTargetUrl.mockResolvedValue({ valid: true });
    h.claimDedup.mockResolvedValue({ claimed: true });
    h.findSubscription.mockResolvedValue({ id: 'sub-1', enabled: true });
    h.findByOrganizationId.mockResolvedValue({ secret: 'enc(secret)' });
    h.incrementConsecutiveFailuresAtomic.mockResolvedValue({ wasAutoDisabled: false, newFailureCount: 1 });
    h.fetchMock.mockResolvedValue({ ok: true, status: 200, headers: new Headers() });
    vi.stubGlobal('fetch', h.fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not follow redirects from the target URL', async () => {
    await runDispatch();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.fetchMock.mock.calls[0][0]).toBe(TARGET_URL);
    expect(h.fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('records a redirect response as a failed delivery without throwing, so it is not retried', async () => {
    h.fetchMock.mockResolvedValue({ ok: false, status: 302, headers: new Headers() });

    await expect(runDispatch()).resolves.toBeUndefined();

    expect(h.createIfNotExists).toHaveBeenCalledTimes(1);
    expect(h.createIfNotExists.mock.calls[0][0]).toMatchObject({
      status: WebhookDeliveryStatus.Failed,
      errorMessage: expect.stringMatching(/redirect/i),
    });
    expect(h.incrementConsecutiveFailuresAtomic).toHaveBeenCalledTimes(1);
  });

  it('records a 2xx response as a successful delivery', async () => {
    await runDispatch();

    expect(h.createIfNotExists.mock.calls[0][0]).toMatchObject({ status: WebhookDeliveryStatus.Success });
    expect(h.resetConsecutiveFailures).toHaveBeenCalledWith('sub-1');
  });
});
