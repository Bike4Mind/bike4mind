import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../__test__/createMongoServer';
import DlqFailureModel, { dlqFailureRepository } from './DlqFailureModel';

describe('DLQ failure records', () => {
  let server: MongoMemoryServer;
  beforeAll(async () => {
    server = await createMongoServer();
    await mongoose.connect(server.getUri());
    await DlqFailureModel.init();
  }, MONGO_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  }, MONGO_TEST_TIMEOUT_MS);

  it('records once per queue and message without storing content or overwriting the first failure', async () => {
    const failure = {
      queueLabel: 'queue-a',
      messageId: 'id-1',
      errorType: 'Error',
      errorMessage: 'timed out',
      category: 'timeout' as const,
      failedAt: new Date(),
      consumerVersion: '1',
    };
    await dlqFailureRepository.record(failure);
    await dlqFailureRepository.record({ ...failure, errorMessage: 'another error' });
    expect(await DlqFailureModel.countDocuments()).toBe(1);
    expect((await dlqFailureRepository.findForMessages('queue-a', ['id-1']))[0]).toMatchObject(failure);
    expect(await dlqFailureRepository.findForMessages('queue-b', ['id-1'])).toEqual([]);
    expect(Object.keys((await DlqFailureModel.findOne().lean())!)).not.toContain('body');
  });

  it('expires after the maximum SQS DLQ retention of 14 days', () => {
    expect(DlqFailureModel.schema.indexes()).toContainEqual([
      { failedAt: 1 },
      expect.objectContaining({ expireAfterSeconds: 15 * 24 * 60 * 60 }),
    ]);
  });
});
