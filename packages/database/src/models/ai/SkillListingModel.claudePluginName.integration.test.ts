import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import {
  SkillListing,
  approvePendingListingVersion,
  assignClaudePluginName,
  type SkillListingDenorm,
} from './SkillListingModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await SkillListing.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

beforeEach(async () => {
  await SkillListing.collection.deleteMany({});
});

let seq = 0;
async function listing(name: string, opts: { visibility?: string; organizationId?: string } = {}) {
  const doc = await SkillListing.create({
    sourceSkillId: `skill-${++seq}`,
    authorUserId: 'author',
    visibility: opts.visibility ?? 'organization',
    organizationId: opts.organizationId ?? 'org1',
    name,
    description: 'd',
  });
  return String(doc._id);
}

async function approve(listingId: string, name: string, version: number) {
  const versionId = `${listingId}-v${version}`;
  await SkillListing.updateOne({ _id: listingId }, { $set: { pendingVersionId: versionId, pendingVersion: version } });
  const denorm = { name, description: 'd' } as SkillListingDenorm;
  expect(await approvePendingListingVersion(listingId, versionId, version, denorm)).toBe(true);
}

const pluginName = async (id: string) => (await SkillListing.findById(id).lean())?.claudePluginName;

describe('claudePluginName', () => {
  it('keeps the first-approval name when a later version renames the skill', async () => {
    const id = await listing('PR Reviewer');
    await approve(id, 'PR Reviewer', 1);
    expect(await pluginName(id)).toBe('pr-reviewer');

    await approve(id, 'Code Critic', 2);
    expect(await pluginName(id)).toBe('pr-reviewer');
  });

  it('suffixes a colliding slug, and delisting or adding same-named listings renames nobody', async () => {
    const a = await listing('Foo');
    const b = await listing('Foo');
    await approve(a, 'Foo', 1);
    await approve(b, 'Foo', 1);
    expect(await pluginName(a)).toBe('foo');
    expect(await pluginName(b)).toBe(`foo-${b.slice(-6)}`);

    await SkillListing.updateOne({ _id: a }, { $set: { status: 'delisted' } });
    const c = await listing('Foo');
    await approve(c, 'Foo', 1);
    expect(await pluginName(a)).toBe('foo');
    expect(await pluginName(b)).toBe(`foo-${b.slice(-6)}`);
    expect(await pluginName(c)).toBe(`foo-${c.slice(-6)}`);
  });

  it('is a no-op when the listing already has a name', async () => {
    const id = await listing('Foo');
    await assignClaudePluginName(id, 'Foo');
    await assignClaudePluginName(id, 'Bar');
    expect(await pluginName(id)).toBe('foo');
  });

  it('never names public or unlisted listings', async () => {
    const pub = await listing('Foo', { visibility: 'public' });
    const unlisted = await listing('Foo', { visibility: 'unlisted' });
    await approve(pub, 'Foo', 1);
    await approve(unlisted, 'Foo', 1);
    expect(await pluginName(pub)).toBeUndefined();
    expect(await pluginName(unlisted)).toBeUndefined();
  });

  it('scopes collisions to the org', async () => {
    const a = await listing('Foo', { organizationId: 'org1' });
    const b = await listing('Foo', { organizationId: 'org2' });
    await approve(a, 'Foo', 1);
    await approve(b, 'Foo', 1);
    expect(await pluginName(a)).toBe('foo');
    expect(await pluginName(b)).toBe('foo');
  });
});
