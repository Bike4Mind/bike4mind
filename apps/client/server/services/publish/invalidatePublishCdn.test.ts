import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock, resolveIdMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  resolveIdMock: vi.fn(),
}));

vi.mock('@aws-sdk/client-cloudfront', () => ({
  CloudFrontClient: class {
    send = sendMock;
  },
  // CreateInvalidationCommand just captures its input so we can assert on it.
  CreateInvalidationCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

// The distribution id comes from the canonical resolver (reads RouterDistributionId.id);
// drive it per-test. Throwing models "not linked" (local/test) -> invalidation no-ops.
vi.mock('@server/security/wafSharedHelpers', () => ({ resolveRouterDistributionId: resolveIdMock }));

import {
  invalidatePublishCdn,
  invalidatePublishCdnMany,
  publishCachePaths,
  MAX_WILDCARDS_PER_BULK_CALL,
} from './invalidatePublishCdn';

const DIST_ID = 'E1A2B3C4D5E6F'; // valid CloudFront id format

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue({});
  resolveIdMock.mockReset().mockReturnValue(DIST_ID);
});

describe('publishCachePaths', () => {
  it('maps a reply to its short path plus its query variants (?format=raw, ?a=)', () => {
    expect(
      publishCachePaths({ publicId: 'abc', tier: 'user', scopeId: 'u1', slug: 'r-abc', sourceKind: 'reply' })
    ).toEqual(['/p/r/abc', '/p/r/abc*']);
  });

  it('maps a fabfile to its short path plus its query variants', () => {
    expect(
      publishCachePaths({ publicId: 'xyz', tier: 'user', scopeId: 'u1', slug: 'f-xyz', sourceKind: 'fabfile' })
    ).toEqual(['/p/f/xyz', '/p/f/xyz*']);
  });

  it('maps a bundle to its index + asset glob on BOTH the /p and /uc (isolated) origins', () => {
    expect(
      publishCachePaths({ publicId: 'p1', tier: 'user', scopeId: 'u1', slug: 'my-page', sourceKind: 'bundle' })
    ).toEqual([
      '/p/u/u1/my-page',
      // Bare wildcard clears query-string variants (?format=raw, ?embed=1, ?v=), which a
      // slash-wildcard cannot reach - it matches further path segments only.
      '/p/u/u1/my-page*',
      '/p/u/u1/my-page/*',
      '/uc/u/u1/my-page',
      '/uc/u/u1/my-page*',
      '/uc/u/u1/my-page/*',
    ]);
  });

  it('uses the org/project url prefixes for bundles', () => {
    expect(
      publishCachePaths({ publicId: 'p2', tier: 'organization', scopeId: 'o1', slug: 's', sourceKind: 'bundle' })[0]
    ).toBe('/p/o/o1/s');
    expect(
      publishCachePaths({ publicId: 'p3', tier: 'project', scopeId: 'pj1', slug: 's', sourceKind: 'bundle' })[0]
    ).toBe('/p/pj/pj1/s');
  });
});

describe('invalidatePublishCdn', () => {
  it('sends a CloudFront invalidation for the artifact paths', async () => {
    await invalidatePublishCdn({ publicId: 'p1', tier: 'user', scopeId: 'u1', slug: 'my-page', sourceKind: 'bundle' });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0][0] as {
      input: { DistributionId: string; InvalidationBatch: { Paths: { Items: string[]; Quantity: number } } };
    };
    expect(cmd.input.DistributionId).toBe(DIST_ID);
    expect(cmd.input.InvalidationBatch.Paths.Items).toEqual([
      '/p/u/u1/my-page',
      '/p/u/u1/my-page*',
      '/p/u/u1/my-page/*',
      '/uc/u/u1/my-page',
      '/uc/u/u1/my-page*',
      '/uc/u/u1/my-page/*',
    ]);
    expect(cmd.input.InvalidationBatch.Paths.Quantity).toBe(6);
  });

  it('skips (no send) when the Router distribution id is not configured', async () => {
    resolveIdMock.mockImplementation(() => {
      throw new Error('Router CloudFront distribution ID not available'); // not linked (local/test)
    });
    await invalidatePublishCdn({ publicId: 'p1', tier: 'user', scopeId: 'u1', slug: 's', sourceKind: 'reply' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('never throws when the invalidation call fails (best-effort)', async () => {
    sendMock.mockRejectedValue(new Error('AccessDenied'));
    await expect(
      invalidatePublishCdn({ publicId: 'p1', tier: 'user', scopeId: 'u1', slug: 'r-p1', sourceKind: 'reply' })
    ).resolves.toBeUndefined();
  });
});

describe('invalidatePublishCdnMany', () => {
  const short = (n: number, kind: 'reply' | 'fabfile') =>
    Array.from({ length: n }, (_, i) => ({
      publicId: `${kind}-${i}`,
      tier: 'user' as const,
      scopeId: 'u1',
      slug: `x-${i}`,
      sourceKind: kind,
    }));
  const sentPaths = () =>
    sendMock.mock.calls.map(
      ([cmd]) =>
        (cmd as { input: { InvalidationBatch: { Paths: { Items: string[] } } } }).input.InvalidationBatch.Paths.Items
    );

  it('sends the exact paths of a few replies and files in one request, and a per-page wildcard for each in one more', async () => {
    await invalidatePublishCdnMany([...short(3, 'reply'), ...short(2, 'fabfile')]);

    expect(sentPaths()).toEqual([
      ['/p/r/reply-0', '/p/r/reply-1', '/p/r/reply-2', '/p/f/fabfile-0', '/p/f/fabfile-1'],
      ['/p/r/reply-0*', '/p/r/reply-1*', '/p/r/reply-2*', '/p/f/fabfile-0*', '/p/f/fabfile-1*'],
    ]);
  });

  it('removing one public reply invalidates only that page, not every reply page', async () => {
    await invalidatePublishCdnMany(short(1, 'reply'));

    const wildcards = sentPaths()
      .flat()
      .filter(p => p.includes('*'));
    expect(wildcards).toEqual(['/p/r/reply-0*']);
  });

  it('uses per-page wildcards right up to the budget', async () => {
    await invalidatePublishCdnMany(short(MAX_WILDCARDS_PER_BULK_CALL, 'reply'));

    const wildcards = sentPaths()
      .flat()
      .filter(p => p.includes('*'));
    expect(wildcards).toHaveLength(MAX_WILDCARDS_PER_BULK_CALL);
    expect(wildcards).not.toContain('/p/r/*');
  });

  it('collapses to one wildcard per kind above the budget', async () => {
    await invalidatePublishCdnMany([...short(MAX_WILDCARDS_PER_BULK_CALL, 'reply'), ...short(1, 'fabfile')]);

    const wildcards = sentPaths()
      .flat()
      .filter(p => p.includes('*'));
    expect(wildcards).toEqual(['/p/r/*', '/p/f/*']);
  });

  it('never sends more than one wildcard per kind for a large takedown', async () => {
    await invalidatePublishCdnMany(short(40, 'reply'));

    const wildcards = sentPaths()
      .flat()
      .filter(p => p.includes('*'));
    expect(wildcards).toEqual(['/p/r/*']);
  });

  it('splits a large takedown into batches of at most 1000 paths', async () => {
    await invalidatePublishCdnMany(short(2500, 'reply'));

    expect(sentPaths().map(p => p.length)).toEqual([1000, 1000, 500, 1]);
    const refs = sendMock.mock.calls.map(
      ([cmd]) =>
        (cmd as { input: { InvalidationBatch: { CallerReference: string } } }).input.InvalidationBatch.CallerReference
    );
    expect(new Set(refs).size).toBe(4);
  });

  it('keeps each bundle in its own request', async () => {
    await invalidatePublishCdnMany([
      { publicId: 'b1', tier: 'user', scopeId: 'u1', slug: 'one', sourceKind: 'bundle' },
      ...short(1, 'reply'),
      { publicId: 'b2', tier: 'user', scopeId: 'u1', slug: 'two', sourceKind: 'bundle' },
    ]);

    // Two bundles send 8 wildcards, over the budget, so the reply's variants collapse to the kind wildcard.
    expect(sentPaths().map(p => p[0])).toEqual(['/p/u/u1/one', '/p/u/u1/two', '/p/r/reply-0', '/p/r/*']);
  });

  it('counts bundle wildcards against the budget so replies collapse to the kind wildcard', async () => {
    await invalidatePublishCdnMany([
      { publicId: 'b1', tier: 'user', scopeId: 'u1', slug: 'one', sourceKind: 'bundle' },
      ...short(2, 'reply'),
    ]);

    const variants = sentPaths().at(-1);
    expect(variants).toEqual(['/p/r/*']);
  });

  it('retries once with the kind wildcards when the per-page request fails', async () => {
    sendMock
      .mockResolvedValueOnce({}) // exact paths
      .mockRejectedValueOnce(new Error('TooManyInvalidationsInProgress')); // per-page wildcards

    await invalidatePublishCdnMany([...short(2, 'reply'), ...short(1, 'fabfile')]);

    expect(sentPaths()).toEqual([
      ['/p/r/reply-0', '/p/r/reply-1', '/p/f/fabfile-0'],
      ['/p/r/reply-0*', '/p/r/reply-1*', '/p/f/fabfile-0*'],
      ['/p/r/*', '/p/f/*'],
    ]);
  });

  it('does not retry when the kind-wildcard request itself fails', async () => {
    sendMock.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Throttling'));

    await invalidatePublishCdnMany(short(40, 'reply'));

    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('sends nothing for an empty list or an unconfigured distribution', async () => {
    await invalidatePublishCdnMany([]);
    resolveIdMock.mockImplementation(() => {
      throw new Error('Router CloudFront distribution ID not available');
    });
    await invalidatePublishCdnMany(short(2, 'reply'));

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('keeps going when one batch fails', async () => {
    sendMock.mockRejectedValueOnce(new Error('Throttling'));

    await expect(invalidatePublishCdnMany(short(1500, 'fabfile'))).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(3);
  });
});
