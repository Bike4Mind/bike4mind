import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ s3ClientConfigs: [] as unknown[] }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: unknown) => fn }),
}));
vi.mock('sst', () => ({ Resource: { appFilesBucket: { name: 'test-bucket' } } }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    constructor(config: unknown) {
      h.s3ClientConfigs.push(config);
    }
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://s3.test/put') }));
vi.mock('@bike4mind/database/content', () => ({ AppFile: { create: vi.fn() } }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/browserUploadUrl', () => ({
  resolveBrowserAppFileUploadUrl: (_id: string, url: string) => url,
}));

import '../generate-presigned-url';

describe('POST /api/app-files/generate-presigned-url - S3 client config', () => {
  it('sets requestChecksumCalculation to WHEN_REQUIRED (#1535)', () => {
    // Without this, getSignedUrl signs in a checksum of the empty sign-time body, which then
    // mismatches whatever the browser actually PUTs.
    expect(h.s3ClientConfigs[0]).toMatchObject({ requestChecksumCalculation: 'WHEN_REQUIRED' });
  });
});
