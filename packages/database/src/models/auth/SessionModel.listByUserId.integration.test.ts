import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Session, sessionRepository } from './SessionModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Built explicitly so the plan assertion below does not depend on autoIndex timing.
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

const names = (sessions: { name: string }[]) => sessions.map(session => session.name);

describe('sessionRepository.listByUserId', () => {
  it('pages newest first by _id, resuming strictly before the cursor id', async () => {
    for (const name of ['s1', 's2', 's3', 's4', 's5']) await insertSession(name);

    const first = await sessionRepository.listByUserId({ userId: OWNER, limit: 2 });
    expect(names(first)).toEqual(['s5', 's4']);

    const second = await sessionRepository.listByUserId({ userId: OWNER, limit: 2, beforeId: first[1].id });
    expect(names(second)).toEqual(['s3', 's2']);

    const last = await sessionRepository.listByUserId({ userId: OWNER, limit: 2, beforeId: second[1].id });
    expect(names(last)).toEqual(['s1']);
  });

  it('keeps a page boundary stable when a session is edited between pages', async () => {
    for (const name of ['s1', 's2', 's3']) await insertSession(name);
    const first = await sessionRepository.listByUserId({ userId: OWNER, limit: 1 });
    expect(names(first)).toEqual(['s3']);

    // Bumping lastUpdated would reorder an offset list sorted by it; the _id order is unaffected.
    await Session.updateOne({ name: 's1' }, { $set: { lastUpdated: new Date(Date.now() + 60_000) } });

    const rest = await sessionRepository.listByUserId({ userId: OWNER, limit: 5, beforeId: first[0].id });
    expect(names(rest)).toEqual(['s2', 's1']);
  });

  it("lists only the caller's own, live, surface-less sessions by default", async () => {
    await insertSession('mine');
    await insertSession('theirs', { userId: 'someone-else' });
    await insertSession('product', { surface: 'libreoncology' });
    const deleted = await insertSession('deleted');
    await Session.collection.updateOne({ _id: deleted._id }, { $set: { deletedAt: new Date() } });

    expect(names(await sessionRepository.listByUserId({ userId: OWNER, limit: 10 }))).toEqual(['mine']);
    expect(names(await sessionRepository.listByUserId({ userId: OWNER, limit: 10, surface: 'libreoncology' }))).toEqual(
      ['product']
    );
  });

  it('applies the same search and origin filters as searchByUserId', async () => {
    await insertSession('Quarterly plan');
    await insertSession('Groceries', { tags: [{ name: 'planning', strength: 1 }] });
    await insertSession('Holiday');
    await insertSession('From the API', { origin: { channel: 'api' } });

    const searched = await sessionRepository.listByUserId({ userId: OWNER, limit: 10, search: 'PLAN' });
    expect(names(searched).sort()).toEqual(['Groceries', 'Quarterly plan']);

    const viaApi = await sessionRepository.listByUserId({ userId: OWNER, limit: 10, filters: { origin: 'api' } });
    expect(names(viaApi)).toEqual(['From the API']);
  });

  it('returns no rows for a malformed beforeId instead of throwing a cast error', async () => {
    await insertSession('s1');
    await expect(sessionRepository.listByUserId({ userId: OWNER, limit: 10, beforeId: 'nope' })).resolves.toEqual([]);
  });

  it('is served by the { deletedAt, userId, _id } index without an in-memory sort', async () => {
    for (const name of ['s1', 's2', 's3']) await insertSession(name);
    const explained = await Session.find({ userId: OWNER, surface: null }).sort({ _id: -1 }).limit(2).explain();
    const winningPlan = JSON.stringify(
      (explained as unknown as { queryPlanner: { winningPlan: unknown } }[])[0]?.queryPlanner?.winningPlan ??
        (explained as unknown as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan
    );
    expect(winningPlan).toContain('deletedAt_1_userId_1__id_-1');
    expect(winningPlan).not.toContain('"stage":"SORT"');
  });
});
