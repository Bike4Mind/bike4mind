import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { User } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const { release } = vi.hoisted(() => ({ release: vi.fn() }));
vi.mock('@server/auth/emailVerifiedGrants', () => ({
  isEligibleForFreeCredits: async () => true,
  releaseVerifiedPendingFreeCredits: release,
}));
import { releaseHeldSignupCredits } from './releaseHeldSignupCredits';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
  release.mockReset();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

const seedUser = async (email: string, tags: string[]) =>
  String(
    (
      await User.collection.insertOne({
        email,
        username: email,
        emailVerified: true,
        tags,
        pendingCreditGrant: 25,
      })
    ).insertedId
  );

describe('releaseHeldSignupCredits with onlyUserIds', () => {
  it('pays only the listed accounts still waiting, never a later joiner or a credited account', async () => {
    release.mockResolvedValue({ creditsGranted: 25, tags: [] });
    const judged = await seedUser('judged@example.net', [PENDING_FREE_CREDITS_TAG]);
    const joiner = await seedUser('joiner@example.net', [PENDING_FREE_CREDITS_TAG]);
    const credited = await seedUser('credited@example.net', []);

    const result = await releaseHeldSignupCredits('example.net', {
      onlyUserIds: [judged, credited],
      reason: 'test',
      bypassBudget: false,
      logger,
    });

    expect(release.mock.calls.map(([user]) => user.id)).toEqual([judged]);
    expect(release.mock.calls.map(([user]) => user.id)).not.toContain(joiner);
    expect(result).toEqual({ creditsReleased: 25, remaining: 0, nextCursor: null });
  });

  it('pays nobody for an empty list', async () => {
    await seedUser('waiting@example.net', [PENDING_FREE_CREDITS_TAG]);
    const result = await releaseHeldSignupCredits('example.net', {
      onlyUserIds: [],
      reason: 'test',
      bypassBudget: false,
      logger,
    });
    expect(release).not.toHaveBeenCalled();
    expect(result).toEqual({ creditsReleased: 0, remaining: 0, nextCursor: null });
  });
});
