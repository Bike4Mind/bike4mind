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
function usage(totalBytes: number, count: number) {
  return [{ _id: null, totalBytes, count }];
}

describe('checkPublishQuota', () => {
  beforeEach(() => {
    aggregateMock.mockReset();
  });

  it('allows a publish that fits under both ladders', async () => {
    aggregateMock.mockResolvedValue(usage(10 * 1024 * 1024, 5));
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

  it('rejects when the user artifact-count ceiling is reached', async () => {
    aggregateMock.mockResolvedValue(usage(1024, PUBLISH_QUOTAS.user.maxArtifacts));
    const result = await checkPublishQuota({
      ownerId: 'u1',
      incoming: { bytes: 1, fileCount: 1 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(413);
    expect(result.code).toBe('quota_artifacts_exceeded');
    expect(result.details.scope).toBe('user');
  });

  it('rejects when the incoming bytes would exceed the user byte ceiling', async () => {
    aggregateMock.mockResolvedValue(usage(PUBLISH_QUOTAS.user.maxTotalBytes, 1));
    const result = await checkPublishQuota({
      ownerId: 'u1',
      incoming: { bytes: 1024, fileCount: 1 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('quota_bytes_exceeded');
  });

  it('checks the org ladder when publishing into an org scope', async () => {
    // user ladder fine; org ladder over count.
    aggregateMock
      .mockResolvedValueOnce(usage(1024, 1)) // user
      .mockResolvedValueOnce(usage(1024, PUBLISH_QUOTAS.org.maxArtifacts)); // org
    const result = await checkPublishQuota({
      ownerId: 'u1',
      orgScopeId: 'org1',
      incoming: { bytes: 1, fileCount: 1 },
    });
    expect(aggregateMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.details.scope).toBe('org');
  });

  it('does not check the org ladder for user/project scopes', async () => {
    aggregateMock.mockResolvedValue(usage(1024, 1));
    await checkPublishQuota({ ownerId: 'u1', incoming: { bytes: 1, fileCount: 1 } });
    expect(aggregateMock).toHaveBeenCalledTimes(1);
  });

  it('excludes the overwritten key from the usage aggregation', async () => {
    aggregateMock.mockResolvedValue(usage(1024, 1));
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
