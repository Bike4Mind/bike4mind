import { describe, it, expect, vi, beforeEach } from 'vitest';

// vitest.setup.ts passes this module through for every other suite.
vi.unmock('@server/files/pendingUploads');

const mocks = vi.hoisted(() => ({
  aggregate: vi.fn(),
  getSettingsMap: vi.fn(),
  resolveUserRateTier: vi.fn(),
  isDevelopment: vi.fn(() => false),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  FabFile: { aggregate: (pipeline: unknown) => ({ exec: () => mocks.aggregate(pipeline) }) },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: mocks.getSettingsMap,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ isDevelopment: mocks.isDevelopment }));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateTier: mocks.resolveUserRateTier }));

import { PENDING_UPLOAD_LIMIT, TooManyRequestsError } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { admitPendingUploads, PENDING_UPLOAD_LIMITED, PENDING_UPLOAD_WINDOW_MS } from './pendingUploads';

const req = { user: { id: 'u1', isAdmin: false, tags: [] } } as unknown as Parameters<typeof admitPendingUploads>[0];

const group = (organizationId: string | null, mine: boolean, count: number, bytes: number, ageMs = 60_000) => ({
  _id: { organizationId, mine, pending: true },
  count,
  bytes,
  oldest: new Date(Date.now() - ageMs),
});

const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(TooManyRequestsError);
  return error as TooManyRequestsError;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isDevelopment.mockReturnValue(false);
  mocks.resolveUserRateTier.mockResolvedValue('free');
  mocks.getSettingsMap.mockResolvedValue({ pendingUploadLimit: '10' });
  mocks.aggregate.mockResolvedValue([]);
});

describe('admitPendingUploads - cap', () => {
  it('admits a request that fits under the cap', async () => {
    mocks.aggregate.mockResolvedValue([group(null, true, 4, 100)]);

    await expect(admitPendingUploads(req, 6, [undefined])).resolves.toMatchObject({ count: 4 });
  });

  it('judges concurrent requests against their snapshots without reserving the count', async () => {
    mocks.getSettingsMap.mockResolvedValue({ pendingUploadLimit: '1' });

    const snapshots = await Promise.all([admitPendingUploads(req, 1, []), admitPendingUploads(req, 1, [])]);

    expect(snapshots.map(snapshot => snapshot.count)).toEqual([0, 0]);
    expect(mocks.aggregate).toHaveBeenCalledTimes(2);
  });

  it('uses only pending rows for the cap and Retry-After', async () => {
    const complete = group(null, true, 100, 500, 29 * 60_000);
    complete._id.pending = false;
    mocks.aggregate.mockResolvedValue([group(null, true, 10, 100, 5 * 60_000), complete]);

    const error = await refusal(admitPendingUploads(req, 1, []));

    expect(error.additionalInfo?.details).toMatchObject({ pending: 10 });
    expect(error.additionalInfo?.retryAfter).toBeGreaterThan(24 * 60);
    expect(error.additionalInfo?.retryAfter).toBeLessThanOrEqual(25 * 60);
  });

  it('refuses with a 429 carrying Retry-After until the oldest counted upload ages out', async () => {
    mocks.aggregate.mockResolvedValue([
      group(null, true, 6, 100, 5 * 60_000),
      group('org-1', true, 3, 100, 20 * 60_000),
      // Another uploader's org rows never count toward the caller's cap.
      group('org-1', false, 50, 100, 29 * 60_000),
    ]);

    const error = await refusal(admitPendingUploads(req, 2, ['org-1']));

    expect(error.message).toBe('You have 9 uploads in progress (limit 10). Wait for them to finish, then try again.');
    expect(error.additionalInfo).toMatchObject({
      code: PENDING_UPLOAD_LIMITED,
      details: { limit: 10, pending: 9, requested: 2 },
    });
    // The oldest of the caller's rows is 20 minutes old, so it ages out in about 10.
    expect(error.additionalInfo?.retryAfter).toBeGreaterThan(9 * 60);
    expect(error.additionalInfo?.retryAfter).toBeLessThanOrEqual(10 * 60);
  });

  it('never advertises a Retry-After below 1 second', async () => {
    mocks.aggregate.mockResolvedValue([group(null, true, 10, 0, PENDING_UPLOAD_WINDOW_MS + 5_000)]);

    const error = await refusal(admitPendingUploads(req, 1, []));

    expect(error.additionalInfo?.retryAfter).toBe(1);
  });

  it('tells a caller whose request exceeds the whole limit to send fewer files, not to wait', async () => {
    const error = await refusal(admitPendingUploads(req, 11, []));

    expect(error.message).toContain('Upload fewer files at a time');
    expect(error.additionalInfo?.retryAfter).toBeUndefined();
    expect(error.additionalInfo?.details).toEqual({ limit: 10, pending: 0, requested: 11 });
  });

  it('blocks every presigned upload when the limit is set to 0', async () => {
    mocks.getSettingsMap.mockResolvedValue({ pendingUploadLimit: '0' });

    const error = await refusal(admitPendingUploads(req, 1, []));

    expect(error.message).toBe('File uploads are currently blocked for your account.');
    expect(error.additionalInfo?.retryAfter).toBeUndefined();
  });

  it('falls back to the schema default when the setting is unset', async () => {
    mocks.getSettingsMap.mockResolvedValue({});
    mocks.aggregate.mockResolvedValue([group(null, true, PENDING_UPLOAD_LIMIT, 0)]);

    const error = await refusal(admitPendingUploads(req, 1, []));

    expect(error.additionalInfo?.details).toMatchObject({ limit: PENDING_UPLOAD_LIMIT });
    expect(PENDING_UPLOAD_LIMIT).toBe(250);
  });

  it.each([
    ['the tier', () => mocks.resolveUserRateTier.mockRejectedValue(new Error('subscriptions unavailable'))],
    ['the setting', () => mocks.getSettingsMap.mockRejectedValue(new Error('settings unavailable'))],
  ])('applies the default, and warns, when %s cannot be read', async (_what, fail) => {
    const warn = vi.spyOn(Logger.globalInstance, 'warn').mockImplementation(() => undefined);
    fail();
    mocks.aggregate.mockResolvedValue([group(null, true, PENDING_UPLOAD_LIMIT, 0)]);

    const error = await refusal(admitPendingUploads(req, 1, []));

    expect(error.additionalInfo?.details).toMatchObject({ limit: PENDING_UPLOAD_LIMIT });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('limit resolution failed'), expect.anything());
  });

  it('does not cap admins, developer-tagged users or the dev server', async () => {
    mocks.aggregate.mockResolvedValue([group(null, true, 10_000, 0)]);
    mocks.resolveUserRateTier.mockResolvedValue('bypass');
    await expect(admitPendingUploads(req, 100, [])).resolves.toMatchObject({ count: 10_000 });

    mocks.resolveUserRateTier.mockResolvedValue('free');
    mocks.isDevelopment.mockReturnValue(true);
    await expect(admitPendingUploads(req, 100, [])).resolves.toMatchObject({ count: 10_000 });
  });

  it('propagates a failed reservation read instead of admitting against an empty pool', async () => {
    mocks.aggregate.mockRejectedValueOnce(new Error('pending uploads unavailable'));
    await expect(admitPendingUploads(req, 1, [])).rejects.toThrow('pending uploads unavailable');
  });

  it('refuses a request with no signed-in user without reading anything', async () => {
    await expect(admitPendingUploads({} as typeof req, 1, [])).rejects.toThrow('Sign in to upload files');
    expect(mocks.aggregate).not.toHaveBeenCalled();
  });
});

describe('admitPendingUploads - reserved bytes', () => {
  it('keeps completed but uncharged bytes reserved without counting them toward the cap', async () => {
    const complete = group(null, true, 100, 500);
    complete._id.pending = false;
    mocks.aggregate.mockResolvedValue([group(null, true, 1, 100), complete]);

    const pending = await admitPendingUploads(req, 1, []);

    expect(pending.count).toBe(1);
    expect(pending.bytesFor(undefined)).toBe(600);
  });

  it("splits bytes into the caller's personal pool and each org pool, whoever uploaded into the org", async () => {
    mocks.aggregate.mockResolvedValue([
      group(null, true, 1, 100),
      group('org-1', true, 1, 1_000),
      group('org-1', false, 2, 10_000),
      group('org-2', false, 1, 7),
    ]);

    const pending = await admitPendingUploads(req, 1, [undefined, 'org-1', 'org-2']);

    expect(pending.bytesFor(undefined)).toBe(100);
    expect(pending.bytesFor('org-1')).toBe(11_000);
    expect(pending.bytesFor('org-2')).toBe(7);
    expect(pending.bytesFor('org-unknown')).toBe(0);
  });

  it('never counts another uploader as personal bytes', async () => {
    // Defensive: the query only returns the caller's personal rows, but the grouping keys on `mine`.
    mocks.aggregate.mockResolvedValue([group(null, false, 1, 500)]);

    const pending = await admitPendingUploads(req, 1, []);

    expect(pending).toMatchObject({ count: 0 });
    expect(pending.bytesFor(undefined)).toBe(0);
  });

  it("matches only the caller's rows when no org pool is named", async () => {
    await admitPendingUploads(req, 1, [undefined, undefined]);

    const [[pipeline]] = mocks.aggregate.mock.calls as [[Array<{ $match?: { $or: unknown[] } }>]];
    expect(pipeline[0].$match?.$or).toHaveLength(1);
    expect(pipeline[0].$match?.$or[0]).toMatchObject({
      userId: 'u1',
      clientUpload: true,
      deletedAt: null,
    });
  });

  it('adds one deduplicated org-pool branch that restates the partial index filter', async () => {
    await admitPendingUploads(req, 1, ['org-1', undefined, 'org-1', 'org-2']);

    const [[pipeline]] = mocks.aggregate.mock.calls as [[Array<{ $match?: { $or: Array<Record<string, unknown>> } }>]];
    const orgBranch = pipeline[0].$match!.$or[1];
    expect(orgBranch).toMatchObject({
      organizationId: { $in: ['org-1', 'org-2'], $type: 'string' },
      clientUpload: true,
      deletedAt: null,
    });
    const since = (orgBranch.createdAt as { $gte: Date }).$gte.getTime();
    expect(Date.now() - since).toBeGreaterThanOrEqual(PENDING_UPLOAD_WINDOW_MS);
    expect(Date.now() - since).toBeLessThan(PENDING_UPLOAD_WINDOW_MS + 5_000);
  });
});
