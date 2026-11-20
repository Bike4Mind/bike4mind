import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { generateAnonymousSessionId } from '@bike4mind/common';
import { Quest, TelemetryAuditLogModel, User, mongoose } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.mock('sst', () => ({ Resource: { SECRET_ENCRYPTION_KEY: { value: 'test-telemetry-real-hashes' } } }));

import { triggerTelemetryDeletion } from './telemetryDeletion';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const userId = 'abcdef0123456789abcdef01';
const otherUserId = 'fedcba9876543210fedcba98';
let database: MongoMemoryServer;

beforeAll(async () => {
  database = await createMongoServer();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([
    User.collection.deleteMany({}),
    Quest.collection.deleteMany({}),
    TelemetryAuditLogModel.collection.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});

const telemetryFor = (id: string, date: Date) => {
  const dateKey = date.toISOString().split('T')[0];
  const salt = createHmac('sha256', 'test-telemetry-real-hashes').update(dateKey).digest('hex');
  return { anonymousSessionId: generateAnonymousSessionId(id, 'default', salt, date) };
};

const seedUser = () =>
  User.collection.insertOne({
    _id: new mongoose.Types.ObjectId(userId),
    username: 'telemetry-target',
    email: 'telemetry-target@example.test',
  });

describe('telemetry deletion with the real writer hash format', () => {
  it('finds canonical hashes through an uppercase account alias and audits the canonical target', async () => {
    await seedUser();
    const now = new Date();
    const owned = telemetryFor(userId, now);
    const foreign = telemetryFor(otherUserId, now);
    const { insertedIds } = await Quest.collection.insertMany([
      { promptMeta: { contextTelemetry: owned }, deletedAt: null },
      { promptMeta: { contextTelemetry: owned }, deletedAt: now },
      { promptMeta: { contextTelemetry: foreign }, deletedAt: null },
    ]);
    const result = await triggerTelemetryDeletion(userId.toUpperCase(), { headers: {} });
    expect(result).toEqual({ verified: true, deletedCount: 2, remainingCount: 0 });
    for (const index of [0, 1])
      expect(
        (await Quest.collection.findOne({ _id: insertedIds[index] }))?.promptMeta?.contextTelemetry
      ).toBeUndefined();
    expect((await Quest.collection.findOne({ _id: insertedIds[2] }))?.promptMeta?.contextTelemetry).toEqual(foreign);
    const audit = await TelemetryAuditLogModel.findOne({ action: 'delete' }).lean();
    expect(audit?.userId).toBe(userId);
    expect(audit?.metadata).toMatchObject({ deletedCount: 2, verified: true, remainingCount: 0 });
  });

  it('finds the UTC day intersecting the rolling ninety-day cutoff', async () => {
    await seedUser();
    const now = new Date('2026-11-16T12:00:00.000Z');
    const boundary = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1_000 + 60_000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    try {
      const foreign = telemetryFor(otherUserId, boundary);
      const { insertedIds } = await Quest.collection.insertMany([
        { createdAt: boundary, promptMeta: { contextTelemetry: telemetryFor(userId, boundary) } },
        { createdAt: now, promptMeta: { contextTelemetry: telemetryFor(userId, now) } },
        { createdAt: boundary, promptMeta: { contextTelemetry: foreign } },
      ]);
      expect(await triggerTelemetryDeletion(userId, { headers: {} })).toEqual({
        verified: true,
        deletedCount: 2,
        remainingCount: 0,
      });
      expect((await Quest.collection.findOne({ _id: insertedIds[0] }))?.promptMeta?.contextTelemetry).toBeUndefined();
      expect((await Quest.collection.findOne({ _id: insertedIds[1] }))?.promptMeta?.contextTelemetry).toBeUndefined();
      expect((await Quest.collection.findOne({ _id: insertedIds[2] }))?.promptMeta?.contextTelemetry).toEqual(foreign);
    } finally {
      vi.useRealTimers();
    }
  });
});
