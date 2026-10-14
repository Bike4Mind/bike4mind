import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  findOneLean: vi.fn(),
  findOneAndUpdate: vi.fn(),
  checkPublishQuota: vi.fn(),
  invalidatePublishCdn: vi.fn(),
  restrictDuplicatePublications: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    findOne: (filter: unknown) => {
      mocks.findOne(filter);
      return { sort: () => ({ lean: mocks.findOneLean }) };
    },
    findOneAndUpdate: mocks.findOneAndUpdate,
  },
}));
vi.mock('./checkPublishQuota', () => ({ checkPublishQuota: mocks.checkPublishQuota }));
vi.mock('./invalidatePublishCdn', async importOriginal => ({
  ...(await importOriginal<typeof import('./invalidatePublishCdn')>()),
  invalidatePublishCdn: mocks.invalidatePublishCdn,
}));
vi.mock('./restrictDuplicatePublications', () => ({
  restrictDuplicatePublications: mocks.restrictDuplicatePublications,
}));

import { settlePublication, type SettlePublicationInput } from './settlePublication';

const OWNER = 'owner1';
const logger = { info: vi.fn(), warn: vi.fn() };

const input = (over: Partial<SettlePublicationInput> = {}): SettlePublicationInput => ({
  ownerId: OWNER,
  isAdmin: false,
  source: { kind: 'reply', sessionId: 's1', messageId: 'm1' },
  tier: 'user',
  scopeId: OWNER,
  visibility: 'private',
  title: 'Title',
  renderedBody: 'hello',
  logger,
  ...over,
});

const existingRow = (over: Record<string, unknown> = {}) => ({
  _id: 'row1',
  publicId: 'live1',
  slug: 'r-live1',
  tier: 'user',
  scopeId: OWNER,
  visibility: 'private',
  ...over,
});

const writeCall = () =>
  mocks.findOneAndUpdate.mock.calls[0] as [
    Record<string, unknown>,
    { $set: Record<string, unknown>; $setOnInsert: Record<string, unknown> },
    { upsert: boolean; new: boolean },
  ];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOneLean.mockResolvedValue(null);
  mocks.checkPublishQuota.mockResolvedValue({ ok: true });
  mocks.findOneAndUpdate.mockImplementation(async (_f: unknown, update: { $set: Record<string, unknown> }) => ({
    ...update.$set,
    _id: 'row1',
    ownerId: OWNER,
  }));
  mocks.invalidatePublishCdn.mockResolvedValue(undefined);
  mocks.restrictDuplicatePublications.mockResolvedValue(0);
});

describe('settlePublication - lookup', () => {
  it('finds the existing record by owner and source, never across owners or scopes', async () => {
    await settlePublication(input());
    expect(mocks.findOne).toHaveBeenCalledWith({
      ownerId: OWNER,
      'source.kind': 'reply',
      'source.sessionId': 's1',
      'source.messageId': 'm1',
      deletedAt: null,
    });
  });

  it('keys a file on its fabFileId', async () => {
    await settlePublication(input({ source: { kind: 'fabfile', fabFileId: 'f1' } }));
    expect(mocks.findOne).toHaveBeenCalledWith({
      ownerId: OWNER,
      'source.kind': 'fabfile',
      'source.fabFileId': 'f1',
      deletedAt: null,
    });
  });
});

describe('settlePublication - first publish', () => {
  it('upserts a new record keyed by tier, scope and a fresh slug', async () => {
    const result = await settlePublication(input({ source: { kind: 'fabfile', fabFileId: 'f1' } }));
    expect(result.ok).toBe(true);
    const [filter, update, opts] = writeCall();
    const publicId = update.$set.publicId as string;
    expect(publicId).toMatch(/^[0-9a-f]{12}$/);
    expect(filter).toEqual({ tier: 'user', scopeId: OWNER, slug: `f-${publicId}`, deletedAt: null });
    expect(update.$setOnInsert).toEqual({ ownerId: OWNER });
    expect(opts).toEqual({ upsert: true, new: true });
    expect(mocks.checkPublishQuota).toHaveBeenCalledWith(expect.objectContaining({ replacing: null }));
  });

  it('writes the snapshot plus any source-specific fields', async () => {
    await settlePublication(input({ extraSet: { citables: [{ id: 'c1' }] } }));
    expect(writeCall()[1].$set).toMatchObject({
      title: 'Title',
      renderedBody: 'hello',
      size: { totalBytes: 5, fileCount: 0 },
      source: { kind: 'reply', sessionId: 's1', messageId: 'm1' },
      citables: [{ id: 'c1' }],
      lastPublishedBy: OWNER,
    });
  });

  it('narrows legacy duplicates of a first publish to the record it just created', async () => {
    await settlePublication(input());
    const publicId = writeCall()[1].$set.publicId as string;
    expect(mocks.restrictDuplicatePublications).toHaveBeenCalledWith(
      expect.objectContaining({ publicId, visibility: 'private' }),
      logger
    );
  });
});

describe('settlePublication - extra fields', () => {
  it('never lets extra source fields override the tier, scope or visibility being written', async () => {
    const extraSet = { tier: 'organization', visibility: 'public', scopeId: 'other' } as unknown as NonNullable<
      SettlePublicationInput['extraSet']
    >;
    await settlePublication(input({ extraSet }));
    expect(writeCall()[1].$set).toMatchObject({ tier: 'user', scopeId: OWNER, visibility: 'private' });
  });
});

describe('settlePublication - re-publish rewrites the existing record in place', () => {
  it('a re-publish into a new scope rewrites the existing record in place', async () => {
    mocks.findOneLean.mockResolvedValue(existingRow({ tier: 'organization', scopeId: 'org1' }));
    const result = await settlePublication(input());
    expect(result).toMatchObject({ ok: true, slug: 'r-live1' });
    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, opts] = writeCall();
    expect(filter).toEqual({ _id: 'row1', ownerId: OWNER, deletedAt: null });
    expect(update.$set).toMatchObject({ publicId: 'live1', tier: 'user', scopeId: OWNER, visibility: 'private' });
    expect(opts.upsert).toBe(false);
  });

  it("quota replaces the row's OLD tier and scope, not the requested ones", async () => {
    mocks.findOneLean.mockResolvedValue(existingRow({ tier: 'organization', scopeId: 'org1' }));
    await settlePublication(input());
    expect(mocks.checkPublishQuota).toHaveBeenCalledWith(
      expect.objectContaining({ replacing: { tier: 'organization', scopeId: 'org1', slug: 'r-live1' } })
    );
  });

  it('answers 409 and changes nothing else when the record is removed between lookup and write', async () => {
    mocks.findOneLean.mockResolvedValue(existingRow({ visibility: 'public' }));
    mocks.findOneAndUpdate.mockResolvedValue(null);
    const result = await settlePublication(input());
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mocks.invalidatePublishCdn).not.toHaveBeenCalled();
    expect(mocks.restrictDuplicatePublications).not.toHaveBeenCalled();
  });

  it('narrows older duplicates to the saved record', async () => {
    mocks.findOneLean.mockResolvedValue(existingRow());
    await settlePublication(input());
    expect(mocks.restrictDuplicatePublications).toHaveBeenCalledWith(
      expect.objectContaining({ publicId: 'live1', visibility: 'private' }),
      logger
    );
  });
});

describe('settlePublication - quota', () => {
  it('returns the quota rejection and writes nothing', async () => {
    mocks.checkPublishQuota.mockResolvedValue({
      ok: false,
      status: 413,
      error: 'over',
      code: 'quota_exceeded',
      details: { x: 1 },
    });
    const result = await settlePublication(input());
    expect(result).toEqual({
      ok: false,
      status: 413,
      body: { error: 'over', code: 'quota_exceeded', details: { x: 1 } },
    });
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('counts a Team publish against the org scope', async () => {
    await settlePublication(input({ tier: 'organization', scopeId: 'org1', visibility: 'organization' }));
    expect(mocks.checkPublishQuota).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: OWNER, orgScopeId: 'org1', incoming: { bytes: 5, fileCount: 0 } })
    );
  });
});

describe('settlePublication - CDN purge', () => {
  const purgedPublicIds = () =>
    mocks.invalidatePublishCdn.mock.calls.map(([t]) => (t as { publicId: string }).publicId);

  it('does not purge a brand-new public page, which has nothing cached', async () => {
    await settlePublication(input({ visibility: 'public' }));
    expect(mocks.invalidatePublishCdn).not.toHaveBeenCalled();
  });

  it('purges when an existing private page is re-published public', async () => {
    mocks.findOneLean.mockResolvedValue(existingRow({ visibility: 'private' }));
    await settlePublication(input({ visibility: 'public' }));
    expect(purgedPublicIds()).toEqual(['live1']);
  });

  it('purges when an existing public page is re-published private', async () => {
    mocks.findOneLean.mockResolvedValue(existingRow({ visibility: 'public' }));
    await settlePublication(input({ visibility: 'private' }));
    expect(purgedPublicIds()).toEqual(['live1']);
  });

  it('does not purge when the page was and stays non-public', async () => {
    mocks.findOneLean.mockResolvedValue(existingRow({ visibility: 'organization' }));
    await settlePublication(input({ visibility: 'private' }));
    expect(mocks.invalidatePublishCdn).not.toHaveBeenCalled();
  });
});
