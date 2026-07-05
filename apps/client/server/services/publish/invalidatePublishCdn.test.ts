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

import { invalidatePublishCdn, publishCachePaths } from './invalidatePublishCdn';

const DIST_ID = 'E1A2B3C4D5E6F'; // valid CloudFront id format

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue({});
  resolveIdMock.mockReset().mockReturnValue(DIST_ID);
});

describe('publishCachePaths', () => {
  it('maps a reply to its short path', () => {
    expect(
      publishCachePaths({ publicId: 'abc', tier: 'user', scopeId: 'u1', slug: 'r-abc', sourceKind: 'reply' })
    ).toEqual(['/p/r/abc']);
  });

  it('maps a fabfile to its short path', () => {
    expect(
      publishCachePaths({ publicId: 'xyz', tier: 'user', scopeId: 'u1', slug: 'f-xyz', sourceKind: 'fabfile' })
    ).toEqual(['/p/f/xyz']);
  });

  it('maps a bundle to its index + asset glob on BOTH the /p and /uc (isolated) origins', () => {
    expect(
      publishCachePaths({ publicId: 'p1', tier: 'user', scopeId: 'u1', slug: 'my-page', sourceKind: 'bundle' })
    ).toEqual(['/p/u/u1/my-page', '/p/u/u1/my-page/*', '/uc/u/u1/my-page', '/uc/u/u1/my-page/*']);
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
      '/p/u/u1/my-page/*',
      '/uc/u/u1/my-page',
      '/uc/u/u1/my-page/*',
    ]);
    expect(cmd.input.InvalidationBatch.Paths.Quantity).toBe(4);
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
