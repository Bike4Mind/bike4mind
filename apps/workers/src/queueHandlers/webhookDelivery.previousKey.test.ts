import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encryptSecret, generateEncryptionKey } from '@bike4mind/server-utils/security/secretEncryption';

vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  config: {} as { SECRET_ENCRYPTION_KEY?: string; SECRET_ENCRYPTION_KEY_PREVIOUS?: string },
  findByOrganizationId: vi.fn(),
  createIfNotExists: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  cacheRepository: {
    claimDedup: vi.fn(async () => ({ claimed: true })),
    casDeleteDedup: vi.fn(),
    createOrUpdate: vi.fn(),
  },
  webhookDeliveryRepository: { createIfNotExists: h.createIfNotExists },
  webhookSubscriptionRepository: {
    findById: vi.fn(async () => ({ id: 'sub-1', enabled: true })),
    incrementConsecutiveFailuresAtomic: vi.fn(async () => ({ wasAutoDisabled: false, newFailureCount: 1 })),
    resetConsecutiveFailures: vi.fn(),
  },
  orgWebhookConfigRepository: { findByOrganizationId: h.findByOrganizationId },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: class {} }));
vi.mock('@bike4mind/server-utils/utils/ssrfProtection', () => ({
  validateTargetUrl: vi.fn(async () => ({ valid: true })),
  fetchPinned: h.fetchMock,
  SsrfError: class SsrfError extends Error {},
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: h.config }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({
  recordWebhookDeliverySuccess: vi.fn(),
  recordWebhookDeliveryFailure: vi.fn(),
  recordWebhookDeliverySkipped: vi.fn(),
}));

import { WebhookDeliveryStatus } from '@bike4mind/common';
import { dispatch } from './webhookDelivery';
import { configureSecretsAtRest } from '@bike4mind/utils/security';

const secretFixture = 'webhook-secret-fixture';

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
        targetUrl: 'https://hooks.example.com/endpoint',
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

describe('webhookDelivery dispatch with a secret stored under the previous encryption key', () => {
  let previousKey: string;

  beforeEach(() => {
    vi.clearAllMocks();
    previousKey = generateEncryptionKey();
    h.config.SECRET_ENCRYPTION_KEY = generateEncryptionKey();
    h.config.SECRET_ENCRYPTION_KEY_PREVIOUS = previousKey;
    configureSecretsAtRest(h.config.SECRET_ENCRYPTION_KEY, h.config.SECRET_ENCRYPTION_KEY_PREVIOUS);
    h.findByOrganizationId.mockResolvedValue({ secret: encryptSecret(secretFixture, previousKey) });
    h.fetchMock.mockResolvedValue({ ok: true, status: 200, headers: new Headers() });
  });

  it('signs the delivery with the decrypted secret and records it as delivered', async () => {
    await runDispatch();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const init = h.fetchMock.mock.calls[0][1] as { headers: Record<string, string>; body: string };
    const timestamp = init.headers['X-Webhook-Timestamp'];
    const expected = crypto.createHmac('sha256', secretFixture).update(`${timestamp}.${init.body}`).digest('hex');
    expect(init.headers['X-Webhook-Signature-256']).toBe(`sha256=${expected}`);
    expect(h.createIfNotExists.mock.calls[0][0]).toMatchObject({ status: WebhookDeliveryStatus.Success });
  });

  it('records a failed delivery without sending when the secret was stored under neither key', async () => {
    h.findByOrganizationId.mockResolvedValue({ secret: encryptSecret(secretFixture, generateEncryptionKey()) });

    await runDispatch();

    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.createIfNotExists.mock.calls[0][0]).toMatchObject({ status: WebhookDeliveryStatus.Failed });
  });
});
