import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Passthrough the wrapper so we drive the raw handler directly.
vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  claimDedup: vi.fn(),
  casDeleteDedup: vi.fn(),
  casUpdateDedup: vi.fn(),
  findDelivery: vi.fn(),
  recordAttempt: vi.fn(),
  findSubscription: vi.fn(),
  incrementConsecutiveFailuresAtomic: vi.fn(),
  resetConsecutiveFailures: vi.fn(),
  findByOrganizationId: vi.fn(),
  validateTargetUrl: vi.fn(),
  fetchMock: vi.fn(),
  SsrfError: class SsrfError extends Error {},
}));

vi.mock('@bike4mind/database', () => ({
  cacheRepository: { claimDedup: h.claimDedup, casDeleteDedup: h.casDeleteDedup, casUpdateDedup: h.casUpdateDedup },
  webhookDeliveryRepository: { recordAttempt: h.recordAttempt, findByDeliveryAndSubscription: h.findDelivery },
  webhookSubscriptionRepository: {
    findById: h.findSubscription,
    incrementConsecutiveFailuresAtomic: h.incrementConsecutiveFailuresAtomic,
    resetConsecutiveFailures: h.resetConsecutiveFailures,
  },
  orgWebhookConfigRepository: { findByOrganizationId: h.findByOrganizationId },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: class {} }));
vi.mock('@bike4mind/server-utils/security/secretEncryption', () => ({ decryptSecret: () => 'plain-secret' }));
vi.mock('@bike4mind/server-utils/utils/ssrfProtection', () => ({
  validateTargetUrl: h.validateTargetUrl,
  fetchPinned: h.fetchMock,
  SsrfError: h.SsrfError,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'test-key' } }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({
  recordWebhookDeliverySuccess: vi.fn(),
  recordWebhookDeliveryFailure: vi.fn(),
  recordWebhookDeliverySkipped: vi.fn(),
}));

import { WebhookDeliveryStatus } from '@bike4mind/common';
import { dispatch } from './webhookDelivery';
import { configureSecretsAtRest } from '@bike4mind/utils/security';

configureSecretsAtRest('a'.repeat(64));

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
    h.casUpdateDedup.mockResolvedValue(true);
    h.findDelivery.mockResolvedValue(null);
    h.findSubscription.mockResolvedValue({ id: 'sub-1', enabled: true });
    h.findByOrganizationId.mockResolvedValue({ secret: 'enc(secret)' });
    h.incrementConsecutiveFailuresAtomic.mockResolvedValue({ wasAutoDisabled: false, newFailureCount: 1 });
    h.fetchMock.mockResolvedValue({ ok: true, status: 200, headers: new Headers() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends through the pinned fetch with plain http allowed, not global fetch', async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);

    await runDispatch();

    expect(h.fetchMock).toHaveBeenCalledWith(TARGET_URL, expect.objectContaining({ method: 'POST' }), {
      allowHttp: true,
      discardBody: true,
    });
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('records a refused dialed address as a failed delivery without retrying', async () => {
    h.fetchMock.mockRejectedValue(new h.SsrfError('Blocked connection to a private address for x'));

    await expect(runDispatch()).resolves.toBeUndefined();

    expect(h.recordAttempt.mock.calls[0][0]).toMatchObject({
      status: WebhookDeliveryStatus.Failed,
      errorMessage: expect.stringMatching(/^Security error/),
    });
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

    expect(h.recordAttempt).toHaveBeenCalledTimes(1);
    expect(h.recordAttempt.mock.calls[0][0]).toMatchObject({
      status: WebhookDeliveryStatus.Failed,
      errorMessage: expect.stringMatching(/redirect/i),
    });
    expect(h.incrementConsecutiveFailuresAtomic).toHaveBeenCalledTimes(1);
  });

  it('records a 2xx response as a successful delivery', async () => {
    await runDispatch();

    expect(h.recordAttempt.mock.calls[0][0]).toMatchObject({ status: WebhookDeliveryStatus.Success });
    expect(h.resetConsecutiveFailures).toHaveBeenCalledWith('sub-1');
  });

  it('records a 200 with a large response body as delivered and cancels the body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: c => c.enqueue(new Uint8Array(1024)), cancel });
    h.fetchMock.mockResolvedValue(
      new Response(body, { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } })
    );

    await expect(runDispatch()).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalled();
    expect(h.recordAttempt.mock.calls[0][0]).toMatchObject({ status: WebhookDeliveryStatus.Success });
    expect(h.incrementConsecutiveFailuresAtomic).not.toHaveBeenCalled();
  });
  it.each([{ status: 'terminal' }, { status: 'completed' }, { status: 'completed', deliveryId: 'another-delivery' }])(
    'preserves event dedup without inventing history for receipt %j',
    async existingData => {
      h.claimDedup.mockResolvedValue({ claimed: false, existingData });

      await expect(runDispatch()).resolves.toBeUndefined();

      expect(h.fetchMock).not.toHaveBeenCalled();
      expect(h.findDelivery).not.toHaveBeenCalled();
      expect(h.recordAttempt).not.toHaveBeenCalled();
      expect(h.resetConsecutiveFailures).not.toHaveBeenCalled();
    }
  );

  it('propagates an uncertain pending-history read instead of acking or resending', async () => {
    h.claimDedup.mockResolvedValue({ claimed: false, existingData: { status: 'pending', owner: 'original' } });
    h.findDelivery.mockRejectedValueOnce(new Error('history unavailable'));

    await expect(runDispatch()).rejects.toThrow('history unavailable');

    expect(h.findDelivery).toHaveBeenCalledWith('del-1', 'sub-1');
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.casUpdateDedup).not.toHaveBeenCalled();
  });

  it('retains accepted history without changing a replacement claim', async () => {
    h.casUpdateDedup.mockResolvedValue(false);

    await expect(runDispatch()).rejects.toThrow('claim changed');

    expect(h.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ status: WebhookDeliveryStatus.Success }));
    expect(h.casDeleteDedup).not.toHaveBeenCalled();
    expect(h.incrementConsecutiveFailuresAtomic).not.toHaveBeenCalled();
  });

  describe('dedup claim on a failed attempt', () => {
    const claimOwner = () => h.claimDedup.mock.calls[0][1].owner as string;

    it.each([
      ['a 5xx', () => h.fetchMock.mockResolvedValue({ ok: false, status: 503, headers: new Headers() })],
      ['a 429', () => h.fetchMock.mockResolvedValue({ ok: false, status: 429, headers: new Headers() })],
      ['a network error', () => h.fetchMock.mockRejectedValue(new TypeError('fetch failed'))],
      [
        'a DB error recording the failure',
        () => {
          h.fetchMock.mockResolvedValue({ ok: false, status: 500, headers: new Headers() });
          h.recordAttempt.mockRejectedValueOnce(new Error('db down'));
        },
      ],
    ])('releases its own claim before throwing on %s', async (_label, arrange) => {
      arrange();

      await expect(runDispatch()).rejects.toThrow();

      expect(claimOwner()).toEqual(expect.any(String));
      expect(h.casDeleteDedup).toHaveBeenCalledWith('webhook-delivery-evt-1-sub-1', 'owner', claimOwner());
    });

    it('keeps the claim when the endpoint accepted the POST but a later write failed', async () => {
      h.recordAttempt.mockRejectedValueOnce(new Error('db down'));

      await expect(runDispatch()).rejects.toThrow('db down');

      expect(h.casUpdateDedup).toHaveBeenCalledWith(
        'webhook-delivery-evt-1-sub-1',
        'owner',
        claimOwner(),
        expect.objectContaining({ status: 'completed', owner: claimOwner(), deliveryId: 'del-1', httpStatus: 200 }),
        60 * 60 * 1000
      );
      expect(h.incrementConsecutiveFailuresAtomic).not.toHaveBeenCalled();
      expect(h.casDeleteDedup).not.toHaveBeenCalled();
    });

    it('still throws the original error when releasing the claim fails', async () => {
      h.fetchMock.mockResolvedValue({ ok: false, status: 502, headers: new Headers() });
      h.casDeleteDedup.mockRejectedValueOnce(new Error('cache down'));

      await expect(runDispatch()).rejects.toThrow('HTTP 502');
    });

    it('does not release the claim on a permanent failure, which is acked', async () => {
      h.fetchMock.mockResolvedValue({ ok: false, status: 404, headers: new Headers() });

      await expect(runDispatch()).resolves.toBeUndefined();

      expect(h.casDeleteDedup).not.toHaveBeenCalled();
    });
  });
});
