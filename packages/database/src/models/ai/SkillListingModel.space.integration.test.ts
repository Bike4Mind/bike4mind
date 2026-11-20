import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { SkillListing, approvePendingListingVersion, type SkillListingDenorm } from './SkillListingModel';
import { SkillBundle } from './SkillBundleModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await Promise.all([SkillListing.syncIndexes(), SkillBundle.syncIndexes()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

beforeEach(async () => {
  await SkillListing.collection.deleteMany({});
  await SkillBundle.collection.deleteMany({});
});

let seq = 0;
const base = () => ({ sourceSkillId: `skill-${++seq}`, authorUserId: 'author', name: 'Foo', description: 'd' });

async function approve(listingId: string, name: string) {
  const versionId = `${listingId}-v1`;
  await SkillListing.updateOne({ _id: listingId }, { $set: { pendingVersionId: versionId, pendingVersion: 1 } });
  const denorm = { name, description: 'd' } as SkillListingDenorm;
  expect(await approvePendingListingVersion(listingId, versionId, 1, denorm)).toBe(true);
}
const pluginName = async (id: string) => (await SkillListing.findById(id).lean())?.claudePluginName;
const createListing = async (owner: Record<string, unknown>) =>
  String((await SkillListing.create({ ...base(), ...owner }))._id);

describe('SkillListing with a Space owner', () => {
  it('requires a spaceId for visibility space, and refuses one on any other visibility', async () => {
    await expect(SkillListing.create({ ...base(), visibility: 'space' })).rejects.toThrow(/space/i);
    await expect(
      SkillListing.create({ ...base(), visibility: 'organization', organizationId: 'org1', spaceId: 'sp1' })
    ).rejects.toThrow(/space/i);
    await expect(SkillListing.create({ ...base(), visibility: 'public', spaceId: 'sp1' })).rejects.toThrow(/space/i);
    await expect(SkillListing.create({ ...base(), visibility: 'space', spaceId: 'sp1' })).resolves.toBeTruthy();
  });

  it('keeps plugin names unique per Space: the same name in two Spaces and an org all coexist', async () => {
    const ids = [
      await createListing({ visibility: 'space', spaceId: 'sp1' }),
      await createListing({ visibility: 'space', spaceId: 'sp2' }),
      await createListing({ visibility: 'organization', organizationId: 'org1' }),
    ];
    for (const id of ids) await approve(id, 'Foo');
    expect(await Promise.all(ids.map(pluginName))).toEqual(['foo', 'foo', 'foo']);
  });

  it('suffixes a second same-named listing within one Space', async () => {
    const a = await createListing({ visibility: 'space', spaceId: 'sp1' });
    const b = await createListing({ visibility: 'space', spaceId: 'sp1' });
    await approve(a, 'Foo');
    await approve(b, 'Foo');
    expect(await pluginName(a)).toBe('foo');
    expect(await pluginName(b)).toBe(`foo-${b.slice(-6)}`);
  });

  it('declares the status/visibility/space index, partial on spaceId, and the owner-aware plugin-name key', async () => {
    const indexes = await SkillListing.collection.indexes();
    const space = indexes.find(i => i.name === 'skill_listing_status_visibility_space');
    expect(space?.key).toEqual({ status: 1, visibility: 1, spaceId: 1 });
    expect(space?.partialFilterExpression).toEqual({ spaceId: { $exists: true } });
    const plugin = indexes.find(i => i.name === 'skill_listing_claude_plugin_name');
    expect(plugin?.key).toEqual({ organizationId: 1, spaceId: 1, claudePluginName: 1 });
    expect(plugin?.unique).toBe(true);
  });
});

describe('SkillBundle with a Space owner', () => {
  const fields = { name: 'Pack', description: 'd', pluginName: 'pack', listingIds: ['l1'], createdByUserId: 'u1' };

  it('requires exactly one owner', async () => {
    await expect(SkillBundle.create({ ...fields })).rejects.toThrow(/owner|organization|space/i);
    await expect(SkillBundle.create({ ...fields, organizationId: 'org1', spaceId: 'sp1' })).rejects.toThrow(
      /owner|organization|space/i
    );
    await expect(SkillBundle.create({ ...fields, spaceId: 'sp1' })).resolves.toBeTruthy();
    await expect(SkillBundle.create({ ...fields, organizationId: 'org1' })).resolves.toBeTruthy();
  });

  it('keeps pluginName unique per owner only', async () => {
    await SkillBundle.create({ ...fields, spaceId: 'sp1' });
    await SkillBundle.create({ ...fields, spaceId: 'sp2' });
    await SkillBundle.create({ ...fields, organizationId: 'org1' });
    await expect(SkillBundle.create({ ...fields, spaceId: 'sp1' })).rejects.toMatchObject({ code: 11000 });
    await expect(SkillBundle.create({ ...fields, organizationId: 'org1' })).rejects.toMatchObject({ code: 11000 });
  });

  it('keeps the legacy index name with the owner-aware key', async () => {
    const index = (await SkillBundle.collection.indexes()).find(i => i.name === 'organizationId_1_pluginName_1');
    expect(index?.key).toEqual({ organizationId: 1, spaceId: 1, pluginName: 1 });
    expect(index?.unique).toBe(true);
  });
});
