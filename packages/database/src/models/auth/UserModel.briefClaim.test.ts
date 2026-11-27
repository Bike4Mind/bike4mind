import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { User, userRepository } from './UserModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, MONGO_TEST_TIMEOUT_MS);
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await User.collection.deleteMany({});
});

const GAP_MS = 4 * 60 * 60 * 1000;
const NOW = new Date('2026-11-19T13:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const insertUser = async (fields: Record<string, unknown> = {}) => {
  const { insertedId } = await User.collection.insertOne({ username: 'u', email: 'u@example.com', ...fields });
  return insertedId.toString();
};
const lastStartOf = async (userId: string) =>
  (await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) }))?.lastBriefStartedAt;

describe('userRepository brief start claim', () => {
  it.each([
    ['absent', {}],
    ['null', { lastBriefStartedAt: null }],
  ])('claims when the field is %s and stamps the claim time', async (_label, fields) => {
    const userId = await insertUser(fields);
    expect(await userRepository.claimBriefStart(userId, NOW, GAP_MS)).toEqual({ previous: null });
    expect(await lastStartOf(userId)).toEqual(NOW);
  });

  it('refuses a second claim inside the gap, then allows one at and after it', async () => {
    const userId = await insertUser();
    expect(await userRepository.claimBriefStart(userId, NOW, GAP_MS)).toEqual({ previous: null });
    expect(await userRepository.claimBriefStart(userId, at(GAP_MS - 1), GAP_MS)).toBeNull();
    expect(await lastStartOf(userId)).toEqual(NOW);
    expect(await userRepository.claimBriefStart(userId, at(GAP_MS), GAP_MS)).toEqual({ previous: NOW });
    expect(await lastStartOf(userId)).toEqual(at(GAP_MS));
  });

  it('treats a stored start in the future as a recent claim', async () => {
    const userId = await insertUser({ lastBriefStartedAt: at(60_000) });
    expect(await userRepository.claimBriefStart(userId, NOW, GAP_MS)).toBeNull();
  });

  it('grants exactly one of several concurrent claims', async () => {
    const userId = await insertUser();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => userRepository.claimBriefStart(userId, NOW, GAP_MS))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('returns false for a missing user', async () => {
    expect(await userRepository.claimBriefStart(new mongoose.Types.ObjectId().toString(), NOW, GAP_MS)).toBeNull();
  });

  it('releases only its own claim, so a newer one survives', async () => {
    const userId = await insertUser();
    await userRepository.claimBriefStart(userId, NOW, GAP_MS);
    expect(await userRepository.releaseBriefStart(userId, at(-1), null)).toBe(false);
    expect(await lastStartOf(userId)).toEqual(NOW);

    expect(await userRepository.releaseBriefStart(userId, NOW, null)).toBe(true);
    expect(await lastStartOf(userId)).toBeUndefined();
    expect(await userRepository.claimBriefStart(userId, at(1), GAP_MS)).toEqual({ previous: null });
    expect(await userRepository.releaseBriefStart(userId, NOW, null)).toBe(false);
    expect(await lastStartOf(userId)).toEqual(at(1));
  });

  it('restores the start it replaced, so a shorter-gap claim given back keeps the longer gap intact', async () => {
    const earlier = at(-60 * 60 * 1000);
    const userId = await insertUser({ lastBriefStartedAt: earlier });
    const claim = await userRepository.claimBriefStart(userId, NOW, 15 * 60 * 1000);
    expect(claim).toEqual({ previous: earlier });
    expect(await userRepository.releaseBriefStart(userId, NOW, claim?.previous ?? null)).toBe(true);
    expect(await lastStartOf(userId)).toEqual(earlier);
    expect(await userRepository.claimBriefStart(userId, at(60_000), 4 * 60 * 60 * 1000)).toBeNull();
  });
});
