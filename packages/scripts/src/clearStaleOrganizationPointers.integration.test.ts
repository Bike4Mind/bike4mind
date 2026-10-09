import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import mongoose from 'mongoose';
import { Organization, organizationRepository, User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';

vi.mock('../utils/config', () => ({ Config: {} }));

import { clearPointers, clearStaleOrganizationPointers, parseRepairArgs } from './clearStaleOrganizationPointers';

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
  vi.restoreAllMocks();
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

    // Pin the umask so the mode assertion tests the explicit 0600 rather than passing on a 077 host,
    // where a write with no mode would land on the same bits.
    const previousUmask = process.umask(0o022);
    try {
      const result = await clearStaleOrganizationPointers({ reportPath, log: silent });

      expect(result.byReason).toEqual({ 'org-missing': 4, 'not-member': 4 });
      expect(result.cleared).toBe(0);
      const live = result.orgs.find(o => o.organizationId === String(s.liveOrg));
      expect(live?.reason).toBe('not-member');
      expect(live?.userIds.sort()).toEqual([s.noPermRow, s.removed, s.removedString, s.manager].map(String).sort());
      expect(String(await pointerOf(s.removed))).toBe(String(s.liveOrg));
      expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual({ apply: false, orgs: result.orgs });
      expect(statSync(reportPath).mode & 0o777).toBe(0o600);
      await expect(clearStaleOrganizationPointers({ reportPath, log: silent })).rejects.toThrow(/EEXIST/);
    } finally {
      process.umask(previousUmask);
    }
  });

  it('apply nulls and records the reported ids when nothing changes mid-run', async () => {
    await seed();
    const reportPath = join(mkdtempSync(join(tmpdir(), 'stale-pointers-')), 'report.json');

    const result = await clearStaleOrganizationPointers({ apply: true, reportPath, log: silent });

    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(report).toEqual({ apply: true, orgs: result.orgs });
    const reportedIds = report.orgs.flatMap((o: { userIds: string[] }) => o.userIds);
    expect(reportedIds).toHaveLength(result.cleared);
    const stillPointing = await User.collection
      .find({
        _id: { $in: reportedIds.map((id: string) => new mongoose.Types.ObjectId(id)) },
        organizationId: { $ne: null },
      })
      .toArray();
    expect(stillPointing).toEqual([]);
  });

  it('apply writes nothing when the report cannot be written', async () => {
    const s = await seed();
    const reportPath = join(tmpdir(), `missing-dir-${oid()}`, 'report.json');

    await expect(clearStaleOrganizationPointers({ apply: true, reportPath, log: silent })).rejects.toThrow();

    expect(String(await pointerOf(s.removed))).toBe(String(s.liveOrg));
    expect(await pointerOf(s.onGhost)).not.toBeNull();
  });

  it('apply keeps a user who joined the org between grading and the write', async () => {
    const s = await seed();
    const findMemberUserIds = organizationRepository.findMemberUserIds.bind(organizationRepository);
    let liveOrgCalls = 0;
    vi.spyOn(organizationRepository, 'findMemberUserIds').mockImplementation(async organizationId => {
      if (organizationId === String(s.liveOrg) && ++liveOrgCalls === 2) {
        await Organization.collection.updateOne({ _id: s.liveOrg }, {
          $push: { users: { userId: String(s.removed), permissions: ['read'] } },
        } as never);
      }
      return findMemberUserIds(organizationId);
    });

    const lines: string[] = [];
    const result = await clearStaleOrganizationPointers({ apply: true, log: m => lines.push(m) });

    expect(result.orgs.find(o => o.organizationId === String(s.liveOrg))?.userIds).toContain(String(s.removed));
    expect(String(await pointerOf(s.removed))).toBe(String(s.liveOrg));
    expect(await pointerOf(s.manager)).toBeNull();
    expect(result.cleared).toBe(7);
    expect(lines).toContain(`org ${s.liveOrg}: nulled 3 of 4 listed pointer(s)`);
  });

  it('logs the actual nulled count when a pointer moves between the re-grade and the write', async () => {
    const s = await seed();
    const reportPath = join(mkdtempSync(join(tmpdir(), 'stale-pointers-')), 'report.json');
    const findMemberUserIds = organizationRepository.findMemberUserIds.bind(organizationRepository);
    let liveOrgCalls = 0;
    vi.spyOn(organizationRepository, 'findMemberUserIds').mockImplementation(async organizationId => {
      if (organizationId === String(s.liveOrg) && ++liveOrgCalls === 2) {
        // The re-grade has already read the pointers; moving the manager now leaves it in `toClear`
        // but outside the guarded write, so the write nulls one fewer than the report listed.
        await User.collection.updateOne({ _id: s.manager }, { $set: { organizationId: oid() } });
      }
      return findMemberUserIds(organizationId);
    });

    const lines: string[] = [];
    const result = await clearStaleOrganizationPointers({ apply: true, reportPath, log: m => lines.push(m) });

    const reportedLive = JSON.parse(readFileSync(reportPath, 'utf8')).orgs.find(
      (o: { organizationId: string }) => o.organizationId === String(s.liveOrg)
    );
    expect(reportedLive.userIds).toContain(String(s.manager));
    expect(lines).toContain(`org ${s.liveOrg}: nulled 3 of 4 listed pointer(s)`);
    expect(result.cleared).toBe(7);
  });

  it('apply neither nulls nor reports a user who becomes stale between the report and the write', async () => {
    const s = await seed();
    const reportPath = join(mkdtempSync(join(tmpdir(), 'stale-pointers-')), 'report.json');
    const findMemberUserIds = organizationRepository.findMemberUserIds.bind(organizationRepository);
    let liveOrgCalls = 0;
    vi.spyOn(organizationRepository, 'findMemberUserIds').mockImplementation(async organizationId => {
      if (organizationId === String(s.liveOrg) && ++liveOrgCalls === 2) {
        await Organization.collection.updateOne({ _id: s.liveOrg }, {
          $pull: { users: { userId: String(s.member) } },
        } as never);
      }
      return findMemberUserIds(organizationId);
    });

    const result = await clearStaleOrganizationPointers({ apply: true, reportPath, log: silent });

    // s.member was a member when the report was written, so it is absent from the report; the
    // re-grade now calls it stale, and the report filter is what keeps it pointing at the org.
    expect(String(await pointerOf(s.member))).toBe(String(s.liveOrg));
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const reportedIds = report.orgs.flatMap((o: { userIds: string[] }) => o.userIds);
    expect(reportedIds).not.toContain(String(s.member));
    expect(result.cleared).toBe(8);
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

describe('parseRepairArgs', () => {
  it('defaults the report to a timestamped file in the OS temp dir, dry run', () => {
    const { apply, reportPath } = parseRepairArgs(['node', 'script']);
    expect(apply).toBe(false);
    expect(reportPath.startsWith(tmpdir())).toBe(true);
    expect(reportPath).toMatch(/stale-organization-pointers-\d+\.json$/);
  });

  it('takes an explicit --report path alongside --apply', () => {
    expect(parseRepairArgs(['node', 'script', '--apply', '--report', '/tmp/r.json'])).toEqual({
      apply: true,
      reportPath: '/tmp/r.json',
    });
  });

  it('honours the --report=<path> form', () => {
    expect(parseRepairArgs(['node', 'script', '--apply', '--report=/tmp/r.json'])).toEqual({
      apply: true,
      reportPath: '/tmp/r.json',
    });
  });

  it('rejects an empty --report= value', () => {
    expect(() => parseRepairArgs(['node', 'script', '--report='])).toThrow('--report needs a file path');
  });

  it('rejects --report with no value or a flag as its value', () => {
    expect(() => parseRepairArgs(['node', 'script', '--apply', '--report'])).toThrow('--report needs a file path');
    expect(() => parseRepairArgs(['node', 'script', '--report', '--apply'])).toThrow('--report needs a file path');
  });
});
