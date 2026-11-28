import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { WebhookDeliveryStatus } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../__test__/createMongoServer';
import WebhookDelivery, { webhookDeliveryRepository } from './WebhookDeliveryModel';

const base = {
  deliveryId: 'del-1',
  organizationId: 'org-1',
  subscriptionId: 'sub-1',
  userId: 'user-1',
  eventType: 'push',
  repository: 'acme/repo',
  correlationId: 'corr-1',
};

const failed = (retryCount: number, errorMessage = 'HTTP 500: Server error') => ({
  ...base,
  status: WebhookDeliveryStatus.Failed,
  processingDurationMs: 10,
  errorMessage,
  retryCount,
  payload: { action: 'opened' },
  targetUrl: 'https://hooks.example.com/endpoint',
});

const success = (retryCount: number) => ({
  ...base,
  status: WebhookDeliveryStatus.Success,
  processingDurationMs: 12,
  retryCount,
});

describe('webhookDeliveryRepository.recordAttempt', () => {
  let server: MongoMemoryServer;
  beforeAll(async () => {
    server = await createMongoServer();
    await mongoose.connect(server.getUri());
    await WebhookDelivery.init();
  }, MONGO_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  }, MONGO_TEST_TIMEOUT_MS);
  beforeEach(async () => {
    await WebhookDelivery.deleteMany({});
  });

  it('overwrites a failed attempt with the latest one and drops the replay fields on success', async () => {
    await expect(webhookDeliveryRepository.recordAttempt(failed(0))).resolves.toBe(true);
    await expect(webhookDeliveryRepository.recordAttempt(failed(1, 'HTTP 503: Server error'))).resolves.toBe(true);
    expect(await WebhookDelivery.findOne({ deliveryId: 'del-1' }).lean()).toMatchObject({
      status: WebhookDeliveryStatus.Failed,
      retryCount: 1,
      errorMessage: 'HTTP 503: Server error',
      targetUrl: 'https://hooks.example.com/endpoint',
    });

    await expect(webhookDeliveryRepository.recordAttempt(success(2))).resolves.toBe(true);

    const rows = await WebhookDelivery.find({ deliveryId: 'del-1' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ...base, status: WebhookDeliveryStatus.Success, retryCount: 2 });
    expect(rows[0]).not.toHaveProperty('payload');
    expect(rows[0]).not.toHaveProperty('targetUrl');
    expect(rows[0]).not.toHaveProperty('errorMessage');
  });

  it('never downgrades a successful delivery', async () => {
    await webhookDeliveryRepository.recordAttempt(success(0));

    await expect(webhookDeliveryRepository.recordAttempt(failed(1))).resolves.toBe(false);

    expect(await WebhookDelivery.findOne({ deliveryId: 'del-1' }).lean()).toMatchObject({
      status: WebhookDeliveryStatus.Success,
      retryCount: 0,
    });
  });

  it('keeps one row per subscription for the same delivery id', async () => {
    await webhookDeliveryRepository.recordAttempt(failed(0));
    await webhookDeliveryRepository.recordAttempt({ ...success(0), subscriptionId: 'sub-2' });

    expect(await WebhookDelivery.countDocuments({ deliveryId: 'del-1' })).toBe(2);
  });
});
