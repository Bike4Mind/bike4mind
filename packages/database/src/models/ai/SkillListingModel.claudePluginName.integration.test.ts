import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import {
  SkillListing,
  approvePendingListingVersion,
  assignClaudePluginName,
  type SkillListingDenorm,
} from './SkillListingModel';
import { SkillBundle } from './SkillBundleModel';

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
  await SkillBundle.collection.deleteMany({});
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

  it('assigns distinct stable names to concurrent approvals', async () => {
    const first = await listing('Foo');
    const second = await listing('Foo');
    await Promise.all([approve(first, 'Foo', 1), approve(second, 'Foo', 1)]);
    const names = await Promise.all([pluginName(first), pluginName(second)]);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain('foo');
    expect(names.every(name => typeof name === 'string')).toBe(true);
  });

  it('never reuses a soft-deleted listing name', async () => {
    const removed = await listing('Foo');
    await approve(removed, 'Foo', 1);
    await SkillListing.deleteOne({ _id: removed });
    const next = await listing('Foo');
    await approve(next, 'Foo', 1);
    expect(await pluginName(next)).toBe(`foo-${next.slice(-6)}`);
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

  it('keeps naming when both the slug and the id-suffixed fallback are taken', async () => {
    const id = await listing('Foo');
    await SkillListing.create({
      sourceSkillId: 's-a',
      authorUserId: 'a',
      visibility: 'organization',
      organizationId: 'org1',
      name: 'x',
      description: 'd',
      claudePluginName: 'foo',
    });
    await SkillListing.create({
      sourceSkillId: 's-b',
      authorUserId: 'a',
      visibility: 'organization',
      organizationId: 'org1',
      name: 'x',
      description: 'd',
      claudePluginName: `foo-${id.slice(-6)}`,
    });
    await assignClaudePluginName(id, 'Foo');
    expect(await pluginName(id)).toBe(`foo-${id}-2`);
    await assignClaudePluginName(id, 'Renamed');
    expect(await pluginName(id)).toBe(`foo-${id}-2`);
  });

  it('still approves when naming fails, and logs it', async () => {
    const id = await listing('Foo');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const updateOne = SkillListing.updateOne.bind(SkillListing);
    const spy = vi
      .spyOn(SkillListing, 'updateOne')
      .mockImplementationOnce(updateOne as never)
      .mockImplementationOnce(updateOne as never)
      .mockRejectedValueOnce(new Error('boom'));
    await approve(id, 'Foo', 1);
    spy.mockRestore();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
    expect((await SkillListing.findById(id).lean())?.status).toBe('approved');
    expect(await pluginName(id)).toBeUndefined();
  });

  it('does not name a listing whose approve CAS loses', async () => {
    const id = await listing('Foo');
    await SkillListing.updateOne({ _id: id }, { $set: { pendingVersionId: 'current', pendingVersion: 1 } });
    expect(
      await approvePendingListingVersion(id, 'stale', 1, { name: 'Foo', description: 'd' } as SkillListingDenorm)
    ).toBe(false);
    expect(await pluginName(id)).toBeUndefined();
  });

  it('skips a name a bundle in the same org holds', async () => {
    const bundle = { name: 'b', description: 'd', pluginName: 'pr-reviewer', createdByUserId: 'admin' };
    await SkillBundle.create({ ...bundle, organizationId: 'org1' });
    await SkillBundle.create({ ...bundle, organizationId: 'org2', pluginName: 'linter' });
    const id = await listing('PR Reviewer');
    await approve(id, 'PR Reviewer', 1);
    expect(await pluginName(id)).toBe(`pr-reviewer-${id.slice(-6)}`);

    const other = await listing('Linter');
    await approve(other, 'Linter', 1);
    expect(await pluginName(other)).toBe('linter');
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
