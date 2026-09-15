import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Session, sessionRepository } from './SessionModel';

/**
 * findUpdateAccessById gates writes into a shareable session. Its default arm-set is owner +
 * user-update-share + group-update-share; a global-write share counts only when the caller opts in
 * via includeGlobalWrite. The artifact-create source-ref guard opts in (a global-write sharee may
 * stamp an artifact with the session id); sharing-mutation callers must not, so a global-write
 * sharee cannot re-share or delete. Pinned against real Mongo because the escaped regression lived
 * exactly in this arm-set - the pure-guard unit test mocks canUpdateSession away.
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
const user = (id: string, groups: string[] = []) => ({ id, groups });

describe('ShareableDocumentRepository.findUpdateAccessById - isGlobalWrite arm', () => {
  it('matches owner, user-update, and group-update shares (flag irrelevant)', async () => {
    const owned = await Session.create({ userId: 'owner', name: 'owned', ...times });
    const userShared = await Session.create({
      userId: 'owner',
      name: 'user-shared',
      users: [{ userId: 'collab', permissions: ['update'] }],
      ...times,
    });
    const groupShared = await Session.create({
      userId: 'owner',
      name: 'group-shared',
      groups: [{ groupId: 'g1', permissions: ['update'] }],
      ...times,
    });

    expect(await sessionRepository.shareable.findUpdateAccessById(user('owner'), owned.id)).not.toBeNull();
    expect(await sessionRepository.shareable.findUpdateAccessById(user('collab'), userShared.id)).not.toBeNull();
    expect(
      await sessionRepository.shareable.findUpdateAccessById(user('member', ['g1']), groupShared.id)
    ).not.toBeNull();
  });

  it('excludes a global-write share by default, includes it only on opt-in', async () => {
    const gw = await Session.create({ userId: 'owner', name: 'global-write', isGlobalWrite: true, ...times });

    // Default (sharing-mutation callers): global-write is NOT update access.
    expect(await sessionRepository.shareable.findUpdateAccessById(user('stranger'), gw.id)).toBeNull();

    // Opt-in (artifact source-ref guard): global-write grants the write.
    expect(
      await sessionRepository.shareable.findUpdateAccessById(user('stranger'), gw.id, { includeGlobalWrite: true })
    ).not.toBeNull();
  });

  it('still rejects a read-only sharee and a stranger even with the flag on', async () => {
    const readOnly = await Session.create({
      userId: 'owner',
      name: 'read-only',
      users: [{ userId: 'reader', permissions: ['read'] }],
      isGlobalRead: true,
      ...times,
    });

    expect(
      await sessionRepository.shareable.findUpdateAccessById(user('reader'), readOnly.id, { includeGlobalWrite: true })
    ).toBeNull();
    expect(
      await sessionRepository.shareable.findUpdateAccessById(user('nobody'), readOnly.id, { includeGlobalWrite: true })
    ).toBeNull();
  });
});
