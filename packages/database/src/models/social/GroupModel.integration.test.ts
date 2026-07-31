import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Group, groupRepository } from './GroupModel';

/**
 * Regression guard for the group-scoped invite auth path: `authorizeByInviteType`
 * resolves a Group invite via `group.organizationId`, so that field MUST round-trip
 * through the schema. It previously did not (the schema omitted it, so strict mode
 * dropped it on write), which left every group-invite list/cancel denied.
 */

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Build indexes before any test runs - the unique-index test asserts a duplicate insert
  // REJECTS, which only holds once group_org_type_live exists. autoIndex is async and races the
  // first insert, so without this the assertion is order-dependent (green only when earlier tests
  // happen to give the build time). syncIndexes awaits the build deterministically.
  await Group.syncIndexes();
}, 30000);
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);
afterEach(async () => {
  // hardDelete: the plugin turns a plain deleteMany into a soft-delete, which would leave rows
  // accumulating across tests (harmless for the unique index since it is live-only, but noise).
  await Group.deleteMany({}, { hardDelete: true });
});

describe('GroupModel', () => {
  it('persists organizationId so group-scoped invite auth can resolve the parent org', async () => {
    const created = await Group.create({
      name: 'Eng',
      description: 'engineering',
      type: 'sales',
      organizationId: 'org-1',
    });

    // read straight from Mongo, not the in-memory doc, to prove it was actually stored
    const reloaded = await Group.findById(created.id);
    expect(reloaded?.organizationId).toBe('org-1');
    expect(reloaded?.toJSON().organizationId).toBe('org-1');
    expect(reloaded?.type).toBe('sales');
  });

  it('requires organizationId', async () => {
    // intentionally omit the now-required organizationId to prove the schema rejects it;
    // cast through unknown because the typed create() would flag the missing field at compile time
    await expect(
      Group.create({ name: 'Eng', description: 'engineering', type: 'sales' } as unknown as Parameters<
        typeof Group.create
      >[0])
    ).rejects.toThrow();
  });

  it('requires type', async () => {
    await expect(
      Group.create({ name: 'Eng', description: 'engineering', organizationId: 'org-1' } as unknown as Parameters<
        typeof Group.create
      >[0])
    ).rejects.toThrow();
  });

  // The create route defaults an omitted description to ''. Mongoose treats '' as missing,
  // so a `required` description would reject every group created without one (a 500 on the
  // real provisioning path). Description is optional and defaults to ''.
  it('allows an omitted/empty description (defaults to "")', async () => {
    // Distinct (org, type) per create: the group_org_type_live unique index allows only one live
    // group per (organizationId, type).
    const omitted = await Group.create({ name: 'NoDesc', type: 'sales', organizationId: 'org-1' });
    expect((await Group.findById(omitted.id))?.description).toBe('');

    const empty = await Group.create({ name: 'EmptyDesc', description: '', type: 'research', organizationId: 'org-1' });
    expect((await Group.findById(empty.id))?.description).toBe('');
  });
});

describe('GroupRepository', () => {
  it('findByOrganization returns live groups for the org, excluding other orgs and soft-deleted', async () => {
    const a = await Group.create({ name: 'A', description: 'd', type: 'sales', organizationId: 'org-1' });
    await Group.create({ name: 'B', description: 'd', type: 'research', organizationId: 'org-1' });
    await Group.create({ name: 'C', description: 'd', type: 'sales', organizationId: 'org-2' });

    // soft-delete one of org-1's groups; it must drop out of findByOrganization
    await groupRepository.delete(a.id);

    const org1Groups = await groupRepository.findByOrganization('org-1');
    expect(org1Groups.map(g => g.type).sort()).toEqual(['research']);
    expect(org1Groups.every(g => typeof g.id === 'string')).toBe(true);
  });

  it('enforces one LIVE group per (organizationId, type), but allows revoke-then-regrant', async () => {
    await Group.create({ name: 'Sales', type: 'sales', organizationId: 'org-live' });

    // a second LIVE group of the same (org, type) is rejected by group_org_type_live
    await expect(Group.create({ name: 'Sales 2', type: 'sales', organizationId: 'org-live' })).rejects.toThrow(
      /duplicate key/i
    );

    // ...but soft-deleting the first frees the partial-unique slot, so re-granting succeeds
    const [live] = await groupRepository.findByOrganization('org-live');
    await groupRepository.delete(live.id);
    await expect(Group.create({ name: 'Sales 3', type: 'sales', organizationId: 'org-live' })).resolves.toBeTruthy();
  });

  it('delete() is a soft delete (row survives with deletedAt set)', async () => {
    const g = await Group.create({ name: 'G', description: 'd', type: 'customer', organizationId: 'org-3' });

    await groupRepository.delete(g.id);

    expect(await groupRepository.findByOrganization('org-3')).toEqual([]);
    // the document still exists (soft, not hard delete) - visible when bypassing the find hook
    const raw = await mongoose.connection.collection('groups').findOne({ _id: g._id });
    expect(raw?.deletedAt).toBeInstanceOf(Date);
  });

  describe('createIfMissing (org-groups #1222)', () => {
    it('creates normally when nothing exists yet', async () => {
      const group = await groupRepository.createIfMissing({
        name: 'Sales',
        description: 'd',
        type: 'sales',
        organizationId: 'org-race',
      });

      expect(group.type).toBe('sales');
      const [stored] = await groupRepository.findByOrganization('org-race');
      expect(stored.id).toBe(group.id);
    });

    // The actual race: simulate two overlapping grant PUTs both calling createIfMissing for the
    // same (org, type) after both observed no live instance. Real concurrent requests would race
    // at the driver level; issuing them back-to-back here still exercises the E11000 catch,
    // since the second call's create() genuinely collides with the first's already-committed row.
    it('returns the WINNING row instead of throwing when a concurrent create collides', async () => {
      const first = await groupRepository.createIfMissing({
        name: 'Sales',
        description: 'd',
        type: 'sales',
        organizationId: 'org-race-2',
      });

      const second = await groupRepository.createIfMissing({
        name: 'Sales (loser)',
        description: 'd',
        type: 'sales',
        organizationId: 'org-race-2',
      });

      // Same row, not a second one - proves this resolved via the E11000 catch, not a silent
      // second insert (which the unique index would reject anyway).
      expect(second.id).toBe(first.id);
      expect(second.name).toBe('Sales');
      const live = await groupRepository.findByOrganization('org-race-2');
      expect(live).toHaveLength(1);
    });

    it('re-throws a genuine E11000 if the winning row cannot be found (e.g. deleted mid-race)', async () => {
      // Prove the fallback path does not silently swallow every duplicate-key error: force a
      // simulated E11000 out of create(), then look for a row (org-race-4/research) that does
      // NOT actually exist. createIfMissing's post-catch findOne must find nothing and re-throw,
      // not return undefined as if the row were there.
      const spy = vi.spyOn(groupRepository, 'create').mockImplementationOnce(async () => {
        const err = new Error('E11000 duplicate key error simulated') as Error & { code: number };
        err.code = 11000;
        throw err;
      });

      await expect(
        groupRepository.createIfMissing({
          name: 'Research',
          description: 'd',
          type: 'research',
          organizationId: 'org-race-4',
        })
      ).rejects.toThrow(/E11000/);

      spy.mockRestore();
    });
  });
});
