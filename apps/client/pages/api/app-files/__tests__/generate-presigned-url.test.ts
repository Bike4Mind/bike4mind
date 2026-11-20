import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({
  s3ClientConfigs: [] as unknown[],
  putObjectInputs: [] as { Key?: string; ContentType?: string; ContentLength?: number }[],
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
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/browserUploadUrl', () => ({
  resolveBrowserAppFileUploadUrl: (_id: string, url: string) => url,
}));

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import handler from '../generate-presigned-url';

const invoke = async (body: unknown) => {
  const json = vi.fn();
  await (handler as (req: unknown, res: unknown) => Promise<void>)({ user: { id: 'u1' }, ability: {}, body }, { json });
  return json.mock.calls[0]?.[0] as { fileKey: string };
};

describe('POST /api/app-files/generate-presigned-url - S3 client config', () => {
  it('sets requestChecksumCalculation to WHEN_REQUIRED (#1535)', () => {
    // Without this, getSignedUrl signs in a checksum of the empty sign-time body, which then
    // mismatches whatever the browser actually PUTs.
    expect(h.s3ClientConfigs[0]).toMatchObject({ requestChecksumCalculation: 'WHEN_REQUIRED' });
  });
});

describe('POST /api/app-files/generate-presigned-url - key derivation', () => {
  it('builds the upload key server-side and ignores a client path', async () => {
    h.putObjectInputs.length = 0;
    const res = await invoke({
      fileName: 'logo.png',
      mimeType: 'image/png',
      fileSize: 10,
      path: 'public/../assets',
    });
    const key = h.putObjectInputs.at(-1)?.Key;
    expect(key).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(key).not.toContain('public');
    expect(key).not.toContain('..');
    expect(key).not.toContain('/');
    expect(res.fileKey).toBe(key);
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

  it('binds the declared fileSize into the signature, so S3 refuses a PUT of any other length', async () => {
    h.putObjectInputs.length = 0;
    await invoke({ fileName: 'logo.png', mimeType: 'image/png', fileSize: 10 });
    expect(h.putObjectInputs.at(-1)?.ContentLength).toBe(10);
    const options = vi.mocked(getSignedUrl).mock.calls.at(-1)?.[2];
    expect(options?.signableHeaders?.has('content-length')).toBe(true);
  });
});
