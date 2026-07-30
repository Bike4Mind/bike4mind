import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
}, 30000);
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);
afterEach(async () => {
  await Group.deleteMany({});
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
});

describe('GroupRepository', () => {
  it('findByOrganization returns live groups for the org, excluding other orgs and soft-deleted', async () => {
    const a = await Group.create({ name: 'A', description: 'd', type: 'sales', organizationId: 'org-1' });
    await Group.create({ name: 'B', description: 'd', type: 'research', organizationId: 'org-1' });
    await Group.create({ name: 'C', description: 'd', type: 'sales', organizationId: 'org-2' });

    // soft-delete one of org-1's groups; it must drop out of findByOrganization
    await groupRepository.softDeleteByIds([a.id]);

    const org1Groups = await groupRepository.findByOrganization('org-1');
    expect(org1Groups.map(g => g.type).sort()).toEqual(['research']);
    expect(org1Groups.every(g => typeof g.id === 'string')).toBe(true);
  });

  it('softDeleteByIds is a soft delete (row survives with deletedAt set) and is a no-op on []', async () => {
    const g = await Group.create({ name: 'G', description: 'd', type: 'customer', organizationId: 'org-3' });

    await groupRepository.softDeleteByIds([]); // no-op, must not throw
    await groupRepository.softDeleteByIds([g.id]);

    expect(await groupRepository.findByOrganization('org-3')).toEqual([]);
    // the document still exists (soft, not hard delete) - visible when bypassing the find hook
    const raw = await mongoose.connection.collection('groups').findOne({ _id: g._id });
    expect(raw?.deletedAt).toBeInstanceOf(Date);
  });
});
