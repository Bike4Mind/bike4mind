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

describe('SessionRepository.shareable.findAllAccessibleByIds - includeDeleted', () => {
  const idsOf = (sessions: { id: string }[]) => sessions.map(s => s.id).sort();
  const reader = { id: 'reader', groups: ['group-a'] };

  it('excludes soft-deleted accessible sessions by default, includes them on opt-in', async () => {
    const live = await Session.create({ userId: 'reader', name: 'live', ...times });
    const removed = await Session.create({ userId: 'reader', name: 'removed', ...times });
    await Session.deleteOne({ _id: removed.id });
    const ids = [live.id, removed.id];

    expect(idsOf(await sessionRepository.shareable.findAllAccessibleByIds(reader, ids))).toEqual([live.id]);
    expect(
      idsOf(await sessionRepository.shareable.findAllAccessibleByIds(reader, ids, { includeDeleted: true }))
    ).toEqual([live.id, removed.id].sort());
  });

  it('grants access through a user share and a group share, including soft-deleted', async () => {
    const userShared = await Session.create({
      userId: 'owner',
      name: 'user-shared',
      users: [{ userId: 'reader', permissions: ['read'] }],
      ...times,
    });
    const groupShared = await Session.create({
      userId: 'owner',
      name: 'group-shared',
      groups: [{ groupId: 'group-a', permissions: ['read'] }],
      ...times,
    });
    await Session.deleteOne({ _id: groupShared.id });
    const ids = [userShared.id, groupShared.id];

    expect(idsOf(await sessionRepository.shareable.findAllAccessibleByIds(reader, ids))).toEqual([userShared.id]);
    expect(
      idsOf(await sessionRepository.shareable.findAllAccessibleByIds(reader, ids, { includeDeleted: true }))
    ).toEqual(ids.sort());
  });

  it('never returns an inaccessible session, deleted or not', async () => {
    const foreign = await Session.create({
      userId: 'owner',
      name: 'foreign',
      groups: [{ groupId: 'group-b', permissions: ['read'] }],
      ...times,
    });
    const foreignRemoved = await Session.create({ userId: 'owner', name: 'foreign-removed', ...times });
    await Session.deleteOne({ _id: foreignRemoved.id });

    const found = await sessionRepository.shareable.findAllAccessibleByIds(reader, [foreign.id, foreignRemoved.id], {
      includeDeleted: true,
    });

    expect(found).toEqual([]);
  });
});
