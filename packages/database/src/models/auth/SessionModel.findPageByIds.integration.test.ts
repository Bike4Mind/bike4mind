import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Session, sessionRepository } from './SessionModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
afterEach(async () => {
  await Session.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
});

const insertSession = (name: string, fields: Record<string, unknown> = {}) =>
  Session.create({ name, userId: 'owner', lastUpdated: new Date(), firstCreated: new Date(), ...fields });

const names = (sessions: { name: string }[]) => sessions.map(session => session.name);

describe('sessionRepository.findPageByIds', () => {
  it('pages the given ids ascending by _id, resuming strictly after the cursor id', async () => {
    const created = [];
    for (const name of ['s1', 's2', 's3', 's4', 's5']) created.push(await insertSession(name));
    await insertSession('outsider');
    const ids = created.map(s => s.id as string).reverse();

    const first = await sessionRepository.findPageByIds(ids, { limit: 2 });
    expect(names(first.data)).toEqual(['s1', 's2']);
    expect(first.hasMore).toBe(true);

    const second = await sessionRepository.findPageByIds(ids, { limit: 2, afterId: first.data[1].id });
    expect(names(second.data)).toEqual(['s3', 's4']);
    expect(second.hasMore).toBe(true);

    const last = await sessionRepository.findPageByIds(ids, { limit: 2, afterId: second.data[1].id });
    expect(names(last.data)).toEqual(['s5']);
    expect(last.hasMore).toBe(false);
  });

  it('skips soft-deleted rows and ids that cannot address a row', async () => {
    const live = await insertSession('live');
    const deleted = await insertSession('deleted', { deletedAt: new Date() });

    const page = await sessionRepository.findPageByIds([live.id, deleted.id, 'legacy-not-an-id'], { limit: 10 });
    expect(names(page.data)).toEqual(['live']);
    expect(page.hasMore).toBe(false);
  });

  it('returns an empty page for a cursor that is not an ObjectId', async () => {
    const session = await insertSession('s1');
    expect(await sessionRepository.findPageByIds([session.id], { limit: 1, afterId: 'nope' })).toEqual({
      data: [],
      hasMore: false,
    });
  });
});
