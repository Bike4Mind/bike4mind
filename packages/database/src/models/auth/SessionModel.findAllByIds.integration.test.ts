import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Session, sessionRepository } from './SessionModel';

/**
 * findAllByIds must be able to opt into soft-deleted sessions.
 *
 * userCanAccessGeneratedImage resolves a generated-image key to its owning session(s) - and
 * findSessionIdsByImage deliberately includes quests from soft-deleted turns - then loads the
 * sessions here. Without includeDeleted, softDeletePlugin's pre('find') hook appends
 * deletedAt: null, so a key whose only session was soft-deleted fails closed and the owner is
 * denied their own image. The default must still exclude soft-deleted rows.
 */
let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

afterEach(async () => {
  await Session.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
});

const times = { firstCreated: new Date('2023-01-01'), lastUpdated: new Date('2023-02-01') };

describe('SessionRepository.findAllByIds - includeDeleted', () => {
  it('excludes soft-deleted sessions by default, includes them on opt-in', async () => {
    const live = await Session.create({ userId: 'userA', name: 'live', ...times });
    const removed = await Session.create({ userId: 'userA', name: 'removed', ...times });
    await Session.deleteOne({ _id: removed.id }); // soft delete (no hardDelete)

    const ids = [live.id, removed.id];

    const byDefault = await sessionRepository.findAllByIds(ids);
    expect(byDefault.map(s => s.id).sort()).toEqual([live.id]);

    const withDeleted = await sessionRepository.findAllByIds(ids, { includeDeleted: true });
    expect(withDeleted.map(s => s.id).sort()).toEqual([live.id, removed.id].sort());
  });
});
