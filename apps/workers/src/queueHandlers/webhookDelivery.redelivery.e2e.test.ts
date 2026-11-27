import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { Cache } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

// Real CacheModel (the dedup claim under test); everything around it is stubbed.
vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  createIfNotExists: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@bike4mind/database', async importActual => ({
  ...(await importActual<typeof import('@bike4mind/database')>()),
  webhookDeliveryRepository: { createIfNotExists: h.createIfNotExists },
  webhookSubscriptionRepository: {
    findById: vi.fn(async () => ({ id: 'sub-1', enabled: true })),
    incrementConsecutiveFailuresAtomic: vi.fn(async () => ({ wasAutoDisabled: false, newFailureCount: 1 })),
    resetConsecutiveFailures: vi.fn(),
  },
  orgWebhookConfigRepository: { findByOrganizationId: vi.fn(async () => ({ secret: 'enc(secret)' })) },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: class {} }));
vi.mock('@bike4mind/server-utils/utils/ssrfProtection', () => ({
  validateTargetUrl: vi.fn(async () => ({ valid: true })),
  fetchPinned: h.fetchMock,
  SsrfError: class SsrfError extends Error {},
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({ decryptStoredSecret: () => 'plain-secret' }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'test-key' } }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({
  recordWebhookDeliverySuccess: vi.fn(),
  recordWebhookDeliveryFailure: vi.fn(),
  recordWebhookDeliverySkipped: vi.fn(),
}));

import { dispatch, MAX_RETRIES } from './webhookDelivery';

const DEDUP_KEY = 'webhook-delivery-evt-1-sub-1';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };

// SQS redelivers the same body, so every receive below reuses one message.
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

const receive = () =>
  (dispatch as unknown as (event: unknown, context: unknown, log: unknown) => Promise<void>)(sqsEvent, {}, logger);

const respond = (status: number) => ({ ok: status >= 200 && status < 300, status, headers: new Headers() });

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri());
  await Cache.init();
}, MONGO_TEST_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await Cache.deleteMany({});
});

describe('webhookDelivery redelivery', () => {
  it('sends again on the redelivery after a retryable failure', async () => {
    h.fetchMock.mockResolvedValueOnce(respond(500)).mockResolvedValueOnce(respond(200));

    await expect(receive()).rejects.toThrow('HTTP 500');
    expect(await Cache.findOne({ key: DEDUP_KEY })).toBeNull();

    await expect(receive()).resolves.toBeUndefined();

    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    const entry = await Cache.findOne({ key: DEDUP_KEY }).lean();
    expect(entry?.result).toMatchObject({ status: 'completed' });
  });

  it('does not send again on the redelivery of a completed delivery', async () => {
    h.fetchMock.mockResolvedValue(respond(200));

    await receive();
    await receive();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not send again when the endpoint accepted the POST but recording it failed', async () => {
    h.fetchMock.mockResolvedValue(respond(200));
    h.createIfNotExists.mockRejectedValueOnce(new Error('db down'));

    await expect(receive()).rejects.toThrow('db down');
    await receive();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('makes an HTTP attempt on every receive of the retry budget', async () => {
    h.fetchMock.mockResolvedValue(respond(503));

    for (let i = 0; i < MAX_RETRIES; i++) {
      await expect(receive()).rejects.toThrow('HTTP 503');
    }

    expect(h.fetchMock).toHaveBeenCalledTimes(MAX_RETRIES);
  });

  it('sends once when two receives of the same message overlap', async () => {
    let release!: () => void;
    h.fetchMock.mockImplementation(() => new Promise(resolve => (release = () => resolve(respond(200)))));

    const first = receive();
    await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalledTimes(1));
    await receive();
    release();
    await first;

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });
});
