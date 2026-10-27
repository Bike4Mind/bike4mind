import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  count: vi.fn(),
  aggregate: vi.fn(),
  send: vi.fn(),
  maxTimeMS: vi.fn(),
  option: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  connectDB: mocks.connect,
  User: { collection: { name: 'users' }, countDocuments: mocks.count },
  UserApiKey: { aggregate: mocks.aggregate },
}));
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send = mocks.send;
  },
  PutMetricDataCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('sst', () => ({ Resource: { App: { name: 'test', stage: 'dev' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://localhost/%STAGE%' } }));

import {
  accountCreationMetricData,
  accountCreationQueries,
  accountCreationWindow,
  handler,
} from './accountCreationMetrics';
import type { ScheduledEvent } from 'aws-lambda';

const event = { time: '2026-01-02T12:05:00Z' } as ScheduledEvent;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.count.mockReturnValue({ maxTimeMS: mocks.maxTimeMS });
  mocks.aggregate.mockReturnValue({ option: mocks.option });
  mocks.maxTimeMS.mockResolvedValue(3);
  mocks.option.mockResolvedValue([{ count: 2 }]);
  mocks.send.mockResolvedValue(undefined);
});

describe('account creation census', () => {
  it('uses the scheduled complete UTC hour even on delayed invocation and retries', () => {
    expect(accountCreationWindow(event.time)).toEqual({
      since: new Date('2026-01-02T11:00:00Z'),
      until: new Date('2026-01-02T12:00:00Z'),
    });
    expect(() => accountCreationWindow('bad')).toThrow();
    expect(accountCreationMetricData(event.time, 3, 2)).toEqual(accountCreationMetricData(event.time, 3, 2));
  });

  it('counts persisted creations, not login events or requests, in a half-open window', () => {
    const { since, until } = accountCreationWindow(event.time);
    const queries = accountCreationQueries(since, until);
    expect(queries.signups).toEqual({
      isSynthetic: { $ne: true },
      isSystem: { $ne: true },
      createdAt: { $gte: since, $lt: until },
    });
    expect(queries.keys[0]).toEqual({ $match: { createdAt: { $gte: since, $lt: until } } });
    expect(queries.keys).toContainEqual({
      $match: {
        'owner.isSynthetic': { $ne: true },
        'owner.isSystem': { $ne: true },
        'owner.createdAt': { $type: 'date' },
        $expr: {
          $and: [
            { $gte: ['$createdAt', '$owner.createdAt'] },
            { $lt: [{ $subtract: ['$createdAt', '$owner.createdAt'] }, 86_400_000] },
          ],
        },
      },
    });
  });

  it('emits timestamped aggregate counts without account identifiers', async () => {
    await handler(event);
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        input: {
          Namespace: 'test/dev/AccountCreation',
          MetricData: [
            { MetricName: 'SuccessfulSignups', Value: 3, Unit: 'Count', Timestamp: new Date('2026-01-02T11:00:00Z') },
            { MetricName: 'NewAccountApiKeys', Value: 2, Unit: 'Count', Timestamp: new Date('2026-01-02T11:00:00Z') },
            { MetricName: 'CensusCompleted', Value: 1, Unit: 'Count', Timestamp: new Date('2026-01-02T11:00:00Z') },
          ],
        },
      })
    );
  });

  it('emits explicit zeros for an empty hour', async () => {
    mocks.maxTimeMS.mockResolvedValue(0);
    mocks.option.mockResolvedValue([]);
    await handler(event);
    expect(mocks.send.mock.calls[0][0].input.MetricData.map((metric: { Value: number }) => metric.Value)).toEqual([
      0, 0, 1,
    ]);
  });

  it('fails for retry rather than publishing a false zero or swallowing delivery failure', async () => {
    mocks.option.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(handler(event)).rejects.toThrow('database unavailable');
    expect(mocks.send).not.toHaveBeenCalled();
    mocks.send.mockRejectedValueOnce(new Error('metrics unavailable'));
    await expect(handler(event)).rejects.toThrow('metrics unavailable');
  });

  it('executes the age boundary against MongoDB, excluding missing, future, system and synthetic owners', async () => {
    const server = await createMongoServer();
    const connection = await mongoose.createConnection(server.getUri()).asPromise();
    try {
      const db = connection.db!;
      const mintedAt = new Date('2026-01-02T11:30:00Z');
      const owners = [
        { _id: new mongoose.Types.ObjectId(), createdAt: new Date(mintedAt.getTime() - 86_400_000 + 1) },
        { _id: new mongoose.Types.ObjectId(), createdAt: new Date(mintedAt.getTime() - 86_400_000) },
        { _id: new mongoose.Types.ObjectId(), createdAt: new Date(mintedAt.getTime() + 1) },
        { _id: new mongoose.Types.ObjectId(), createdAt: mintedAt, isSynthetic: true },
        { _id: new mongoose.Types.ObjectId(), createdAt: mintedAt, isSystem: true },
        { _id: new mongoose.Types.ObjectId() },
        { _id: new mongoose.Types.ObjectId(), createdAt: mintedAt },
      ];
      await db.collection('users').insertMany(owners);
      await db
        .collection('keys')
        .insertMany([
          ...owners.map(owner => ({ userId: String(owner._id), createdAt: mintedAt })),
          { userId: 'invalid', createdAt: mintedAt },
          { userId: String(owners[0]._id), createdAt: new Date('2026-01-02T12:00:00Z') },
          { userId: String(owners[0]._id), createdAt: new Date('2026-01-02T10:59:59Z') },
        ]);
      const { since, until } = accountCreationWindow(event.time);
      const queries = accountCreationQueries(since, until);
      expect(await db.collection('keys').aggregate(queries.keys).toArray()).toEqual([{ count: 2 }]);
      expect(await db.collection('users').countDocuments(queries.signups)).toBe(2);
    } finally {
      await connection.close();
      await server.stop();
    }
  });
});
