import { describe, it, expect } from 'vitest';
import {
  parseShareImageUrl,
  ShareImageUrlSchema,
  SHARE_IMAGE_URL_MAX_LENGTH,
  UploadUrlRequestSchema,
} from './publishedArtifact';

describe('parseShareImageUrl', () => {
  it('accepts an absolute https image URL and drops the fragment', () => {
    expect(parseShareImageUrl('https://cdn.example.com/cards/a.png')).toBe('https://cdn.example.com/cards/a.png');
    expect(parseShareImageUrl('  https://CDN.Example.com/a.png?v=2#top ')).toBe('https://cdn.example.com/a.png?v=2');
  });

  it.each([
    ['empty', ''],
    ['relative path', 'assets/card.png'],
    ['http', 'http://cdn.example.com/a.png'],
    ['data URI', 'data:image/png;base64,AAAA'],
    ['javascript', 'javascript:alert(1)'],
    ['userinfo', 'https://user:pass@cdn.example.com/a.png'],
    ['IPv4 literal', 'https://10.0.0.1/a.png'],
    ['IPv6 literal', 'https://[::1]/a.png'],
    ['bare label', 'https://localhost/a.png'],
    ['numeric TLD', 'https://cdn.example.123/a.png'],
    ['S3 presigned', 'https://bucket.example.com/a.png?X-Amz-Signature=abc&X-Amz-Expires=60'],
    ['GCS presigned', 'https://storage.example.com/a.png?x-goog-signature=abc'],
    ['thumbnail path', 'https://cdn.example.com/publish-thumbnails/pub1/abc.webp'],
    ['thumbnail path, mixed case', 'https://cdn.example.com/Publish-Thumbnails/pub1/abc.webp'],
    ['thumbnail path, percent-encoded', 'https://cdn.example.com/publish%2Dthumbnails/pub1/abc.webp'],
    ['too long', `https://cdn.example.com/${'a'.repeat(SHARE_IMAGE_URL_MAX_LENGTH)}.png`],
  ])('rejects %s', (_label, raw) => {
    expect(parseShareImageUrl(raw)).toBeNull();
  });

  it('allows a path that merely contains the word thumbnails', () => {
    expect(parseShareImageUrl('https://cdn.example.com/thumbnails/a.png')).not.toBeNull();
  });
});

describe('ShareImageUrlSchema', () => {
  it('validates without transforming', () => {
    expect(ShareImageUrlSchema.parse('https://cdn.example.com/a.png#x')).toBe('https://cdn.example.com/a.png#x');
    expect(ShareImageUrlSchema.safeParse('https://cdn.example.com/publish-thumbnails/a.webp').success).toBe(false);
  });

  it('is optional on the publish request', () => {
    const base = {
      tier: 'user',
      scopeId: 'u1',
      slug: 'my-page',
      title: 'T',
      files: [{ path: 'index.html', size: 1, mimeType: 'text/html' }],
    };
    expect(UploadUrlRequestSchema.safeParse(base).success).toBe(true);
    expect(UploadUrlRequestSchema.safeParse({ ...base, shareImageUrl: 'https://cdn.example.com/a.png' }).success).toBe(
      true
    );
    expect(UploadUrlRequestSchema.safeParse({ ...base, shareImageUrl: 'http://cdn.example.com/a.png' }).success).toBe(
      false
    );
  });
});
