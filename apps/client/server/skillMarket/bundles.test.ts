import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  bundleFind: vi.fn(),
  bundleFindById: vi.fn(),
  bundleCreate: vi.fn(),
  bundleUpdate: vi.fn(),
  bundleDelete: vi.fn(),
  listingFind: vi.fn(),
  listingCount: vi.fn(),
  listingExists: vi.fn(),
  adminOrgs: vi.fn(),
  memberOrgs: vi.fn(),
  orgFindById: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  SKILL_BUNDLE_MAX_LISTINGS: 50,
  SkillBundle: {
    find: h.bundleFind,
    findById: h.bundleFindById,
    create: h.bundleCreate,
    findByIdAndUpdate: h.bundleUpdate,
    deleteOne: h.bundleDelete,
  },
  SkillListing: { find: h.listingFind, countDocuments: h.listingCount, exists: h.listingExists },
  adminSettingsRepository: {},
  inboxRepository: {},
}));
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: {
    findIdsAdministeredBy: h.adminOrgs,
    findMembershipOrgIds: h.memberOrgs,
    findById: h.orgFindById,
  },
}));

import { createBundle, deleteBundle, listBundles, updateBundle } from './bundles';

const ORG = '65a0000000000000000000aa';
const OTHER_ORG = '65a0000000000000000000bb';
const L1 = '65b000000000000000000001';
const L2 = '65b000000000000000000002';
const BUNDLE = '65c000000000000000000001';
const admin = { id: 'admin' };
const member = { id: 'member' };
const doc = <T extends object>(json: T) => ({ toJSON: () => json });
const body = {
  organizationId: ORG,
  name: 'Team Starter Pack',
  description: 'Day one skills',
  listingIds: [L1, L2, L1],
};
const stored = {
  id: BUNDLE,
  organizationId: ORG,
  name: 'Team Starter Pack',
  pluginName: 'team-starter-pack',
  listingIds: [] as string[],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.adminOrgs.mockImplementation(async (userId: string) => (userId === 'admin' ? [ORG] : []));
  h.memberOrgs.mockImplementation(async (userId: string) => (userId === 'member' ? [ORG] : []));
  h.listingCount.mockImplementation(async ({ _id }: { _id: { $in: string[] } }) => _id.$in.length);
  h.listingExists.mockResolvedValue(null);
  h.orgFindById.mockImplementation(async (id: string) => (id === ORG ? { id } : null));
  h.bundleCreate.mockImplementation(async (fields: object) => doc({ id: BUNDLE, ...fields }));
  h.bundleFindById.mockImplementation(async (id: string) => (id === BUNDLE ? doc(stored) : null));
  h.bundleUpdate.mockImplementation(async (_id: string, { $set }: { $set: object }) => doc({ ...stored, ...$set }));
});

describe('createBundle', () => {
  it('creates a deduped bundle named by its slug', async () => {
    const bundle = await createBundle(admin, body);
    expect(bundle).toMatchObject({ pluginName: 'team-starter-pack', listingIds: [L1, L2], createdByUserId: 'admin' });
    // Only the org's approved, named Organization listings count as members.
    expect(h.listingCount).toHaveBeenCalledWith(
      expect.objectContaining({
        visibility: 'organization',
        organizationId: ORG,
        status: 'approved',
        claudePluginName: { $type: 'string' },
      })
    );
  });

  it('lets a super-admin manage any org, and refuses a non-admin member', async () => {
    await expect(createBundle({ id: 'root', isAdmin: true }, body)).resolves.toBeTruthy();
    for (const organizationId of [OTHER_ORG, 'nope']) {
      await expect(createBundle({ id: 'root', isAdmin: true }, { ...body, organizationId })).rejects.toMatchObject({
        statusCode: 404,
      });
    }
    await expect(createBundle(member, body)).rejects.toMatchObject({ statusCode: 403 });
    await expect(createBundle(admin, { ...body, organizationId: OTHER_ORG })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("400s a listing that isn't an approved Organization listing of the org, and a malformed id", async () => {
    h.listingCount.mockResolvedValueOnce(1);
    await expect(createBundle(admin, body)).rejects.toMatchObject({ statusCode: 400 });
    await expect(createBundle(admin, { ...body, listingIds: ['nope'] })).rejects.toMatchObject({ statusCode: 400 });
    expect(h.bundleCreate).not.toHaveBeenCalled();
  });

  it('409s a name a listing or another bundle in the org already holds', async () => {
    h.listingExists.mockResolvedValueOnce({ _id: L1 });
    await expect(createBundle(admin, body)).rejects.toMatchObject({ statusCode: 409 });
    expect(h.listingExists).toHaveBeenCalledWith({ organizationId: ORG, claudePluginName: 'team-starter-pack' });

    h.bundleCreate.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));
    await expect(createBundle(admin, body)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('400s a name without letters or digits and an over-long member list', async () => {
    await expect(createBundle(admin, { ...body, name: '!!!' })).rejects.toMatchObject({ statusCode: 400 });
    const many = Array.from({ length: 51 }, (_, i) => `65b0000000000000000000${String(i).padStart(2, '0')}`);
    await expect(createBundle(admin, { ...body, listingIds: many })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createBundle(admin, { ...body, listingIds: [] })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('updateBundle / deleteBundle', () => {
  it('edits members but never the plugin name', async () => {
    const bundle = await updateBundle(admin, BUNDLE, { name: 'Renamed', listingIds: [L2], pluginName: 'hijack' });
    expect(h.bundleUpdate).toHaveBeenCalledWith(BUNDLE, { $set: { name: 'Renamed', listingIds: [L2] } }, { new: true });
    expect(bundle.pluginName).toBe('team-starter-pack');
  });

  it("400s a member that isn't an approved Organization listing of the bundle's org", async () => {
    h.listingCount.mockResolvedValueOnce(1);
    await expect(updateBundle(admin, BUNDLE, { listingIds: [L1, L2] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(updateBundle(admin, BUNDLE, { listingIds: ['nope'] })).rejects.toMatchObject({ statusCode: 400 });
    expect(h.listingCount).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG }));
    expect(h.bundleUpdate).not.toHaveBeenCalled();
  });

  it('keeps an existing unapproved member but rejects a new unapproved member', async () => {
    h.bundleFindById.mockResolvedValue(doc({ ...stored, listingIds: [L1] }));
    h.listingCount.mockResolvedValue(0);

    const bundle = await updateBundle(admin, BUNDLE, { name: 'Renamed', listingIds: [L1, L1] });
    expect(bundle).toMatchObject({ name: 'Renamed', listingIds: [L1] });
    expect(h.listingCount).toHaveBeenCalledWith(expect.objectContaining({ _id: { $in: [] } }));

    h.bundleUpdate.mockClear();
    await expect(updateBundle(admin, BUNDLE, { listingIds: [L1, L2] })).rejects.toMatchObject({ statusCode: 400 });
    expect(h.listingCount).toHaveBeenLastCalledWith(expect.objectContaining({ _id: { $in: [L2] } }));
    expect(h.bundleUpdate).not.toHaveBeenCalled();
  });

  it('refuses an admin of another org', async () => {
    h.adminOrgs.mockResolvedValue([OTHER_ORG]);
    await expect(updateBundle(admin, BUNDLE, { name: 'x' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(deleteBundle(admin, BUNDLE)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.bundleUpdate).not.toHaveBeenCalled();
    expect(h.bundleDelete).not.toHaveBeenCalled();
  });

  it('404s an unknown or malformed bundle id, and a bundle deleted during the edit', async () => {
    await expect(updateBundle(admin, '65c0000000000000000000ff', { name: 'x' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(updateBundle(admin, 'nope', { name: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    h.bundleUpdate.mockResolvedValueOnce(null);
    await expect(updateBundle(admin, BUNDLE, { name: 'x' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses non-admins and 404s an unknown bundle', async () => {
    await expect(updateBundle(member, BUNDLE, { name: 'x' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(deleteBundle(member, BUNDLE)).rejects.toMatchObject({ statusCode: 403 });
    await expect(deleteBundle(admin, '65c0000000000000000000ff')).rejects.toMatchObject({ statusCode: 404 });
    expect(h.bundleDelete).not.toHaveBeenCalled();
    await deleteBundle(admin, BUNDLE);
    expect(h.bundleDelete).toHaveBeenCalledWith({ _id: BUNDLE });
  });
});

describe('listBundles', () => {
  beforeEach(() => {
    h.bundleFind.mockReturnValue({ sort: async () => [doc(stored)] });
    h.listingFind.mockReturnValue({
      sort: async () => [doc({ id: L1, name: 'review-pr', claudePluginName: 'review-pr' })],
    });
  });

  it('shows members the bundles and candidates, editable only by admins', async () => {
    expect(await listBundles(member, ORG)).toEqual({
      bundles: [stored],
      listings: [{ id: L1, name: 'review-pr', pluginName: 'review-pr' }],
      canEdit: false,
    });
    expect((await listBundles(admin, ORG)).canEdit).toBe(true);
  });

  it('404s an org the caller is not in', async () => {
    await expect(listBundles(member, OTHER_ORG)).rejects.toMatchObject({ statusCode: 404 });
  });
});
