import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import mongoose from 'mongoose';
import { Organization, User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';

vi.mock('../utils/config', () => ({ Config: {} }));

import { clearPointers, clearStaleOrganizationPointers } from './clearStaleOrganizationPointers';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await User.collection.deleteMany({});
  await Organization.collection.deleteMany({});
});

const silent = () => undefined;
const oid = () => new mongoose.Types.ObjectId();

const insertUser = async (organizationId: unknown, extra: Record<string, unknown> = {}) => {
  const _id = oid();
  await User.collection.insertOne({ _id, username: `u-${_id}`, organizationId, ...extra });
  return _id;
};

const pointerOf = async (userId: mongoose.Types.ObjectId) =>
  (await User.collection.findOne({ _id: userId }))?.organizationId ?? null;

/**
 * One live org: owner, conferring ACL member, a users[] row without a conferring permission, a
 * removed member (once more with the pointer stored as a string), a managerId-only manager, a
 * groups[]-only member and a platform admin, each pointing at it. Plus a soft-deleted org, a
 * never-existing org id (stored once as ObjectId, once as a string, once by an admin), and a user
 * with no pointer.
 */
async function seed() {
  const liveOrg = oid();
  const deletedOrg = oid();
  const ghostOrg = oid();

  const owner = await insertUser(liveOrg);
  const member = await insertUser(liveOrg);
  const noPermRow = await insertUser(liveOrg);
  const removed = await insertUser(liveOrg);
  const removedString = await insertUser(String(liveOrg));
  const manager = await insertUser(liveOrg);
  const groupId = String(oid());
  const groupMember = await insertUser(liveOrg, { groups: [groupId] });
  const admin = await insertUser(liveOrg, { isAdmin: true });
  const onDeleted = await insertUser(deletedOrg);
  const onGhost = await insertUser(ghostOrg);
  const onGhostString = await insertUser(String(ghostOrg));
  const adminOnGhost = await insertUser(ghostOrg, { isAdmin: true });
  const noPointer = await insertUser(null);

  await Organization.collection.insertMany([
    {
      _id: liveOrg,
      name: 'Live',
      userId: String(owner),
      managerId: String(manager),
      users: [
        { userId: String(member), permissions: ['read'] },
        { userId: String(noPermRow), permissions: [] },
      ],
      groups: [{ groupId, permissions: ['read'] }],
      deletedAt: null,
    },
    { _id: deletedOrg, name: 'Deleted', userId: String(onDeleted), users: [], deletedAt: new Date() },
  ]);

  return {
    liveOrg,
    owner,
    member,
    noPermRow,
    removed,
    removedString,
    manager,
    groupMember,
    admin,
    onDeleted,
    onGhost,
    onGhostString,
    adminOnGhost,
    noPointer,
  };
}

describe('clearStaleOrganizationPointers', () => {
  it('dry run reports the stale pointers by reason and writes nothing', async () => {
    const s = await seed();

    const reportPath = join(mkdtempSync(join(tmpdir(), 'stale-pointers-')), 'report.json');

    const result = await clearStaleOrganizationPointers({ reportPath, log: silent });

    expect(result.byReason).toEqual({ 'org-missing': 4, 'not-member': 4 });
    expect(result.cleared).toBe(0);
    const live = result.orgs.find(o => o.organizationId === String(s.liveOrg));
    expect(live?.reason).toBe('not-member');
    expect(live?.userIds.sort()).toEqual([s.noPermRow, s.removed, s.removedString, s.manager].map(String).sort());
    expect(String(await pointerOf(s.removed))).toBe(String(s.liveOrg));
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual({ apply: false, orgs: result.orgs });
  });

  it('apply nulls only the stale pointers and a second run finds nothing', async () => {
    const s = await seed();

    const result = await clearStaleOrganizationPointers({ apply: true, log: silent });
    expect(result.cleared).toBe(8);

    // groupMember and admin are excluded from findMemberUserIds but resolveActiveOrg still accepts them.
    for (const kept of [s.owner, s.member, s.groupMember, s.admin])
      expect(String(await pointerOf(kept))).toBe(String(s.liveOrg));
    for (const nulled of [
      s.noPermRow,
      s.removed,
      s.removedString,
      s.manager,
      s.onDeleted,
      s.onGhost,
      s.onGhostString,
      s.adminOnGhost,
    ]) {
      expect(await pointerOf(nulled)).toBeNull();
    }
    expect(await pointerOf(s.noPointer)).toBeNull();

    const again = await clearStaleOrganizationPointers({ apply: true, log: silent });
    expect(again.orgs).toEqual([]);
    expect(again.cleared).toBe(0);
  });

  it('skips a user whose pointer moved between detection and write', async () => {
    const s = await seed();
    const elsewhere = oid();
    await User.collection.updateOne({ _id: s.removed }, { $set: { organizationId: elsewhere } });

    const cleared = await clearPointers(String(s.liveOrg), [String(s.removed), String(s.manager)]);

    expect(cleared).toBe(1);
    expect(String(await pointerOf(s.removed))).toBe(String(elsewhere));
    expect(await pointerOf(s.manager)).toBeNull();
  });
});
