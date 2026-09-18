import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { Organization, organizationRepository } from './OrganizationModel';
import User from '../../auth/UserModel';
import { setupMongoTest } from '../../../__test__/utils';

const makeOrg = (name: string, extra: Record<string, unknown> = {}) =>
  Organization.create({ name, userId: 'owner', users: [], groups: [], ...extra });

// Only the organizationId pointer matters here, but these go through the model rather than the raw
// driver: that pointer is what the feedback create handler copies onto a report, so a test that
// skipped validation could pin a shape the write path cannot actually produce.
const makeUser = (id: string, organizationId?: string) =>
  User.create({
    _id: new mongoose.Types.ObjectId(id),
    username: `user-${id}`,
    name: `User ${id}`,
    email: `${id}@example.com`,
    ...(organizationId ? { organizationId } : {}),
  });

const oid = () => String(new mongoose.Types.ObjectId());

describe('OrganizationRepository.findMemberUserIds', () => {
  setupMongoTest();

  it('unions the ACL and the stamp pointer, and reports no discrepancy when they agree', async () => {
    const ownerId = oid();
    const memberId = oid();
    const org = await makeOrg('agreed', { userId: ownerId, users: [{ userId: memberId, permissions: ['read'] }] });
    await makeUser(ownerId, String(org._id));
    await makeUser(memberId, String(org._id));

    const population = await organizationRepository.findMemberUserIds(String(org._id));

    expect(population.userIds.sort()).toEqual([ownerId, memberId].sort());
    expect(population.aclOnly).toEqual([]);
    expect(population.stampOnly).toEqual([]);
  });

  it('keeps an author the ACL does not know about, and names them in stampOnly', async () => {
    // The case an ACL-derived $in loses silently: a manager or appointed admin whose
    // User.organizationId points here but who holds no users[] row.
    const ownerId = oid();
    const managerId = oid();
    const org = await makeOrg('manager-only', { userId: ownerId, managerId, users: [] });
    await makeUser(ownerId, String(org._id));
    await makeUser(managerId, String(org._id));

    const population = await organizationRepository.findMemberUserIds(String(org._id));

    expect(population.userIds).toContain(managerId);
    expect(population.stampOnly).toEqual([managerId]);
    expect(population.aclOnly).toEqual([]);
  });

  it('keeps an ACL member whose pointer is elsewhere, and names them in aclOnly', async () => {
    const ownerId = oid();
    const memberId = oid();
    const org = await makeOrg('lagging-pointer', {
      userId: ownerId,
      users: [{ userId: memberId, permissions: ['read'] }],
    });
    await makeUser(ownerId, String(org._id));
    await makeUser(memberId, oid());

    const population = await organizationRepository.findMemberUserIds(String(org._id));

    expect(population.userIds).toContain(memberId);
    expect(population.aclOnly).toEqual([memberId]);
    expect(population.stampOnly).toEqual([]);
  });

  it('returns the owner alone for an org with an empty ACL', async () => {
    // The owner holds a seat without a users[] row, so this arm is never empty.
    const ownerId = oid();
    const org = await makeOrg('solo', { userId: ownerId, users: [] });

    const population = await organizationRepository.findMemberUserIds(String(org._id));

    expect(population.userIds).toEqual([ownerId]);
    expect(population.aclOnly).toEqual([ownerId]);
  });

  it('excludes an ACL row that grants neither read nor write', async () => {
    const ownerId = oid();
    const shareOnlyId = oid();
    const org = await makeOrg('share-only', {
      userId: ownerId,
      users: [{ userId: shareOnlyId, permissions: ['share'] }],
    });

    const population = await organizationRepository.findMemberUserIds(String(org._id));

    expect(population.userIds).toEqual([ownerId]);
  });

  it('drops a removed member entirely once both the ACL row and the pointer are gone', async () => {
    // Asserted rather than left incidental: this is the report's population rule. An ex-member's
    // historical stamped rows fall out of the report along with them.
    const ownerId = oid();
    const exMemberId = oid();
    const org = await makeOrg('after-removal', { userId: ownerId, users: [] });
    await makeUser(ownerId, String(org._id));
    await makeUser(exMemberId, oid());

    const population = await organizationRepository.findMemberUserIds(String(org._id));

    expect(population.userIds).toEqual([ownerId]);
    expect(population.stampOnly).toEqual([]);
  });

  it('returns an empty population for a malformed id, a missing org, and a soft-deleted org', async () => {
    const empty = { userIds: [], aclOnly: [], stampOnly: [] };
    expect(await organizationRepository.findMemberUserIds('not-an-object-id')).toEqual(empty);
    expect(await organizationRepository.findMemberUserIds(oid())).toEqual(empty);

    const deleted = await makeOrg('soft-deleted', { userId: oid(), users: [] });
    // Mirrors softDeletePlugin's own mechanism (raw-driver updateOne, see mongo.ts) rather than
    // calling a model method, so this exercises the plugin's pre('find') filter.
    await Organization.collection.updateOne({ _id: deleted._id }, { $set: { deletedAt: new Date() } });
    expect(await organizationRepository.findMemberUserIds(String(deleted._id))).toEqual(empty);
  });
});
