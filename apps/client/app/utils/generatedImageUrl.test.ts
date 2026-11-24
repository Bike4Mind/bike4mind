import { describe, it, expect, vi } from 'vitest';
import { extractS3KeyFromUrl, isGeneratedImage } from './generatedImageUrl';

describe('extractS3KeyFromUrl / isGeneratedImage', () => {
  const KEY = '9db8f846-08d5-47d7-9166-a039d3c3d4d7.png';
  const SIGNATURE = 'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=abc123';

  it.each([
    [
      'virtual-hosted presigned',
      `https://prod-x-generatedimagesbucket-abc.s3.us-east-1.amazonaws.com/${KEY}?${SIGNATURE}`,
    ],
    ['path-style presigned', `https://s3.us-east-1.amazonaws.com/prod-x-generatedimagesbucket-abc/${KEY}?${SIGNATURE}`],
  ])('yields the bare key from a %s url', (_label, url) => {
    expect(extractS3KeyFromUrl(url)).toBe(KEY);
    expect(isGeneratedImage(url)).toBe(true);
  });

  it('decodes a percent-encoded key', () => {
    const url = `https://prod-x-generatedimagesbucket-abc.s3.us-east-1.amazonaws.com/report%201%2B2.xlsx?${SIGNATURE}`;
    expect(extractS3KeyFromUrl(url)).toBe('report 1+2.xlsx');
  });

  it('returns null for a non-S3 url and for an unparseable one', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(extractS3KeyFromUrl('https://example.com/image.png')).toBeNull();
    expect(extractS3KeyFromUrl('not a url')).toBeNull();
    consoleError.mockRestore();
    expect(isGeneratedImage('https://example.com/image.png')).toBe(false);
  });
});
