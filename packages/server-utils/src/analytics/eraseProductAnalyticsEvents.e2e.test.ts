import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { OverwatchRawEvent, OverwatchUserDay, OverwatchUserFirstSeen } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

const cfg = vi.hoisted(() => ({ JWT_SECRET: 'secret', OVERWATCH_PSEUDONYM_SALT: 'salt' as string | undefined }));
vi.mock('../utils/config', () => ({ Config: cfg }));

import { pseudonymize } from './pseudonymize';
import { eraseProductAnalyticsEvents } from './eraseProductAnalyticsEvents';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongod: MongoMemoryServer;
const erasedId = new mongoose.Types.ObjectId().toHexString();
const keptId = new mongoose.Types.ObjectId().toHexString();
const erased = pseudonymize(erasedId, 'salt');
const kept = pseudonymize(keptId, 'salt');

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});
afterEach(async () => {
  cfg.OVERWATCH_PSEUDONYM_SALT = 'salt';
  await mongoose.connection.dropDatabase();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

async function seed() {
  let n = 0;
  for (const userId of [erased, kept]) {
    for (const productId of ['bike4mind', 'other-product']) {
      await OverwatchRawEvent.create({
        eventId: `evt-${n++}`,
        schemaVersion: 1,
        productId,
        userId,
        sessionId: 's',
        event: 'active',
        timestamp: new Date().toISOString(),
      });
      await OverwatchUserDay.create({ productId, date: '2026-11-01', userId });
      await OverwatchUserFirstSeen.create({ productId, userId, firstSeenDate: '2026-11-01' });
    }
  }
}

const remaining = async (userId: string) => [
  await OverwatchRawEvent.countDocuments({ userId }),
  await OverwatchUserDay.countDocuments({ userId }),
  await OverwatchUserFirstSeen.countDocuments({ userId }),
];

describe('eraseProductAnalyticsEvents', () => {
  it("deletes the person's events and markers under every product and leaves everyone else's", async () => {
    await seed();

    await expect(eraseProductAnalyticsEvents(erasedId.toUpperCase())).resolves.toEqual({
      events: 2,
      userDays: 2,
      firstSeen: 2,
    });

    expect(await remaining(erased)).toEqual([0, 0, 0]);
    expect(await remaining(kept)).toEqual([2, 2, 2]);
  });

  it('does nothing when no pseudonym salt is configured', async () => {
    await seed();
    cfg.OVERWATCH_PSEUDONYM_SALT = 'not-configured';

    await expect(eraseProductAnalyticsEvents(erasedId)).resolves.toBeNull();

    expect(await remaining(erased)).toEqual([2, 2, 2]);
  });
});
