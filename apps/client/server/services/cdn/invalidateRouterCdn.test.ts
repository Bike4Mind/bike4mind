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
vi.mock('@bike4mind/server-utils/security/wafSharedHelpers', () => ({ resolveRouterDistributionId: resolveIdMock }));

import {
  MAX_IN_PROGRESS_EXACT_PATHS,
  MAX_PATHS_PER_BATCH,
  appFileCdnPath,
  createCdnInvalidationBatch,
  generatedCdnPath,
  invalidateRouterPaths,
} from './invalidateRouterCdn';

const DIST_ID = 'E1A2B3C4D5E6F';
type SentInput = {
  DistributionId: string;
  InvalidationBatch: { CallerReference: string; Paths: { Quantity: number; Items: string[] } };
};
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

  it('splits a set past one batch into sequential exact-path requests', async () => {
    const paths = Array.from({ length: MAX_PATHS_PER_BATCH + 1 }, (_, i) => `/generated/${i}.png`);
    await invalidateRouterPaths(paths, { label: 't' });
    expect(sentPaths()).toEqual([paths.slice(0, MAX_PATHS_PER_BATCH), paths.slice(MAX_PATHS_PER_BATCH)]);
    const batches = sendMock.mock.calls.map(([cmd]) => (cmd as { input: SentInput }).input.InvalidationBatch);
    expect(batches.map(b => b.Paths.Quantity)).toEqual([MAX_PATHS_PER_BATCH, 1]);
    expect(batches.map(b => b.CallerReference.split('-').slice(1, 3).join('-'))).toEqual(['t-1of2', 't-2of2']);
  });

  it('keeps every path exact up to the in-flight quota, deduping across chunk boundaries', async () => {
    const paths = Array.from({ length: MAX_IN_PROGRESS_EXACT_PATHS }, (_, i) => `/generated/${i}.png`);
    await invalidateRouterPaths([...paths, paths[MAX_PATHS_PER_BATCH], paths[0]], { label: 't' });
    const sent = sentPaths();
    expect(sent).toHaveLength(3);
    expect(sent.flat()).toEqual(paths);
    expect(sent.flat().some(p => p.includes('*'))).toBe(false);
  });

  it('coalesces a set past the in-flight quota into one wildcard per prefix, with a warning', async () => {
    const paths = [
      ...Array.from({ length: MAX_IN_PROGRESS_EXACT_PATHS }, (_, i) => `/generated/${i}.png`),
      '/org-files/a/b.png',
    ];
    const log = logger();
    await invalidateRouterPaths(paths, { label: 't', logger: log });
    expect(sentPaths()).toEqual([['/generated/*', '/org-files/*']]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(`${MAX_IN_PROGRESS_EXACT_PATHS + 1} paths`));
  });

  it('still sends later chunks when one request fails', async () => {
    sendMock.mockRejectedValueOnce(new Error('throttled'));
    const paths = Array.from({ length: MAX_PATHS_PER_BATCH * 2 + 5 }, (_, i) => `/generated/${i}.png`);
    const log = logger();
    await expect(invalidateRouterPaths(paths, { label: 't', logger: log })).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('throttled'));
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining(`${MAX_PATHS_PER_BATCH} paths`));
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
