import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { Permission } from '@bike4mind/common';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Organization, organizationRepository } from './OrganizationModel';

/**
 * Concurrency + guard proof for the domain-signup auto-add model methods (#1239).
 *
 * `addMemberRaisingSeats` (non-Stripe orgs) raises the seat ceiling to fit rather than rejecting at
 * capacity, so N racing signups into one org must land N members with `seats` equal to the real
 * member count - never a double-raise and never a duplicate. `addMemberIfUnderCeiling` (Stripe
 * orgs) instead adds ONLY under the existing ceiling and never raises it. Both skip soft-deleted
 * orgs and return the PRE-image.
 *
 * A standalone mongod is enough: this is single-document atomicity (one guarded `findOneAndUpdate`),
 * not a multi-document transaction, so Mongo serialises the writes on the one org doc and each
 * update sees the committed result of the prior.
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

// Read past the soft-delete filter to assert the true post-state of an org.
const readRaw = (id: string) => Organization.findOne({ _id: id }, null, { includeDeleted: true } as mongoose.QueryOptions);

describe('OrganizationModel.addMemberRaisingSeats (#1239)', () => {
  it('adds the member and returns the pre-image; ceiling holds when the member fits', async () => {
    const created = await Organization.create({ name: 'Partner', userId: 'owner', seats: 2, users: [] });

    const pre = await organizationRepository.addMemberRaisingSeats(created.id, member('u1'));

    // Return value is the PRE-image (before the add), so the caller can derive before/after seats.
    expect(pre).not.toBeNull();
    expect(pre!.users).toHaveLength(0);
    expect(pre!.seats).toBe(2);
    // Post-state: the member landed and the ceiling held at 2 (only 1 real member).
    const fresh = await readRaw(created.id);
    expect(fresh!.users.map(u => u.userId)).toEqual(['u1']);
    expect(fresh!.seats).toBe(2);
  });

  it('raises the ceiling to fit a member added past capacity', async () => {
    const created = await Organization.create({ name: 'Partner', userId: 'owner', seats: 1, users: [member('a')] });

    const pre = await organizationRepository.addMemberRaisingSeats(created.id, member('b'));

    expect(pre!.seats).toBe(1);
    const fresh = await readRaw(created.id);
    expect(fresh!.users).toHaveLength(2);
    // 2 members past a ceiling of 1 => raised to 2.
    expect(fresh!.seats).toBe(2);
  });

  it('returns null and writes nothing when the user is already a member (idempotent guard)', async () => {
    const created = await Organization.create({ name: 'Partner', userId: 'owner', seats: 1, users: [member('u1')] });

    const pre = await organizationRepository.addMemberRaisingSeats(created.id, member('u1'));

    expect(pre).toBeNull();
    const fresh = await readRaw(created.id);
    expect(fresh!.users).toHaveLength(1);
    expect(fresh!.seats).toBe(1);
  });

  it('does not write into a soft-deleted org', async () => {
    const created = await Organization.create({ name: 'Partner', userId: 'owner', seats: 5, users: [] });
    await created.softDelete();

    const pre = await organizationRepository.addMemberRaisingSeats(created.id, member('u1'));

    expect(pre).toBeNull();
    const fresh = await readRaw(created.id);
    expect(fresh!.users).toHaveLength(0);
  });

  it('N concurrent DISTINCT signups all land, with seats == member count (no double-raise)', async () => {
    const created = await Organization.create({ name: 'Partner', userId: 'owner', seats: 1, users: [] });
    const userIds = Array.from({ length: 8 }, (_, i) => `u${i}`);

    const results = await Promise.all(
      userIds.map(id => organizationRepository.addMemberRaisingSeats(created.id, member(id)))
    );

    // Every distinct add matched a doc (non-null pre-image).
    expect(results.every(r => r !== null)).toBe(true);
    const fresh = await readRaw(created.id);
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
    const fresh = await readRaw(created.id);
    expect(fresh!.users.map(u => u.userId)).toEqual(['dup']);
    expect(fresh!.seats).toBe(1);
  });
});

describe('OrganizationModel.addMemberIfUnderCeiling (#1239, Stripe path)', () => {
  it('adds a member that fits under the ceiling WITHOUT raising it', async () => {
    const created = await Organization.create({ name: 'Partner', userId: 'owner', seats: 5, users: [member('a')] });

    const pre = await organizationRepository.addMemberIfUnderCeiling(created.id, member('b'));

    expect(pre).not.toBeNull();
    const fresh = await readRaw(created.id);
    expect(fresh!.users.map(u => u.userId)).toEqual(['a', 'b']);
    // Ceiling untouched - a Stripe org's billed quantity is never grown out of band.
    expect(fresh!.seats).toBe(5);
  });

  it('returns null and writes nothing when the org is at capacity', async () => {
    const created = await Organization.create({
      name: 'Partner',
      userId: 'owner',
      seats: 2,
      users: [member('a'), member('b')],
    });

    const pre = await organizationRepository.addMemberIfUnderCeiling(created.id, member('c'));

    expect(pre).toBeNull();
    const fresh = await readRaw(created.id);
    expect(fresh!.users).toHaveLength(2);
    expect(fresh!.seats).toBe(2);
  });

  it('returns null when the user is already a member (idempotent guard)', async () => {
    const created = await Organization.create({ name: 'Partner', userId: 'owner', seats: 5, users: [member('a')] });

    const pre = await organizationRepository.addMemberIfUnderCeiling(created.id, member('a'));

    expect(pre).toBeNull();
    const fresh = await readRaw(created.id);
    expect(fresh!.users).toHaveLength(1);
  });

  it('does not write into a soft-deleted org', async () => {
    const created = await Organization.create({ name: 'Partner', userId: 'owner', seats: 5, users: [] });
    await created.softDelete();

    const pre = await organizationRepository.addMemberIfUnderCeiling(created.id, member('u1'));

    expect(pre).toBeNull();
    const fresh = await readRaw(created.id);
    expect(fresh!.users).toHaveLength(0);
  });

  it('N concurrent signups into a capped Stripe org never exceed the ceiling', async () => {
    const created = await Organization.create({ name: 'Partner', userId: 'owner', seats: 3, users: [] });
    const userIds = Array.from({ length: 8 }, (_, i) => `u${i}`);

    const results = await Promise.all(
      userIds.map(id => organizationRepository.addMemberIfUnderCeiling(created.id, member(id)))
    );

    // Exactly `seats` adds matched the atomic capacity guard; the rest were rejected (null).
    expect(results.filter(r => r !== null)).toHaveLength(3);
    const fresh = await readRaw(created.id);
    expect(fresh!.users).toHaveLength(3);
    expect(fresh!.seats).toBe(3);
  });
});
