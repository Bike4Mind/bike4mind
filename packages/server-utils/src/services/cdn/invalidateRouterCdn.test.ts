import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock, resolveIdMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  resolveIdMock: vi.fn(),
}));

vi.mock('@aws-sdk/client-cloudfront', () => ({
  CloudFrontClient: class {
    send = sendMock;
  },
  CreateInvalidationCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));
vi.mock('../../security/wafSharedHelpers', () => ({ resolveRouterDistributionId: resolveIdMock }));

import {
  MAX_PATHS_PER_BATCH,
  appFileCdnPath,
  createCdnInvalidationBatch,
  generatedCdnPath,
  invalidateRouterPaths,
} from './invalidateRouterCdn';

const DIST_ID = 'E1A2B3C4D5E6F';
type SentInput = { DistributionId: string; InvalidationBatch: { CallerReference: string; Paths: { Items: string[] } } };
const sentPaths = () =>
  sendMock.mock.calls.map(([cmd]) => (cmd as { input: SentInput }).input.InvalidationBatch.Paths.Items);
const logger = () => ({ info: vi.fn(), warn: vi.fn() });

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue({});
  resolveIdMock.mockReset().mockReturnValue(DIST_ID);
});

describe('invalidateRouterPaths', () => {
  it('gives same-label requests in the same millisecond distinct CallerReferences', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    await invalidateRouterPaths(['/generated/a.png'], { label: 'same' });
    await invalidateRouterPaths(['/generated/b.png'], { label: 'same' });
    vi.restoreAllMocks();
    const refs = sendMock.mock.calls.map(
      ([cmd]) => (cmd as { input: SentInput }).input.InvalidationBatch.CallerReference
    );
    expect(refs).toHaveLength(2);
    expect(new Set(refs).size).toBe(2);
  });

  it('dedupes and drops wildcards and non-absolute paths', async () => {
    await invalidateRouterPaths(['/generated/a.png', '/generated/a.png', '/generated/*', 'generated/b.png'], {
      label: 't',
    });
    expect(sentPaths()).toEqual([['/generated/a.png']]);
    expect((sendMock.mock.calls[0][0] as { input: SentInput }).input.DistributionId).toBe(DIST_ID);
  });

  it('sends up to MAX_PATHS_PER_BATCH exact paths in a single request', async () => {
    const paths = Array.from({ length: MAX_PATHS_PER_BATCH }, (_, i) => `/generated/${i}.png`);
    await invalidateRouterPaths(paths, { label: 't' });
    expect(sentPaths()).toEqual([paths]);
  });

  it('coalesces a larger set into one wildcard per top-level prefix', async () => {
    const paths = [
      ...Array.from({ length: MAX_PATHS_PER_BATCH }, (_, i) => `/generated/${i}.png`),
      '/org-files/a/b.png',
    ];
    await invalidateRouterPaths(paths, { label: 't' });
    expect(sentPaths()).toEqual([['/generated/*', '/org-files/*']]);
  });

  it('makes no call for an empty list', async () => {
    await invalidateRouterPaths([], { label: 't' });
    expect(sendMock).not.toHaveBeenCalled();
    expect(resolveIdMock).not.toHaveBeenCalled();
  });

  it('no-ops with a warning when the distribution is not linked', async () => {
    resolveIdMock.mockImplementation(() => {
      throw new Error('not linked');
    });
    const log = logger();
    await invalidateRouterPaths(['/generated/a.png'], { label: 't', logger: log });
    expect(sendMock).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not linked'));
  });

  it('swallows and warns on a CloudFront failure', async () => {
    sendMock.mockRejectedValue(new Error('throttled'));
    const log = logger();
    await expect(invalidateRouterPaths(['/generated/a.png'], { label: 't', logger: log })).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('throttled'));
  });
});

describe('createCdnInvalidationBatch', () => {
  it('collects paths and sends one request on flush, ignoring null', async () => {
    const batch = createCdnInvalidationBatch('bulk');
    batch.add('/generated/a.png');
    batch.add(null);
    batch.add('/generated/b.png');
    expect(sendMock).not.toHaveBeenCalled();
    await batch.flush();
    expect(sentPaths()).toEqual([['/generated/a.png', '/generated/b.png']]);
    await batch.flush();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe('CDN path mapping', () => {
  it('maps generated keys under /generated/', () => {
    expect(generatedCdnPath('abc.png')).toBe('/generated/abc.png');
    expect(generatedCdnPath('a b.png')).toBe('/generated/a%20b.png');
  });

  it('maps routed app-file keys and rejects unrouted ones', () => {
    expect(appFileCdnPath('organizations/o1/logo.png')).toBe('/org-files/o1/logo.png');
    expect(appFileCdnPath('admin/logos/site.png')).toBe('/admin-logos/site.png');
    expect(appFileCdnPath('profile-photos/u1/p.jpg')).toBe('/profile-photos/u1/p.jpg');
    expect(appFileCdnPath('6f1c2b0e-9d7a-4c1e-8f00-1234567890ab')).toBeNull();
    expect(appFileCdnPath('generated/x.png')).toBeNull();
  });
});
