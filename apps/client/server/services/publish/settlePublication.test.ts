import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  findOneLean: vi.fn(),
  findOneAndUpdate: vi.fn(),
  checkPublishQuota: vi.fn(),
  invalidatePublishCdn: vi.fn(),
  restrictDuplicatePublications: vi.fn(),
  consumePublishAction: vi.fn(),
  refund: vi.fn(),
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
vi.mock('./publishRateLimit', () => ({ consumePublishAction: mocks.consumePublishAction }));

import { TooManyRequestsError } from '@bike4mind/common';
import { settlePublication, type SettlePublicationInput } from './settlePublication';

const OWNER = 'owner1';
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const logger = { info: vi.fn(), warn: vi.fn() };

const input = (over: Partial<SettlePublicationInput> = {}): SettlePublicationInput => ({
  ownerId: OWNER,
  isAdmin: false,
  ownerCreatedAt: CREATED_AT,
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
  mocks.refund.mockResolvedValue(undefined);
  mocks.consumePublishAction.mockResolvedValue({ refund: mocks.refund });
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

  it('clears discoverable when a re-publish leaves public, and leaves it alone on a public re-publish', async () => {
    mocks.findOneLean.mockResolvedValue(existingRow({ visibility: 'public' }));
    await settlePublication(input({ visibility: 'private' }));
    expect(writeCall()[1].$set).toMatchObject({ visibility: 'private', discoverable: false });

    mocks.findOneAndUpdate.mockClear();
    await settlePublication(input({ visibility: 'public' }));
    expect(writeCall()[1].$set).not.toHaveProperty('discoverable');
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
    const details = { scope: 'user', limit: 100, current: 99, attempted: 104 };
    mocks.checkPublishQuota.mockResolvedValue({
      ok: false,
      status: 413,
      error: 'over',
      code: 'quota_bytes_exceeded',
      details,
    });
    const result = await settlePublication(input());
    expect(result).toEqual({
      ok: false,
      status: 413,
      body: { error: 'over', code: 'quota_bytes_exceeded', details },
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

describe('settlePublication - daily publish allowance', () => {
  it("counts one action against the owner's allowance, with the account age that picks its tier", async () => {
    await settlePublication(input());
    expect(mocks.consumePublishAction).toHaveBeenCalledTimes(1);
    expect(mocks.consumePublishAction).toHaveBeenCalledWith({ id: OWNER, isAdmin: false, createdAt: CREATED_AT });
  });

  it('counts a re-publish too, since it rewrites the live page', async () => {
    mocks.findOneLean.mockResolvedValue(existingRow());
    await settlePublication(input());
    expect(mocks.consumePublishAction).toHaveBeenCalledTimes(1);
  });

  it('does not count a publish the storage quota refused', async () => {
    mocks.checkPublishQuota.mockResolvedValue({
      ok: false,
      status: 413,
      error: 'over',
      code: 'quota_bytes_exceeded',
      details: { scope: 'user', limit: 1, current: 1, attempted: 2 },
    });
    await settlePublication(input());
    expect(mocks.consumePublishAction).not.toHaveBeenCalled();
  });

  it('writes nothing when the allowance is used up, and lets the 429 reach the error handler', async () => {
    const limited = new TooManyRequestsError('limited', { code: 'publish_rate_limited', retryAfter: 60 });
    mocks.consumePublishAction.mockRejectedValue(limited);

    await expect(settlePublication(input())).rejects.toBe(limited);
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.invalidatePublishCdn).not.toHaveBeenCalled();
  });

  it('keeps the action once the page is written', async () => {
    const result = await settlePublication(input());
    expect(result.ok).toBe(true);
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it('hands the action back when the page was removed while it was being updated', async () => {
    mocks.findOneLean.mockResolvedValue(existingRow());
    mocks.findOneAndUpdate.mockResolvedValue(null);

    const result = await settlePublication(input());

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mocks.refund).toHaveBeenCalledTimes(1);
  });

  it('hands the action back when the write fails, and still surfaces the failure', async () => {
    const writeFailed = new Error('write failed');
    mocks.findOneAndUpdate.mockRejectedValue(writeFailed);

    await expect(settlePublication(input())).rejects.toBe(writeFailed);
    expect(mocks.refund).toHaveBeenCalledTimes(1);
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

  it('purges when an existing public page is re-published public, so a new title or body shows at once', async () => {
    mocks.findOneLean.mockResolvedValue(existingRow({ visibility: 'public' }));
    await settlePublication(input({ visibility: 'public' }));
    expect(purgedPublicIds()).toEqual(['live1']);
  });

  it('does not purge when the page was and stays non-public', async () => {
    mocks.findOneLean.mockResolvedValue(existingRow({ visibility: 'organization' }));
    await settlePublication(input({ visibility: 'private' }));
    expect(mocks.invalidatePublishCdn).not.toHaveBeenCalled();
  });
});
