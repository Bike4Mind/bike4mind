import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Group } from './GroupModel';

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
    const created = await Group.create({ name: 'Eng', description: 'engineering', organizationId: 'org-1' });

    // read straight from Mongo, not the in-memory doc, to prove it was actually stored
    const reloaded = await Group.findById(created.id);
    expect(reloaded?.organizationId).toBe('org-1');
    expect(reloaded?.toJSON().organizationId).toBe('org-1');
  });

  it('requires organizationId', async () => {
    await expect(Group.create({ name: 'Eng', description: 'engineering' } as never)).rejects.toThrow();
  });
});
