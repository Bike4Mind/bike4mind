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
  getSpent: vi.fn(),
  resolvePoolBudget: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  connectDB: mocks.connect,
  User: { collection: { name: 'users' }, countDocuments: mocks.count },
  UserApiKey: { aggregate: mocks.aggregate },
  adminSettingsRepository: {},
  signupGrantBudgetRepository: { getSpent: mocks.getSpent },
}));
vi.mock('@bike4mind/services', () => ({
  userService: {
    signupGrantBudgetDay: (now: Date) => now.toISOString().slice(0, 10),
    signupGrantBudgetKey: (pool: string, day: string) => `${pool}:${day}`,
    resolvePoolBudget: mocks.resolvePoolBudget,
  },
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
  // clearAllMocks keeps queued once-values, so reset or unconsumed pairs leak into later tests.
  mocks.maxTimeMS.mockReset().mockResolvedValueOnce(3).mockResolvedValueOnce(5);
  mocks.option.mockResolvedValue([{ count: 2 }]);
  mocks.send.mockResolvedValue(undefined);
  mocks.resolvePoolBudget.mockReset().mockImplementation(async (_adapters: unknown, pool: string) => ({
    budget: pool === 'signup' ? 1000 : 400,
    missing: false,
  }));
  mocks.getSpent.mockReset().mockImplementation(async (key: string) => (key.startsWith('signup') ? 250 : 100));
});

describe('account creation census', () => {
  it('uses the scheduled complete UTC hour even on delayed invocation and retries', () => {
    expect(accountCreationWindow(event.time)).toEqual({
      since: new Date('2026-01-02T11:00:00Z'),
      until: new Date('2026-01-02T12:00:00Z'),
    });
    expect(() => accountCreationWindow('bad')).toThrow();
    expect(accountCreationMetricData(event.time, 3, 2, 5)).toEqual(accountCreationMetricData(event.time, 3, 2, 5));
  });

  it('counts accounts currently below zero credits, excluding system, synthetic and soft-deleted accounts', () => {
    const { since, until } = accountCreationWindow(event.time);
    expect(accountCreationQueries(since, until).negativeBalances).toEqual({
      $or: [{ isSynthetic: { $ne: true } }, { isPersona: true }],
      isSystem: { $ne: true },
      deletedAt: { $exists: false },
      currentCredits: { $lt: 0 },
    });
  });

  it('counts persisted creations, not login events or requests, in a half-open window', () => {
    const { since, until } = accountCreationWindow(event.time);
    const queries = accountCreationQueries(since, until);
    expect(queries.signups).toEqual({
      $or: [{ isSynthetic: { $ne: true } }, { isPersona: true }],
      isSystem: { $ne: true },
      createdAt: { $gte: since, $lt: until },
    });
    expect(queries.keys[0]).toEqual({ $match: { createdAt: { $gte: since, $lt: until } } });
    expect(queries.keys).toContainEqual({
      $match: {
        $or: [{ 'owner.isSynthetic': { $ne: true } }, { 'owner.isPersona': true }],
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
            { MetricName: 'NegativeBalances', Value: 5, Unit: 'Count', Timestamp: new Date('2026-01-02T12:00:00Z') },
            ...[
              ['SignupGrantPoolSpent', 'signup', 250],
              ['SignupGrantPoolBudget', 'signup', 1000],
              ['SignupGrantPoolBudgetMissing', 'signup', 0],
              ['SignupGrantPoolSpent', 'trickle', 100],
              ['SignupGrantPoolBudget', 'trickle', 400],
              ['SignupGrantPoolBudgetMissing', 'trickle', 0],
            ].map(([MetricName, pool, Value]) => ({
              MetricName,
              Value,
              Unit: 'Count',
              Timestamp: new Date('2026-01-02T12:00:00Z'),
              Dimensions: [{ Name: 'Pool', Value: pool }],
            })),
            { MetricName: 'CensusCompleted', Value: 1, Unit: 'Count', Timestamp: new Date('2026-01-02T11:00:00Z') },
          ],
        },
      })
    );
  });

  it('emits explicit zeros for an empty hour', async () => {
    mocks.maxTimeMS.mockReset().mockResolvedValue(0);
    mocks.option.mockResolvedValue([]);
    await handler(event);
    expect(mocks.send.mock.calls[0][0].input.MetricData.map((metric: { Value: number }) => metric.Value)).toEqual([
      0, 0, 0, 250, 1000, 0, 100, 400, 0, 1,
    ]);
  });

  it('publishes a zero budget for a pool with no budget row and still completes the census', async () => {
    mocks.resolvePoolBudget.mockResolvedValue({ budget: 0, missing: true });
    await handler(event);
    const data = mocks.send.mock.calls[0][0].input.MetricData as { MetricName: string; Value: number }[];
    expect(data.filter(m => m.MetricName === 'SignupGrantPoolBudget').map(m => m.Value)).toEqual([0, 0]);
    expect(data.filter(m => m.MetricName === 'SignupGrantPoolBudgetMissing').map(m => m.Value)).toEqual([1, 1]);
    expect(data.map(m => m.MetricName)).toContain('CensusCompleted');
  });

  it('does not flag a deliberately paused pool as missing', async () => {
    mocks.resolvePoolBudget.mockResolvedValue({ budget: 0, missing: false });
    await handler(event);
    const data = mocks.send.mock.calls[0][0].input.MetricData as { MetricName: string; Value: number }[];
    expect(data.filter(m => m.MetricName === 'SignupGrantPoolBudget').map(m => m.Value)).toEqual([0, 0]);
    expect(data.filter(m => m.MetricName === 'SignupGrantPoolBudgetMissing').map(m => m.Value)).toEqual([0, 0]);
  });

  it('reads the pool-day of the window start, so the 00:05 run publishes the day that just closed', async () => {
    mocks.maxTimeMS.mockReset().mockResolvedValue(3);
    await handler({ time: '2026-01-03T00:05:00Z' } as ScheduledEvent);
    expect(mocks.getSpent).toHaveBeenCalledWith('signup:2026-01-02');
    expect(mocks.getSpent).toHaveBeenCalledWith('trickle:2026-01-02');
    expect(mocks.getSpent).not.toHaveBeenCalledWith('signup:2026-01-03');
    expect(mocks.send.mock.calls[0][0].input.MetricData).toContainEqual(
      expect.objectContaining({ MetricName: 'SignupGrantPoolSpent', Timestamp: new Date('2026-01-03T00:00:00Z') })
    );
  });

  it('reads the same pool-day counter when the same scheduled event is redelivered', async () => {
    mocks.maxTimeMS.mockReset().mockResolvedValue(3);
    const redelivered = { time: '2026-01-03T00:05:00Z' } as ScheduledEvent;
    await handler(redelivered);
    await handler(redelivered);
    expect(mocks.getSpent.mock.calls.map(call => call[0])).toEqual([
      'signup:2026-01-02',
      'trickle:2026-01-02',
      'signup:2026-01-02',
      'trickle:2026-01-02',
    ]);
    expect(mocks.send.mock.calls[0][0].input).toEqual(mocks.send.mock.calls[1][0].input);
  });

  it('fails for retry rather than publishing a false zero or swallowing delivery failure', async () => {
    mocks.option.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(handler(event)).rejects.toThrow('database unavailable');
    expect(mocks.send).not.toHaveBeenCalled();
    mocks.send.mockRejectedValueOnce(new Error('metrics unavailable'));
    await expect(handler(event)).rejects.toThrow('metrics unavailable');
  });

  it('fails for retry rather than publishing a false zero when a grant pool spend read fails', async () => {
    mocks.getSpent.mockRejectedValueOnce(new Error('budget counter unavailable'));
    await expect(handler(event)).rejects.toThrow('budget counter unavailable');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('executes the age boundary against MongoDB, excluding missing, future, system and synthetic owners but counting personas', async () => {
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
        { _id: new mongoose.Types.ObjectId(), createdAt: mintedAt, isSynthetic: true, isPersona: true },
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
      expect(await db.collection('keys').aggregate(queries.keys).toArray()).toEqual([{ count: 3 }]);
      expect(await db.collection('users').countDocuments(queries.signups)).toBe(3);
    } finally {
      await connection.close();
      await server.stop();
    }
  });

  it('executes the negative-balance filter against MongoDB, counting only live external accounts below zero', async () => {
    const server = await createMongoServer();
    const connection = await mongoose.createConnection(server.getUri()).asPromise();
    try {
      const db = connection.db!;
      await db
        .collection('users')
        .insertMany([
          { currentCredits: -1 },
          { currentCredits: -0.5, isBanned: true },
          { currentCredits: -2, isSynthetic: true, isPersona: true },
          { currentCredits: -3, isSynthetic: true },
          { currentCredits: -4, isSystem: true },
          { currentCredits: -5, deletedAt: new Date('2026-01-01T00:00:00Z') },
          { currentCredits: 0 },
          { currentCredits: 10 },
          {},
        ]);
      const { since, until } = accountCreationWindow(event.time);
      const queries = accountCreationQueries(since, until);
      expect(await db.collection('users').countDocuments(queries.negativeBalances)).toBe(3);
    } finally {
      await connection.close();
      await server.stop();
    }
  });
});
