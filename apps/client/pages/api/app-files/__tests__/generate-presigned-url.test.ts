import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({
  s3ClientConfigs: [] as unknown[],
  putObjectInputs: [] as { ContentType?: string }[],
}));

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
    constructor(public input: { ContentType?: string }) {
      h.putObjectInputs.push(input);
    }
  },
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://s3.test/put') }));
vi.mock('@bike4mind/database/content', () => ({ AppFile: { create: vi.fn(async () => ({ id: 'file-1' })) } }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/browserUploadUrl', () => ({
  resolveBrowserAppFileUploadUrl: (_id: string, url: string) => url,
}));

import handler from '../generate-presigned-url';

const invoke = (body: unknown) => {
  const json = vi.fn();
  return (handler as (req: unknown, res: unknown) => Promise<void>)(
    { user: { id: 'u1' }, ability: {}, body },
    { json }
  );
};

describe('POST /api/app-files/generate-presigned-url - S3 client config', () => {
  it('sets requestChecksumCalculation to WHEN_REQUIRED (#1535)', () => {
    // Without this, getSignedUrl signs in a checksum of the empty sign-time body, which then
    // mismatches whatever the browser actually PUTs.
    expect(h.s3ClientConfigs[0]).toMatchObject({ requestChecksumCalculation: 'WHEN_REQUIRED' });
  });
});

describe('POST /api/app-files/generate-presigned-url - ContentType binding', () => {
  // appFilesBucket IS served on the app origin, so the presign must pin ContentType into the
  // signature: otherwise a client declares (and passes the executable gate as) image/png but PUTs
  // text/html, which then serves back as active content from the app origin (stored XSS).
  it('binds the declared mimeType into the PutObjectCommand ContentType', async () => {
    h.putObjectInputs.length = 0;
    await invoke({ fileName: 'logo.png', mimeType: 'image/png', fileSize: 10 });
    expect(h.putObjectInputs.at(-1)?.ContentType).toBe('image/png');
  });
});
