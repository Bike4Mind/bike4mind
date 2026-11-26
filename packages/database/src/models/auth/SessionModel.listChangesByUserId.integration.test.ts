import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Session, sessionRepository } from './SessionModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await Session.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

afterEach(async () => {
  await Session.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
});

const OWNER = 'owner-1';

const insertSession = async (name: string, fields: Record<string, unknown> = {}) =>
  Session.create({ name, userId: OWNER, lastUpdated: new Date(), firstCreated: new Date(), ...fields });

/** Pins updatedAt without the timestamps plugin moving it again. */
const setUpdatedAt = (id: unknown, at: Date) =>
  Session.collection.updateOne({ _id: id as mongoose.Types.ObjectId }, { $set: { updatedAt: at } });

const names = (sessions: { name: string }[]) => sessions.map(session => session.name);

const T0 = new Date('2026-03-01T00:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

describe('sessionRepository.listChangesByUserId', () => {
  it('returns sessions changed at or after `since`, oldest change first', async () => {
    const old = await insertSession('old');
    const atMark = await insertSession('at-mark');
    const later = await insertSession('later');
    await setUpdatedAt(old._id, minutes(-1));
    await setUpdatedAt(later._id, minutes(5));
    await setUpdatedAt(atMark._id, T0);

    const rows = await sessionRepository.listChangesByUserId({ userId: OWNER, since: T0, limit: 10 });
    expect(names(rows)).toEqual(['at-mark', 'later']);
  });

  it('pages on (updatedAt, _id), so rows tied on updatedAt are neither skipped nor repeated', async () => {
    for (const name of ['a', 'b', 'c', 'd']) {
      const session = await insertSession(name);
      await setUpdatedAt(session._id, T0);
    }
    const seen: string[] = [];
    let after: { at: Date; id: string } | undefined;
    for (let page = 0; page < 5; page++) {
      const rows = await sessionRepository.listChangesByUserId({ userId: OWNER, since: T0, after, limit: 3 });
      seen.push(...names(rows.slice(0, 2)));
      if (rows.length <= 2) break;
      const last = rows[1];
      after = { at: last.updatedAt, id: last.id };
    }
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns soft deletes as tombstones, from both the service write and the raw-driver static', async () => {
    const viaUpdate = await insertSession('via-update');
    const viaStatic = await insertSession('via-static');
    await setUpdatedAt(viaUpdate._id, minutes(-10));
    await setUpdatedAt(viaStatic._id, minutes(-10));

    // sessionService.deleteSession's path, and the softDeletePlugin static other callers use.
    await sessionRepository.update({ id: viaUpdate.id, deletedAt: new Date() });
    await Session.deleteOne({ _id: viaStatic._id });

    const rows = await sessionRepository.listChangesByUserId({ userId: OWNER, since: T0, limit: 10 });
    expect(names(rows).sort()).toEqual(['via-static', 'via-update']);
    expect(rows.every(row => row.deletedAt instanceof Date)).toBe(true);
  });

  it('returns a rename that left lastUpdated alone', async () => {
    const renamed = await insertSession('before');
    await setUpdatedAt(renamed._id, minutes(-10));
    await Session.updateOne({ _id: renamed._id }, { $set: { name: 'after' } });

    expect(names(await sessionRepository.listChangesByUserId({ userId: OWNER, since: T0, limit: 10 }))).toEqual([
      'after',
    ]);
  });

  it("keeps the own-list filters: other users' and product-surface sessions stay out", async () => {
    await insertSession('mine');
    await insertSession('theirs', { userId: 'someone-else' });
    await insertSession('product', { surface: 'libreoncology' });

    expect(names(await sessionRepository.listChangesByUserId({ userId: OWNER, since: T0, limit: 10 }))).toEqual([
      'mine',
    ]);
  });

  it('returns no rows for a malformed keyset id instead of throwing a cast error', async () => {
    await insertSession('s1');
    await expect(
      sessionRepository.listChangesByUserId({ userId: OWNER, since: T0, after: { at: T0, id: 'nope' }, limit: 10 })
    ).resolves.toEqual([]);
  });

  it('is served by the { userId, updatedAt, _id } index without an in-memory sort', async () => {
    for (const name of ['s1', 's2', 's3']) await insertSession(name);
    const explained = await Session.find({ userId: OWNER, surface: null, $and: [{ updatedAt: { $gte: T0 } }] })
      .setOptions({ includeDeleted: true })
      .sort({ updatedAt: 1, _id: 1 })
      .limit(2)
      .explain();
    const winningPlan = JSON.stringify(
      (explained as unknown as { queryPlanner: { winningPlan: unknown } }[])[0]?.queryPlanner?.winningPlan ??
        (explained as unknown as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan
    );
    expect(winningPlan).toContain('userId_1_updatedAt_1__id_1');
    expect(winningPlan).not.toContain('"stage":"SORT"');
  });
});
