import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB layer - the quota service's only dependency is
// PublishedArtifact.aggregate. We drive it per-test to exercise the decision logic.
const aggregateMock = vi.fn();
vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    aggregate: (...args: unknown[]) => aggregateMock(...args),
  },
}));

import { checkPublishQuota } from './checkPublishQuota';
import { PUBLISH_QUOTAS } from '@bike4mind/common';

/** Aggregate returns a single grouped row (or [] when no docs match). */
function usage(totalBytes: number) {
  return [{ _id: null, totalBytes }];
}

/**
 * A row that also reports a page count far past the old caps, so a count check reintroduced on
 * the same aggregation would see it and fail these tests. checkPublishQuota.e2e.test.ts covers
 * the same ground against a real database.
 */
function usageWithPages(totalBytes: number, count: number) {
  return [{ _id: null, totalBytes, count }];
}

describe('checkPublishQuota', () => {
  beforeEach(() => {
    aggregateMock.mockReset();
  });

  it('allows a publish that fits under both ladders', async () => {
    aggregateMock.mockResolvedValue(usage(10 * 1024 * 1024));
    const result = await checkPublishQuota({
      ownerId: 'u1',
      incoming: { bytes: 1024, fileCount: 1 },
    });
    expect(result.ok).toBe(true);
  });

  it('bypasses quota entirely for admins (no aggregation)', async () => {
    const result = await checkPublishQuota({
      ownerId: 'u1',
      isAdmin: true,
      incoming: { bytes: Number.MAX_SAFE_INTEGER, fileCount: 9999 },
    });
    expect(result.ok).toBe(true);
    expect(aggregateMock).not.toHaveBeenCalled();
  });

  it('does not cap how many pages a user may publish while under the byte ceiling', async () => {
    // 5,000 pages of ~10 KB each is far past the old 100-page cap but ~50 MB.
    aggregateMock.mockResolvedValue(usageWithPages(5000 * 10 * 1024, 5000));
    const result = await checkPublishQuota({
      ownerId: 'u1',
      incoming: { bytes: 10 * 1024, fileCount: 1 },
    });
    expect(result.ok).toBe(true);
  });

  it('does not cap how many pages an org may host while under the byte ceiling', async () => {
    aggregateMock.mockResolvedValue(usageWithPages(5000 * 10 * 1024, 5000));
    const result = await checkPublishQuota({
      ownerId: 'u1',
      orgScopeId: 'org1',
      incoming: { bytes: 10 * 1024, fileCount: 1 },
    });
    expect(aggregateMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('rejects when the incoming bytes would exceed the user byte ceiling', async () => {
    aggregateMock.mockResolvedValue(usage(PUBLISH_QUOTAS.user.maxTotalBytes));
    const result = await checkPublishQuota({
      ownerId: 'u1',
      incoming: { bytes: 1024, fileCount: 1 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(413);
    expect(result.code).toBe('quota_bytes_exceeded');
    expect(result.details.scope).toBe('user');
  });

  it('checks the org ladder when publishing into an org scope', async () => {
    // user ladder fine; org ladder over bytes.
    aggregateMock
      .mockResolvedValueOnce(usage(1024)) // user
      .mockResolvedValueOnce(usage(PUBLISH_QUOTAS.org.maxTotalBytes)); // org
    const result = await checkPublishQuota({
      ownerId: 'u1',
      orgScopeId: 'org1',
      incoming: { bytes: 1024, fileCount: 1 },
    });
    expect(aggregateMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(413);
    expect(result.code).toBe('quota_bytes_exceeded');
    expect(result.details).toEqual({
      scope: 'org',
      limit: PUBLISH_QUOTAS.org.maxTotalBytes,
      current: PUBLISH_QUOTAS.org.maxTotalBytes,
      attempted: PUBLISH_QUOTAS.org.maxTotalBytes + 1024,
    });
  });

  it('allows a publish that lands exactly on the byte ceiling and refuses one byte more', async () => {
    const cap = PUBLISH_QUOTAS.user.maxTotalBytes;
    aggregateMock.mockResolvedValue(usage(cap - 1024));

    const exact = await checkPublishQuota({ ownerId: 'u1', incoming: { bytes: 1024, fileCount: 1 } });
    expect(exact.ok).toBe(true);

    const over = await checkPublishQuota({ ownerId: 'u1', incoming: { bytes: 1025, fileCount: 1 } });
    if (over.ok) throw new Error('expected the byte cap to refuse the publish');
    expect(over.details).toEqual({ scope: 'user', limit: cap, current: cap - 1024, attempted: cap + 1 });
  });

  it('does not check the org ladder for user/project scopes', async () => {
    aggregateMock.mockResolvedValue(usage(1024));
    await checkPublishQuota({ ownerId: 'u1', incoming: { bytes: 1, fileCount: 1 } });
    expect(aggregateMock).toHaveBeenCalledTimes(1);
  });

  it('excludes the overwritten key from the usage aggregation', async () => {
    aggregateMock.mockResolvedValue(usage(1024));
    await checkPublishQuota({
      ownerId: 'u1',
      incoming: { bytes: 1, fileCount: 1 },
      replacing: { tier: 'user', scopeId: 'u1', slug: 'my-page' },
    });
    const pipeline = aggregateMock.mock.calls[0][0] as Array<{ $match?: Record<string, unknown> }>;
    const match = pipeline[0].$match!;
    expect(match.deletedAt).toBeNull();
    expect(match.$nor).toEqual([{ tier: 'user', scopeId: 'u1', slug: 'my-page' }]);
  });

  it('treats an empty aggregation result as zero usage', async () => {
    aggregateMock.mockResolvedValue([]);
    const result = await checkPublishQuota({
      ownerId: 'fresh-user',
      incoming: { bytes: 1024, fileCount: 1 },
    });
    expect(result.ok).toBe(true);
  });
});
