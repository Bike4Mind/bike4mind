import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { isInBusyBlock } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { User, userRepository } from './UserModel';
import { normalizeBusyBlocks } from './busyBlocks';

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

const NOW = new Date('2026-11-20T15:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const block = (startMin: number, endMin: number) => ({ start: at(startMin), end: at(endMin) });

const insertUser = async (fields: Record<string, unknown> = {}) => {
  const { insertedId } = await User.collection.insertOne({
    username: 'u',
    email: 'u@example.com',
    preferences: null,
    ...fields,
  });
  return insertedId.toString();
};
const raw = (userId: string) => User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) });

describe('normalizeBusyBlocks', () => {
  const norm = (blocks: { start: Date; end: Date }[], lastBlockBriefEnd: Date | null = null) =>
    normalizeBusyBlocks(blocks, { now: NOW, lastBlockBriefEnd });

  it('returns an empty list for no blocks', () => {
    expect(norm([])).toEqual([]);
  });

  it('sorts and merges overlapping and touching blocks', () => {
    expect(norm([block(90, 120), block(0, 30), block(20, 60), block(60, 70)])).toEqual([block(0, 70), block(90, 120)]);
  });

  it('never merges past the 12h block limit: the later block keeps only its part after the earlier one ends', () => {
    expect(norm([block(0, 480), block(480, 960)])).toEqual([block(0, 480), block(480, 960)]);
    expect(norm([block(0, 480), block(360, 840), block(400, 420)])).toEqual([block(0, 480), block(480, 840)]);
    expect(norm([block(0, 480), block(240, 720)])).toEqual([block(0, 720)]);
  });

  it('drops blocks past the retry window and beyond the 72h horizon, keeps one just inside each', () => {
    expect(
      norm([block(-200, -61), block(-60, -30), block(72 * 60, 72 * 60 + 10), block(72 * 60 + 20, 72 * 60 + 30)])
    ).toEqual([block(-60, -30), block(72 * 60, 72 * 60 + 10)]);
  });

  it('drops a briefed block and trims one straddling the last briefed end', () => {
    expect(norm([block(-30, -10), block(-20, 40)], at(-10))).toEqual([block(-10, 40)]);
    expect(norm([block(-30, -10)], at(-10))).toEqual([]);
  });
});

describe('userRepository busy blocks', () => {
  it('stores merged blocks and the first end as the due time; GET reads them back', async () => {
    const userId = await insertUser();
    const state = await userRepository.setBusyBlocks(
      userId,
      { enabled: true, blocks: [block(30, 60), block(0, 40)] },
      NOW
    );
    expect(state).toEqual({ enabled: true, blocks: [block(0, 60)], nextBlockBriefAt: at(60) });
    expect(await userRepository.getBusyBlocks(userId)).toEqual(state);
    expect((await raw(userId))?.busyBlocksSyncedAt).toEqual(NOW);
  });

  it('keeps the other preferences', async () => {
    const userId = await insertUser({ preferences: { language: 'fr', pushNotifications: { brief_ready: false } } });
    await userRepository.setBusyBlocks(userId, { enabled: true, blocks: [block(0, 30)] }, NOW);
    expect((await raw(userId))?.preferences).toMatchObject({
      language: 'fr',
      pushNotifications: { brief_ready: false },
      busyBlockBrief: { enabled: true },
    });
  });

  it('unsets the due time when an empty list is synced', async () => {
    const userId = await insertUser();
    await userRepository.setBusyBlocks(userId, { enabled: true, blocks: [block(0, 30)] }, NOW);
    const state = await userRepository.setBusyBlocks(userId, { enabled: true, blocks: [] }, NOW);
    expect(state).toEqual({ enabled: true, blocks: [], nextBlockBriefAt: null });
    expect((await raw(userId))?.nextBlockBriefAt).toBeUndefined();
  });

  it('does not re-arm a block a brief was already claimed for on re-sync', async () => {
    const userId = await insertUser({ lastBlockBriefEnd: at(-5) });
    const state = await userRepository.setBusyBlocks(
      userId,
      { enabled: true, blocks: [block(-35, -5), block(10, 20)] },
      NOW
    );
    expect(state).toEqual({ enabled: true, blocks: [block(10, 20)], nextBlockBriefAt: at(20) });
  });

  it('disabling clears blocks and the due time and reads back as off', async () => {
    const userId = await insertUser();
    await userRepository.setBusyBlocks(userId, { enabled: true, blocks: [block(0, 30)] }, NOW);
    expect(await userRepository.setBusyBlocks(userId, { enabled: false, blocks: [block(0, 30)] }, NOW)).toEqual({
      enabled: false,
      blocks: [],
      nextBlockBriefAt: null,
    });
    const doc = await raw(userId);
    expect(doc?.busyBlocks).toBeUndefined();
    expect(doc?.nextBlockBriefAt).toBeUndefined();
    expect(await userRepository.getBusyBlocks(userId)).toEqual({ enabled: false, blocks: [], nextBlockBriefAt: null });
  });

  it('reads off for a user with no preferences document', async () => {
    const userId = await insertUser();
    expect(await userRepository.getBusyBlocks(userId)).toEqual({ enabled: false, blocks: [], nextBlockBriefAt: null });
  });
});

describe('userRepository block brief claims', () => {
  it('finds ended blocks earliest first and skips users with none due', async () => {
    const named = (n: string) => ({ username: n, email: `${n}@example.com` });
    const later = await insertUser({ ...named('a'), busyBlocks: [block(-20, -5)], nextBlockBriefAt: at(-5) });
    const earlier = await insertUser({ ...named('b'), busyBlocks: [block(-30, -10)], nextBlockBriefAt: at(-10) });
    await insertUser({ ...named('c'), busyBlocks: [block(10, 20)], nextBlockBriefAt: at(20) });
    await insertUser(named('d'));

    const due = await userRepository.findDueBlockBriefs(NOW, 10);

    expect(due.map(u => u.id)).toEqual([earlier, later]);
    expect(due[0]).toMatchObject({ blocks: [block(-30, -10)], nextBlockBriefAt: at(-10), lastBlockBriefEnd: null });
  });

  it('claims a due block once and releases it back', async () => {
    const userId = await insertUser({ busyBlocks: [block(-30, -10), block(10, 20)], nextBlockBriefAt: at(-10) });
    const expected = { nextBlockBriefAt: at(-10), lastBlockBriefEnd: null };
    const claimed = { nextBlockBriefAt: at(20), lastBlockBriefEnd: at(-10) };

    expect(await userRepository.advanceNextBlockBriefAt(userId, expected, claimed)).toBe(true);
    expect(await userRepository.advanceNextBlockBriefAt(userId, expected, claimed)).toBe(false);
    expect(await raw(userId)).toMatchObject({ nextBlockBriefAt: at(20), lastBlockBriefEnd: at(-10) });

    expect(await userRepository.advanceNextBlockBriefAt(userId, claimed, expected)).toBe(true);
    const doc = await raw(userId);
    expect(doc?.nextBlockBriefAt).toEqual(at(-10));
    expect(doc?.lastBlockBriefEnd).toBeUndefined();
  });

  it('hands a claimed block back even after a sync dropped it, and not once a later claim moved past it', async () => {
    const userId = await insertUser({
      preferences: { busyBlockBrief: { enabled: true } },
      busyBlocks: [block(-30, -10), block(10, 20)],
      nextBlockBriefAt: at(-10),
    });
    await userRepository.advanceNextBlockBriefAt(
      userId,
      { nextBlockBriefAt: at(-10), lastBlockBriefEnd: null },
      { nextBlockBriefAt: at(20), lastBlockBriefEnd: at(-10) }
    );
    const synced = await userRepository.setBusyBlocks(
      userId,
      { enabled: true, blocks: [block(-30, -10), block(5, 15)] },
      NOW
    );
    expect(synced.blocks).toEqual([block(5, 15)]);

    expect(await userRepository.releaseBlockBriefClaim(userId, block(-30, -10), null)).toBe(true);
    const doc = await raw(userId);
    expect(doc?.busyBlocks).toEqual([block(-30, -10), block(5, 15)]);
    expect(doc?.nextBlockBriefAt).toEqual(at(-10));
    expect(doc?.lastBlockBriefEnd).toBeUndefined();

    await userRepository.advanceNextBlockBriefAt(
      userId,
      { nextBlockBriefAt: at(-10), lastBlockBriefEnd: null },
      { nextBlockBriefAt: at(15), lastBlockBriefEnd: at(-10) }
    );
    await userRepository.advanceNextBlockBriefAt(
      userId,
      { nextBlockBriefAt: at(15), lastBlockBriefEnd: at(-10) },
      { nextBlockBriefAt: null, lastBlockBriefEnd: at(15) }
    );
    expect(await userRepository.releaseBlockBriefClaim(userId, block(-30, -10), null)).toBe(false);
    expect((await raw(userId))?.lastBlockBriefEnd).toEqual(at(15));
  });

  it('unsets the due time when the last block is claimed', async () => {
    const userId = await insertUser({ busyBlocks: [block(-30, -10)], nextBlockBriefAt: at(-10) });

    expect(
      await userRepository.advanceNextBlockBriefAt(
        userId,
        { nextBlockBriefAt: at(-10), lastBlockBriefEnd: null },
        { nextBlockBriefAt: null, lastBlockBriefEnd: at(-10) }
      )
    ).toBe(true);
    const doc = await raw(userId);
    expect(doc?.nextBlockBriefAt).toBeUndefined();
    expect(doc?.lastBlockBriefEnd).toEqual(at(-10));
  });
});

describe('isInBusyBlock on a stored user', () => {
  it('reads the synced block back from the real schema', async () => {
    const userId = await insertUser();
    await userRepository.setBusyBlocks(userId, { enabled: true, blocks: [block(-10, 20)] }, NOW);
    const user = await userRepository.findById(userId);

    expect(isInBusyBlock(user!, NOW)).toBe(true);
    expect(isInBusyBlock(user!, at(20))).toBe(false);
  });
});
