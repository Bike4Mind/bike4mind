import { afterEach, describe, expect, it } from 'vitest';
import { resolveBrowserUploadUrl } from './browserUploadUrl';

describe('resolveBrowserUploadUrl', () => {
  afterEach(() => {
    delete process.env.B4M_SELF_HOST;
  });

  it('returns the same-origin proxy route in self-host (S3/MinIO is not browser-reachable)', () => {
    process.env.B4M_SELF_HOST = 'true';
    expect(resolveBrowserUploadUrl('abc123', 'http://b4m-fab-file.localhost:9000/key.md?sig=x')).toBe(
      '/api/files/abc123/upload'
    );
  });

  it('returns the direct S3 presigned URL when hosted', () => {
    process.env.B4M_SELF_HOST = 'false';
    const presigned = 'https://bucket.s3.us-east-2.amazonaws.com/key.md?sig=x';
    expect(resolveBrowserUploadUrl('abc123', presigned)).toBe(presigned);
  });

  it('treats an unset B4M_SELF_HOST as hosted (returns the presign unchanged)', () => {
    delete process.env.B4M_SELF_HOST;
    const presigned = 'https://bucket.s3.us-east-2.amazonaws.com/key.md?sig=x';
    expect(resolveBrowserUploadUrl('abc123', presigned)).toBe(presigned);
  });
});
