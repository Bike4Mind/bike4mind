import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  Cache,
  WebhookDelivery,
  webhookDeliveryRepository,
  webhookSubscriptionRepository,
  cacheRepository,
} from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

// Real dedup claim and delivery record; everything around them is stubbed.
vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  validateTarget: vi.fn(),
  successMetric: vi.fn(),
}));

vi.mock('@bike4mind/database', async importActual => ({
  ...(await importActual<typeof import('@bike4mind/database')>()),
  webhookSubscriptionRepository: {
    findById: vi.fn(async () => ({ id: 'sub-1', enabled: true })),
    incrementConsecutiveFailuresAtomic: vi.fn(async () => ({ wasAutoDisabled: false, newFailureCount: 1 })),
    resetConsecutiveFailures: vi.fn(),
  },
  orgWebhookConfigRepository: { findByOrganizationId: vi.fn(async () => ({ secret: 'enc(secret)' })) },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: class {} }));
vi.mock('@bike4mind/server-utils/utils/ssrfProtection', () => ({
  validateTargetUrl: h.validateTarget,
  fetchPinned: h.fetchMock,
  SsrfError: class SsrfError extends Error {},
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({ decryptStoredSecret: () => 'plain-secret' }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'test-key' } }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({
  recordWebhookDeliverySuccess: h.successMetric,
  recordWebhookDeliveryFailure: vi.fn(),
  recordWebhookDeliverySkipped: vi.fn(),
}));

import { dispatch, MAX_RETRIES } from './webhookDelivery';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

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

let receiveCount = 0;
const receive = () => {
  receiveCount += 1;
  const event = {
    Records: [{ ...sqsEvent.Records[0], attributes: { ApproximateReceiveCount: String(receiveCount) } }],
  };
  return (dispatch as unknown as (event: unknown, context: unknown, log: unknown) => Promise<void>)(event, {}, logger);
};

const respond = (status: number) => ({ ok: status >= 200 && status < 300, status, headers: new Headers() });

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri());
  await Cache.init();
  await WebhookDelivery.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  receiveCount = 0;
  h.validateTarget.mockResolvedValue({ valid: true });
  await Cache.deleteMany({});
  await WebhookDelivery.deleteMany({});
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
    const rows = await WebhookDelivery.find({ deliveryId: 'del-1' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'success', retryCount: 1 });
    expect(rows[0]).not.toHaveProperty('payload');
    expect(rows[0]).not.toHaveProperty('targetUrl');
    expect(rows[0]).not.toHaveProperty('errorMessage');
  });

  it('does not send again on the redelivery of a completed delivery', async () => {
    h.fetchMock.mockResolvedValue(respond(200));

    await receive();
    await receive();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not send again when the endpoint accepted the POST but recording it failed', async () => {
    h.fetchMock.mockResolvedValue(respond(200));
    vi.spyOn(webhookDeliveryRepository, 'recordAttempt').mockRejectedValueOnce(new Error('db down'));

    await expect(receive()).rejects.toThrow('db down');
    await receive();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const row = await WebhookDelivery.findOne({ deliveryId: 'del-1' }).lean();
    expect(row).toMatchObject({ status: 'success' });
    expect(row).not.toHaveProperty('payload');
    expect(row).not.toHaveProperty('targetUrl');
    expect(row).not.toHaveProperty('errorMessage');
    expect(webhookSubscriptionRepository.incrementConsecutiveFailuresAtomic).not.toHaveBeenCalled();
    expect(webhookSubscriptionRepository.resetConsecutiveFailures).toHaveBeenCalledTimes(1);
  });

  it('reconciles accepted history before checking a new-send URL policy', async () => {
    h.fetchMock.mockResolvedValue(respond(200));
    vi.spyOn(webhookDeliveryRepository, 'recordAttempt').mockRejectedValueOnce(new Error('history unavailable'));
    h.validateTarget
      .mockResolvedValueOnce({ valid: true })
      .mockResolvedValue({ valid: false, error: 'DNS unavailable' });

    await expect(receive()).rejects.toThrow('history unavailable');
    await receive();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(await WebhookDelivery.findOne({ deliveryId: 'del-1' }).lean()).toMatchObject({ status: 'success' });
    expect(h.validateTarget).toHaveBeenCalledTimes(1);
    expect(webhookSubscriptionRepository.incrementConsecutiveFailuresAtomic).not.toHaveBeenCalled();
  });

  it('retains accepted history when completion-cache persistence fails', async () => {
    h.fetchMock.mockResolvedValue(respond(200));
    vi.spyOn(cacheRepository, 'casUpdateDedup').mockRejectedValueOnce(new Error('cache update unavailable'));

    await expect(receive()).rejects.toThrow('cache update unavailable');
    expect(await WebhookDelivery.findOne({ deliveryId: 'del-1' }).lean()).toMatchObject({ status: 'success' });
    await receive();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect((await Cache.findOne({ key: DEDUP_KEY }).lean())?.result).toMatchObject({
      status: 'completed',
      deliveryId: 'del-1',
    });
    expect(webhookSubscriptionRepository.incrementConsecutiveFailuresAtomic).not.toHaveBeenCalled();
    expect(webhookSubscriptionRepository.resetConsecutiveFailures).toHaveBeenCalledTimes(1);
  });

  it('keeps Success when its metric emission fails after persistence', async () => {
    h.fetchMock.mockResolvedValue(respond(200));
    h.successMetric.mockRejectedValueOnce(new Error('metric unavailable'));

    await expect(receive()).rejects.toThrow('metric unavailable');
    await receive();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(await WebhookDelivery.findOne({ deliveryId: 'del-1' }).lean()).toMatchObject({ status: 'success' });
    expect(webhookSubscriptionRepository.incrementConsecutiveFailuresAtomic).not.toHaveBeenCalled();
    expect(webhookSubscriptionRepository.resetConsecutiveFailures).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a replacement claim after an older accepted response', async () => {
    let release!: () => void;
    h.fetchMock.mockImplementationOnce(() => new Promise(resolve => (release = () => resolve(respond(200)))));
    const first = receive();
    await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalledTimes(1));
    await Cache.updateOne({ key: DEDUP_KEY }, { $set: { 'result.owner': 'replacement' } });
    release();

    await expect(first).rejects.toThrow('claim changed');

    expect((await Cache.findOne({ key: DEDUP_KEY }).lean())?.result).toMatchObject({
      status: 'pending',
      owner: 'replacement',
    });
    expect(await WebhookDelivery.findOne({ deliveryId: 'del-1' }).lean()).toMatchObject({ status: 'success' });
    expect(webhookSubscriptionRepository.incrementConsecutiveFailuresAtomic).not.toHaveBeenCalled();
  });

  it('defers redelivery while an unaccepted claim could not be released', async () => {
    h.fetchMock.mockResolvedValue(respond(503));
    vi.spyOn(cacheRepository, 'casDeleteDedup').mockRejectedValueOnce(new Error('cache delete unavailable'));

    await expect(receive()).rejects.toThrow('HTTP 503');
    expect(await Cache.findOne({ key: DEDUP_KEY })).not.toBeNull();
    await expect(receive()).rejects.toThrow('pending');
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('acks redelivery of a permanent endpoint failure', async () => {
    h.fetchMock.mockResolvedValue(respond(404));

    await receive();
    await receive();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(await WebhookDelivery.findOne({ deliveryId: 'del-1' }).lean()).toMatchObject({ status: 'failed' });
  });

  it('makes an HTTP attempt on every receive of the retry budget', async () => {
    h.fetchMock.mockResolvedValue(respond(503));

    for (let i = 0; i < MAX_RETRIES; i++) {
      await expect(receive()).rejects.toThrow('HTTP 503');
    }

    expect(h.fetchMock).toHaveBeenCalledTimes(MAX_RETRIES);
    const row = await WebhookDelivery.findOne({ deliveryId: 'del-1' }).lean();
    expect(row).toMatchObject({ status: 'failed', retryCount: MAX_RETRIES - 1 });
  });

  it('sends once when two receives of the same message overlap', async () => {
    let release!: () => void;
    h.fetchMock.mockImplementation(() => new Promise(resolve => (release = () => resolve(respond(200)))));

    const first = receive();
    await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalledTimes(1));
    await expect(receive()).rejects.toThrow('pending');
    release();
    await first;
    await receive();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });
});
