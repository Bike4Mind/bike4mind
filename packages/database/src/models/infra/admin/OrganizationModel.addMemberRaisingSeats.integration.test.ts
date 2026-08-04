import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { Permission } from '@bike4mind/common';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Organization, organizationRepository } from './OrganizationModel';

/**
 * Concurrency proof for `addMemberRaisingSeats` (#1239). The domain-signup auto-add raises the seat
 * ceiling to fit rather than rejecting at capacity, so N racing signups into one org must land N
 * members with `seats` equal to the real member count - never a double-raise and never a duplicate.
 *
 * A standalone mongod is enough: this is single-document atomicity (one guarded `findOneAndUpdate`
 * with a `$max` seat pipeline), not a multi-document transaction, so Mongo serialises the writes on
 * the one org doc and each update sees the committed result of the prior.
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
  await Organization.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
});

const member = (userId: string) => ({ userId, permissions: [Permission.read] });

describe('OrganizationModel.addMemberRaisingSeats (#1239)', () => {
  it('raises the ceiling to fit a member added past capacity', async () => {
    const created = await Organization.create({ name: 'Partner', userId: 'owner', seats: 2, users: [] });

    const updated = await organizationRepository.addMemberRaisingSeats(created.id, member('u1'));

    expect(updated).not.toBeNull();
    expect(updated!.users.map(u => u.userId)).toEqual(['u1']);
    // Only 1 real member, so the ceiling holds at the existing 2 rather than dropping.
    expect(updated!.seats).toBe(2);
  });

  it('leaves the ceiling alone when the member fits under it', async () => {
    const created = await Organization.create({ name: 'Partner', userId: 'owner', seats: 10, users: [member('a')] });

    const updated = await organizationRepository.addMemberRaisingSeats(created.id, member('b'));

    expect(updated!.seats).toBe(10);
    expect(updated!.users).toHaveLength(2);
  });

  it('returns null and writes nothing when the user is already a member (idempotent guard)', async () => {
    const created = await Organization.create({ name: 'Partner', userId: 'owner', seats: 1, users: [member('u1')] });

    const updated = await organizationRepository.addMemberRaisingSeats(created.id, member('u1'));

    expect(updated).toBeNull();
    const fresh = await Organization.findById(created.id);
    expect(fresh!.users).toHaveLength(1);
    expect(fresh!.seats).toBe(1);
  });

  it('N concurrent DISTINCT signups all land, with seats == member count (no double-raise)', async () => {
    const created = await Organization.create({ name: 'Partner', userId: 'owner', seats: 1, users: [] });
    const userIds = Array.from({ length: 8 }, (_, i) => `u${i}`);

    const results = await Promise.all(
      userIds.map(id => organizationRepository.addMemberRaisingSeats(created.id, member(id)))
    );

    // Every distinct add succeeded (non-null).
    expect(results.every(r => r !== null)).toBe(true);
    const fresh = await Organization.findById(created.id);
    expect(fresh!.users).toHaveLength(userIds.length);
    expect(new Set(fresh!.users.map(u => u.userId)).size).toBe(userIds.length);
    // The invariant: seats was raised exactly to the real member count, never past it.
    expect(fresh!.seats).toBe(userIds.length);
  });

  it('the SAME user racing itself is admitted exactly once and raises seats once', async () => {
    const created = await Organization.create({ name: 'Partner', userId: 'owner', seats: 1, users: [] });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => organizationRepository.addMemberRaisingSeats(created.id, member('dup')))
    );

    // Exactly one update matched the `$ne` guard; the rest lost the race and returned null.
    expect(results.filter(r => r !== null)).toHaveLength(1);
    const fresh = await Organization.findById(created.id);
    expect(fresh!.users.map(u => u.userId)).toEqual(['dup']);
    expect(fresh!.seats).toBe(1);
  });
});
