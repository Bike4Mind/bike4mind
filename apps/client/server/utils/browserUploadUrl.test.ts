import { afterEach, describe, expect, it } from 'vitest';
import { resolveBrowserAppFileUploadUrl, resolveBrowserUploadUrl } from './browserUploadUrl';

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

describe('resolveBrowserAppFileUploadUrl', () => {
  afterEach(() => {
    delete process.env.B4M_SELF_HOST;
  });

  it('returns the app-file proxy route in self-host (a different bucket than fab-files)', () => {
    process.env.B4M_SELF_HOST = 'true';
    expect(resolveBrowserAppFileUploadUrl('af1', 'http://b4m-app-files.localhost:9000/logo.png?sig=x')).toBe(
      '/api/app-files/af1/upload'
    );
  });

  it('returns the direct S3 presigned URL when hosted', () => {
    process.env.B4M_SELF_HOST = 'false';
    const presigned = 'https://bucket.s3.us-east-2.amazonaws.com/logo.png?sig=x';
    expect(resolveBrowserAppFileUploadUrl('af1', presigned)).toBe(presigned);
  });

  it('treats an unset B4M_SELF_HOST as hosted (returns the presign unchanged)', () => {
    delete process.env.B4M_SELF_HOST;
    const presigned = 'https://bucket.s3.us-east-2.amazonaws.com/logo.png?sig=x';
    expect(resolveBrowserAppFileUploadUrl('af1', presigned)).toBe(presigned);
  });
});
